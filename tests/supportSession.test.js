/**
 * Unit tests for the support-impersonation guard + audit middleware and its
 * helpers. No DB, no network: we inject in-memory fakes for SupportSession +
 * PlatformAuditLog into the require cache BEFORE loading the middleware, so the
 * real middleware code runs against our fakes. Node's built-in runner.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const jwt = require("jsonwebtoken");

const ROOT = path.resolve(__dirname, "..");
process.env.JWT_SECRET = process.env.JWT_SECRET || "unit_test_secret";

/* ── in-memory fakes ─────────────────────────────────────────────────────── */
const _sessions = new Map(); // sessionId -> doc
let _findOneCalls = 0;
let _incCalls = 0;
const FakeSupportSession = {
  findOne: async (q) => {
    _findOneCalls++;
    return _sessions.get(q.sessionId) || null;
  },
  updateOne: async () => {
    _incCalls++;
    return { acknowledged: true };
  },
};
const _audit = [];
const FakePlatformAuditLog = { create: async (row) => (_audit.push(row), row) };

function inject(spec, exportsObj) {
  const resolved = require.resolve(path.join(ROOT, spec));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
inject("models/supportSession", FakeSupportSession);
inject("models/platformAuditLog", FakePlatformAuditLog);

const middleware = require(path.join(ROOT, "middleware/supportSession.js"));
const { actionLabel, sanitizeBody } = middleware;

/* ── request / response fakes ────────────────────────────────────────────── */
function makeReq({ token, method = "GET", url = "/api/programs", body = {}, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  return {
    method,
    originalUrl: url,
    body,
    headers: h,
    ip: "1.2.3.4",
    header(name) {
      return h[name.toLowerCase()];
    },
  };
}
function makeRes() {
  const res = { statusCode: 200, body: undefined, ended: false, _finish: [] };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (o) => ((res.body = o), (res.ended = true), res);
  res.on = (ev, cb) => (ev === "finish" && res._finish.push(cb), res);
  res.emitFinish = (code) => {
    if (code) res.statusCode = code;
    res._finish.forEach((cb) => cb());
  };
  return res;
}
function run(req) {
  const res = makeRes();
  let nexted = false;
  return middleware(req, res, () => { nexted = true; }).then(() => ({ res, nexted }));
}

function seedSession(over = {}) {
  const sessionId = over.sessionId || "sess_" + (_sessions.size + 1);
  const doc = {
    _id: "ss_" + sessionId,
    sessionId,
    status: "active",
    expiresAt: new Date(Date.now() + 3600 * 1000),
    access: "full",
    mode: "admin",
    organisationId: "org_calcite",
    impersonatorId: "op_1",
    impersonatorEmail: "operator@platform.test",
    targetEmail: "admin@calcite.test",
    ticketId: null,
    ...over,
    async save() { _sessions.set(this.sessionId, this); return this; },
  };
  _sessions.set(sessionId, doc);
  return doc;
}
const tokenFor = (sessionId, extra = {}) =>
  jwt.sign({ support_session: true, sessionId, ...extra }, process.env.JWT_SECRET);

/* ════════════════════════════ actionLabel ════════════════════════════════ */
test("actionLabel: create / update / delete verbs", () => {
  assert.equal(actionLabel("POST", "/api/programs"), "Created program");
  assert.equal(actionLabel("DELETE", "/api/admin/donors/64a000000000000000000001"), "Deleted donor");
  assert.equal(actionLabel("PATCH", "/api/support-tickets/abc?x=1"), "Updated support ticket");
  assert.equal(actionLabel("POST", "/api/events"), "Created event");
});
test("actionLabel: sub-action segment after an id", () => {
  assert.equal(actionLabel("POST", "/api/programs/64a000000000000000000001/donate"), "donate · program");
});
test("actionLabel: unknown resource falls back to de-pluralised segment", () => {
  assert.equal(actionLabel("POST", "/api/widgets"), "Created widget");
});

/* ════════════════════════════ sanitizeBody ═══════════════════════════════ */
test("sanitizeBody: redacts secrets, keeps normal fields", () => {
  const out = sanitizeBody({ name: "Water Fund", password: "hunter2", token: "abc", cardNumber: "4242", cvv: "123" });
  assert.equal(out.name, "Water Fund");
  assert.equal(out.password, "[redacted]");
  assert.equal(out.token, "[redacted]");
  assert.equal(out.cardNumber, "[redacted]");
  assert.equal(out.cvv, "[redacted]");
});
test("sanitizeBody: truncates long strings + caps arrays + drops __ keys", () => {
  const out = sanitizeBody({ blob: "x".repeat(900), list: Array.from({ length: 80 }, (_, i) => i), __proto_ish: "no" });
  assert.equal(out.blob.length, 501); // 500 + ellipsis
  assert.ok(out.blob.endsWith("…"));
  assert.equal(out.list.length, 50);
  assert.equal("__proto_ish" in out, false);
});
test("sanitizeBody: depth cap returns sentinel", () => {
  const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
  const out = sanitizeBody(deep);
  assert.equal(out.a.b.c.d.e, "[…]");
});

/* ════════════════════════════ middleware ═════════════════════════════════ */
test("no token → passthrough, no DB hit", async () => {
  _findOneCalls = 0;
  const { res, nexted } = await run(makeReq({}));
  assert.equal(nexted, true);
  assert.equal(res.ended, false);
  assert.equal(_findOneCalls, 0);
});

test("non-support token → passthrough, no DB hit", async () => {
  _findOneCalls = 0;
  const token = jwt.sign({ id: "u1" }, process.env.JWT_SECRET); // no support_session
  const { res, nexted } = await run(makeReq({ token }));
  assert.equal(nexted, true);
  assert.equal(res.ended, false);
  assert.equal(_findOneCalls, 0);
});

test("support token but no session row → 401", async () => {
  const token = tokenFor("ghost");
  const { res, nexted } = await run(makeReq({ token }));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /ended/i);
});

test("ended session → 401 (kill switch)", async () => {
  const s = seedSession({ status: "ended" });
  const { res, nexted } = await run(makeReq({ token: tokenFor(s.sessionId) }));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
});

test("revoked session → 401 (kill switch)", async () => {
  const s = seedSession({ status: "revoked" });
  const { res } = await run(makeReq({ token: tokenFor(s.sessionId) }));
  assert.equal(res.statusCode, 401);
});

test("expired-by-time session → 401 and flips to expired", async () => {
  const s = seedSession({ expiresAt: new Date(Date.now() - 1000) });
  const { res } = await run(makeReq({ token: tokenFor(s.sessionId) }));
  assert.equal(res.statusCode, 401);
  assert.equal(_sessions.get(s.sessionId).status, "expired");
});

test("view-only blocks a write with VIEW_ONLY code, no audit", async () => {
  const before = _audit.length;
  const s = seedSession({ access: "view_only" });
  const { res, nexted } = await run(makeReq({ token: tokenFor(s.sessionId), method: "POST", body: { a: 1 } }));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "VIEW_ONLY");
  assert.equal(_audit.length, before); // nothing recorded
});

