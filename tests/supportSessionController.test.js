/**
 * Unit tests for the support-session operator API — the impersonation kill
 * switch. No DB, no network: in-memory fakes for the models are injected into
 * the require cache BEFORE the controller loads, so the real controller code
 * runs against them. Node's built-in runner.
 *
 * These cover the state handling specifically, because that is where being
 * wrong is dangerous: a session listed as "active" that isn't (or the reverse),
 * two operators both told their revoke succeeded, or a lapsed session still
 * offering a Revoke button.
 */
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

/* ── fakes ───────────────────────────────────────────────────────────────── */

// Chainable query stub: every builder method returns itself, and the terminal
// (`lean`) resolves the scripted result.
function query(result) {
  const q = {};
  for (const m of ["populate", "sort", "skip", "limit", "select"]) q[m] = () => q;
  q.lean = async () => result;
  q.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return q;
}

const calls = [];
const script = {
  find: [],
  findOne: [],
  findOneAndUpdate: [],
  aggregate: [],
  countDocuments: [],
  updateMany: [],
};
const next = (name, fallback) => (script[name].length ? script[name].shift() : fallback);

const FakeSupportSession = {
  schema: { path: () => ({ enumValues: ["active", "ended", "revoked", "expired"] }) },
  find(filter) {
    calls.push(["find", filter]);
    return query(next("find", []));
  },
  findOne(filter) {
    calls.push(["findOne", filter]);
    return query(next("findOne", null));
  },
  findOneAndUpdate(filter, update, opts) {
    calls.push(["findOneAndUpdate", filter, update, opts]);
    return query(next("findOneAndUpdate", null));
  },
  async aggregate(pipeline) {
    calls.push(["aggregate", pipeline]);
    return next("aggregate", [{}]);
  },
  async countDocuments(filter) {
    calls.push(["countDocuments", filter]);
    return next("countDocuments", 0);
  },
  async updateMany(filter, update) {
    calls.push(["updateMany", filter, update]);
    return next("updateMany", { modifiedCount: 0 });
  },
};

const FakePlatformAuditLog = {
  async countDocuments() {
    return 0;
  },
  find() {
    return query([]);
  },
  async create() {
    return {};
  },
};
const FakeOrganisation = { find: () => query([]) };

const audits = [];
const emits = [];

function inject(spec, exportsObj) {
  const resolved = require.resolve(path.join(ROOT, spec));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
inject("models/supportSession", FakeSupportSession);
inject("models/platformAuditLog", FakePlatformAuditLog);
inject("models/organisation", FakeOrganisation);
inject("utils/writeAudit", async (req, action, extra) => {
  audits.push({ action, ...extra });
});
inject("services/socket", {
  emitToSuperAdmins: (event, payload) => emits.push([event, payload]),
  emitToOrg: () => {},
  emitToUser: () => {},
  getIO: () => null,
  initSocket: () => null,
});

const controller = require(path.join(ROOT, "controllers/supportSessionController.js"));

/* ── request / response fakes ────────────────────────────────────────────── */
const makeReq = (over = {}) => ({ query: {}, params: {}, body: {}, headers: {}, user: { _id: "op1", email: "op@x.io" }, ...over });
function makeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (o) => ((res.body = o), res);
  return res;
}

beforeEach(() => {
  calls.length = 0;
  audits.length = 0;
  emits.length = 0;
  for (const k of Object.keys(script)) script[k].length = 0;
});

/* ── the expiry sweep ────────────────────────────────────────────────────── */

test("listSessions retires lapsed sessions BEFORE it counts anything", async () => {
  script.updateMany.push({ modifiedCount: 2 });
  script.aggregate.push([{ total: [{ n: 7 }], active: [{ n: 1 }], operators: [{ n: 3 }], tenants: [{ n: 2 }] }]);
  script.countDocuments.push(1);

  const res = makeRes();
  await controller.listSessions(makeReq(), res);

  const names = calls.map((c) => c[0]);
  assert.equal(names[0], "updateMany", "the sweep must run first — counting stale rows is the bug");
  assert.ok(names.indexOf("aggregate") > 0);

  const [, sweepFilter, sweepUpdate] = calls[0];
  assert.equal(sweepFilter.status, "active");
  assert.ok(sweepFilter.expiresAt.$lte instanceof Date, "only rows already past their expiry");
  // Pipeline form, so each row ends at its own expiry rather than "now".
  assert.deepEqual(sweepUpdate, [{ $set: { status: "expired", endedAt: "$expiresAt" } }]);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, 7);
  assert.equal(res.body.summary.activeNow, 1);
  assert.ok(res.body.serverTime instanceof Date, "the screen anchors its countdowns to server time");
});

test("a sweep that closed rows tells every open console", async () => {
  script.updateMany.push({ modifiedCount: 3 });
  script.aggregate.push([{}]);
  await controller.listSessions(makeReq(), makeRes());
  assert.deepEqual(emits, [["supportSession:updated", { reason: "expired", count: 3 }]]);
});

test("a sweep that changed nothing stays silent", async () => {
  script.updateMany.push({ modifiedCount: 0 });
  script.aggregate.push([{}]);
  await controller.listSessions(makeReq(), makeRes());
  assert.deepEqual(emits, []);
});

test("a failing sweep does not take the list down with it", async () => {
  const boom = FakeSupportSession.updateMany;
  FakeSupportSession.updateMany = async () => {
    throw new Error("mongo is having a day");
  };
  script.aggregate.push([{ total: [{ n: 4 }] }]);
  const res = makeRes();
  await controller.listSessions(makeReq(), res);
  FakeSupportSession.updateMany = boom;
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, 4);
});

test("`liveNow` ignores the filters — no filter may hide a live session", async () => {
  script.updateMany.push({ modifiedCount: 0 });
  script.aggregate.push([{ total: [{ n: 1 }], active: [{ n: 0 }] }]);
  script.countDocuments.push(5);

  const res = makeRes();
  await controller.listSessions(makeReq({ query: { status: "ended" } }), res);

  const counted = calls.find((c) => c[0] === "countDocuments");
  assert.deepEqual(counted[1], { status: "active" }, "unfiltered on purpose");
  assert.equal(res.body.summary.liveNow, 5);
  assert.equal(res.body.summary.activeNow, 0, "the filtered figure is separate and stays filtered");
});