test("view-only allows a read (GET) → passthrough", async () => {
  const s = seedSession({ access: "view_only" });
  const { res, nexted } = await run(makeReq({ token: tokenFor(s.sessionId), method: "GET" }));
  assert.equal(nexted, true);
  assert.equal(res.ended, false);
});

test("full access: successful write is audited + actionCount incremented", async () => {
  const before = _audit.length;
  const incBefore = _incCalls;
  const s = seedSession({ access: "full" });
  const req = makeReq({ token: tokenFor(s.sessionId), method: "POST", url: "/api/programs", body: { name: "X", password: "p" } });
  const { res, nexted } = await run(req);
  assert.equal(nexted, true); // request proceeds
  assert.deepEqual(req.support.sessionId, s.sessionId);
  res.emitFinish(201); // simulate the response completing successfully
  await new Promise((r) => setImmediate(r)); // let the fire-and-forget create resolve
  assert.equal(_audit.length, before + 1);
  const row = _audit[_audit.length - 1];
  assert.equal(row.action, "support.action");
  assert.equal(row.meta.label, "Created program");
  assert.equal(row.meta.method, "POST");
  assert.equal(row.meta.status, 201);
  assert.equal(row.meta.changes.password, "[redacted]");
  assert.equal(row.meta.changes.name, "X");
  assert.equal(_incCalls, incBefore + 1);
});

test("full access: a FAILED write (>=400) is NOT audited", async () => {
  const before = _audit.length;
  const s = seedSession({ access: "full" });
  const { res } = await run(makeReq({ token: tokenFor(s.sessionId), method: "DELETE", url: "/api/programs/1" }));
  res.emitFinish(500);
  await new Promise((r) => setImmediate(r));
  assert.equal(_audit.length, before); // failures don't pollute the trail
});