test("an unknown status is a 400, not a silently empty list", async () => {
  const res = makeRes();
  await controller.listSessions(makeReq({ query: { status: "nonsense" } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Status/);
});

/* ── revoke ──────────────────────────────────────────────────────────────── */

test("revoke claims the row atomically, so a second operator can't overwrite the first", async () => {
  script.findOneAndUpdate.push({ sessionId: "s1", organisationId: "o1", targetEmail: "a@b.c", status: "revoked" });
  const res = makeRes();
  await controller.revokeSession(makeReq({ params: { sessionId: "s1" } }), res);

  const [, filter, update] = calls.find((c) => c[0] === "findOneAndUpdate");
  assert.deepEqual(filter, { sessionId: "s1", status: "active" }, "only a still-active row may be claimed");
  assert.equal(update.$set.status, "revoked");
  assert.equal(update.$set.endedBy, "op1");
  assert.equal(res.statusCode, 200);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "support.session_revoked");
  assert.deepEqual(emits, [["supportSession:updated", { reason: "revoked", sessionId: "s1" }]]);
});

test("revoking an already-ended session is a 409 that names the real status", async () => {
  script.findOneAndUpdate.push(null);
  script.findOne.push({ status: "ended" });
  const res = makeRes();
  await controller.revokeSession(makeReq({ params: { sessionId: "s1" } }), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.status, "ended", "the screen shows this instead of asking for a retry");
  assert.equal(audits.length, 0, "nothing was killed, so nothing is audited");
  assert.deepEqual(emits, []);
});

test("revoking an unknown session is a 404", async () => {
  script.findOneAndUpdate.push(null);
  script.findOne.push(null);
  const res = makeRes();
  await controller.revokeSession(makeReq({ params: { sessionId: "nope" } }), res);
  assert.equal(res.statusCode, 404);
});

/* ── revoke all ──────────────────────────────────────────────────────────── */

test("revoke-all kills every live session and audits each one", async () => {
  script.updateMany.push({ modifiedCount: 0 }); // the sweep
  script.find.push([
    { sessionId: "s1", organisationId: "o1", targetEmail: "a@b.c" },
    { sessionId: "s2", organisationId: "o2", targetEmail: "d@e.f" },
  ]);
  script.updateMany.push({ modifiedCount: 2 }); // the revoke

  const res = makeRes();
  await controller.revokeAllSessions(makeReq(), res);

  const [, filter] = calls.filter((c) => c[0] === "updateMany")[1];
  assert.deepEqual(filter.sessionId, { $in: ["s1", "s2"] });
  assert.equal(filter.status, "active", "re-asserted, so a session someone else just killed is left alone");

  assert.equal(res.body.revoked, 2);
  assert.deepEqual(res.body.sessions, ["s1", "s2"]);
  // One entry per session (so each session's own timeline explains itself)
  // plus one describing the sweep.
  assert.equal(audits.filter((a) => a.action === "support.session_revoked").length, 2);
  assert.equal(audits.filter((a) => a.action === "support.sessions_revoked_all").length, 1);
  assert.deepEqual(emits.at(-1), ["supportSession:updated", { reason: "revoked_all", count: 2 }]);
});

test("revoke-all with nothing live is a no-op, not an empty write", async () => {
  script.updateMany.push({ modifiedCount: 0 });
  script.find.push([]);
  const res = makeRes();
  await controller.revokeAllSessions(makeReq(), res);

  assert.deepEqual(res.body, { revoked: 0, sessions: [] });
  assert.equal(calls.filter((c) => c[0] === "updateMany").length, 1, "only the sweep ran");
  assert.equal(audits.length, 0);
});

test("revoke-all rejects a malformed organisation scope rather than killing everything", async () => {
  script.updateMany.push({ modifiedCount: 0 });
  const res = makeRes();
  await controller.revokeAllSessions(makeReq({ body: { organisationId: "not-an-id" } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.filter((c) => c[0] === "find").length, 0);
});

/* ── detail ──────────────────────────────────────────────────────────────── */

test("getSession reports whole-trail counts even when the timeline is truncated", async () => {
  script.updateMany.push({ modifiedCount: 0 });
  script.findOne.push({ sessionId: "s1", status: "ended" });
  const rows = Array.from({ length: 3 }, (_, i) => ({ _id: i, createdAt: new Date(2026, 0, i + 1) }));
  FakePlatformAuditLog.countDocuments = async (q) => (q.action === "support.action" ? 40 : 120);
  FakePlatformAuditLog.find = () => query(rows.slice().reverse());

  const res = makeRes();
  await controller.getSession(makeReq({ params: { sessionId: "s1" } }), res);

  assert.equal(res.body.actionTotal, 120);
  assert.equal(res.body.writeTotal, 40, "the sidebar figure must not shrink with the page");
  assert.equal(res.body.truncated, true);
  // Fetched newest-first for the cap, then flipped back for the timeline.
  assert.deepEqual(res.body.actions.map((a) => a._id), [0, 1, 2]);
});

test("getSession 404s for an id that never existed", async () => {
  script.updateMany.push({ modifiedCount: 0 });
  script.findOne.push(null);
  const res = makeRes();
  await controller.getSession(makeReq({ params: { sessionId: "ghost" } }), res);
  assert.equal(res.statusCode, 404);
});
