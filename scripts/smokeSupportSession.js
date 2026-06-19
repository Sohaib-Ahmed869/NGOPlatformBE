/**
 * LIVE smoke test for the support-impersonation feature, scoped to the "calcite"
 * tenant. Connects to the real DB and exercises the REAL models + middleware +
 * controllers across every scenario.
 *
 * SAFETY: this only ever writes to our own SupportSession / PlatformAuditLog
 * collections (the audit infra), and deletes everything it created at the end.
 * It performs NO mutations to calcite's real business data — "writes" are
 * simulated by driving the middleware's res.on('finish') hook with a fake
 * response, not by hitting real business endpoints.
 *
 *   node scripts/smokeSupportSession.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const Organisation = require("../models/organisation");
const User = require("../models/user");
const SupportSession = require("../models/supportSession");
const PlatformAuditLog = require("../models/platformAuditLog");
const superAdminController = require("../controllers/superAdminController");
const supportSessionController = require("../controllers/supportSessionController");
const middleware = require("../middleware/supportSession");

const SLUG = "calcite";
const createdSessionIds = [];
const results = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, pass, detail = "") {
  results.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? "✅ PASS" : "❌ FAIL"}  ${name}${detail ? `  —  ${detail}` : ""}`);
}

/* ── fake req/res ─────────────────────────────────────────────────────────── */
function makeReq({ user, params = {}, body = {}, query = {}, token, method = "GET", url = "/api/programs" } = {}) {
  const headers = { "x-forwarded-for": "203.0.113.9", "user-agent": "smoke-test" };
  if (token) headers.authorization = `Bearer ${token}`;
  return {
    user, params, body, query, method, originalUrl: url, headers, ip: "203.0.113.9",
    header: (n) => headers[String(n).toLowerCase()],
  };
}
function makeRes() {
  const res = { statusCode: 200, body: undefined, ended: false, _finish: [] };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (o) => ((res.body = o), (res.ended = true), res);
  res.send = (o) => ((res.body = o), (res.ended = true), res);
  res.on = (e, cb) => (e === "finish" && res._finish.push(cb), res);
  res.emitFinish = (code) => (code && (res.statusCode = code), res._finish.forEach((cb) => cb()));
  return res;
}
function runMw(req) {
  const res = makeRes();
  let nexted = false;
  return middleware(req, res, () => { nexted = true; }).then(() => ({ res, nexted }));
}
async function startSession(impersonator, orgId, body) {
  const res = makeRes();
  await superAdminController.actAs(makeReq({ user: impersonator, params: { id: String(orgId) }, body }), res);
  if (res.body?.sessionId) createdSessionIds.push(res.body.sessionId);
  return res;
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set in .env");
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET not set in .env");
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to DB\n");

  /* ── fixtures ───────────────────────────────────────────────────────────── */
  const org = await Organisation.findOne({ slug: SLUG });
  if (!org) throw new Error(`Organisation "${SLUG}" not found`);
  const superadmin = await User.findOne({ role: "superadmin" });
  if (!superadmin) throw new Error("No superadmin user found");
  const calciteAdmin = await User.findOne({ organisationId: org._id, role: "admin" });
  const calciteDonor = await User.findOne({ organisationId: org._id, role: "donor" });
  const calciteUser = calciteDonor || calciteAdmin || (await User.findOne({ organisationId: org._id }));
  const outsider = (await User.findOne({ organisationId: { $ne: org._id }, _id: { $ne: superadmin._id } })) || superadmin;

  console.log("Fixtures:");
  console.log(`  org        : ${org.name} (${org._id})  adminUserId=${org.adminUserId || "—"}`);
  console.log(`  superadmin : ${superadmin.email}`);
  console.log(`  calciteUser: ${calciteUser ? `${calciteUser.email} (${calciteUser.role})` : "NONE"}`);
  console.log(`  donor      : ${calciteDonor ? calciteDonor.email : "none"}`);
  console.log(`  outsider   : ${outsider.email} (org ${outsider.organisationId || "—"})\n`);
  if (!calciteUser) throw new Error("calcite has no users to impersonate — cannot run");

  /* ════════════ A. actAs (start) scenarios ════════════ */
  console.log("A. actAs / start");

  // A1 — admin mode (informational: depends on org.adminUserId)
  const a1 = await startSession(superadmin, org._id, { reason: "smoke admin", mode: "admin", access: "full" });
  if (org.adminUserId) check("admin-mode start → 200 + admin/full", a1.body?.mode === "admin" && a1.body?.access === "full" && !!a1.body?.token, `session ${a1.body?.sessionId}`);
  else check("admin-mode start → 400 (org has no adminUserId)", a1.statusCode === 400, a1.body?.error);

  // A2 — website mode, explicit FULL, impersonating a real calcite user
  const a2 = await startSession(superadmin, org._id, { reason: "smoke website full", mode: "website", access: "full", userId: String(calciteUser._id) });
  const fullToken = a2.body?.token;
  const fullSessionId = a2.body?.sessionId;
  check("website-mode FULL start → 200, mode=website, access=full", a2.body?.mode === "website" && a2.body?.access === "full" && !!fullToken, `acting as ${calciteUser.email}`);

  // A3 — website mode default access = view_only
  const a3 = await startSession(superadmin, org._id, { reason: "smoke website default", mode: "website", userId: String(calciteUser._id) });
  const viewToken = a3.body?.token;
  const viewSessionId = a3.body?.sessionId;
  check("website-mode default access = view_only", a3.body?.access === "view_only", `access=${a3.body?.access}`);

  // A4 — org mismatch: userId from another org is rejected
  const a4 = makeRes();
  await superAdminController.actAs(makeReq({ user: superadmin, params: { id: String(org._id) }, body: { mode: "website", userId: String(outsider._id) } }), a4);
  check("website-mode userId from another org → 400", a4.statusCode === 400, a4.body?.error);

  // A5 — DB row created for the full session
  const fullRow = fullSessionId ? await SupportSession.findOne({ sessionId: fullSessionId }) : null;
  check("SupportSession row persisted (active)", fullRow?.status === "active" && String(fullRow?.organisationId) === String(org._id));

  // A6 — session_started audit row written
  const startedAudit = fullSessionId ? await PlatformAuditLog.findOne({ action: "support.session_started", "meta.sessionId": fullSessionId }) : null;
  check("session_started audit row written", !!startedAudit, startedAudit ? `actor=${startedAudit.actorEmail}` : "");

  /* ════════════ B. middleware: kill switch / passthrough ════════════ */
  console.log("\nB. middleware guard");

  // B1 — no token → passthrough
  const b1 = await runMw(makeReq({}));
  check("no token → passthrough", b1.nexted && !b1.res.ended);

  // B2 — non-support token → passthrough
  const b2 = await runMw(makeReq({ token: jwt.sign({ id: String(superadmin._id) }, process.env.JWT_SECRET) }));
  check("non-support token → passthrough", b2.nexted && !b2.res.ended);

  // B3 — unknown sessionId (forged but signed) → 401
  const b3 = await runMw(makeReq({ token: jwt.sign({ support_session: true, sessionId: "does-not-exist-" + Date.now() }, process.env.JWT_SECRET) }));
  check("unknown session → 401", !b3.nexted && b3.res.statusCode === 401, b3.res.body?.error);

  // B4 — active full token, GET → passthrough + req.support populated
  const b4req = makeReq({ token: fullToken, method: "GET" });
  const b4 = await runMw(b4req);
  check("active full token GET → passthrough", b4.nexted && b4req.support?.sessionId === fullSessionId, `mode=${b4req.support?.mode} access=${b4req.support?.access}`);

  /* ════════════ C. per-action audit (full access) ════════════ */
  console.log("\nC. per-action audit");

  // C1 — full token, POST, finish 201 → support.action audited + actionCount++
  const cReq = makeReq({ token: fullToken, method: "POST", url: "/api/programs", body: { name: "Smoke Program", password: "should-be-redacted" } });
  const c = await runMw(cReq);
  c.res.emitFinish(201);
  await delay(250);
  const actionRow = await PlatformAuditLog.findOne({ action: "support.action", "meta.sessionId": fullSessionId });
  check("successful write → support.action audited", c.nexted && !!actionRow, actionRow ? `label="${actionRow.meta?.label}"` : "no row");
  check("audit captures method/path/status", actionRow?.meta?.method === "POST" && actionRow?.meta?.path === "/api/programs" && actionRow?.meta?.status === 201);
  check("audit redacts secrets in changes", actionRow?.meta?.changes?.password === "[redacted]" && actionRow?.meta?.changes?.name === "Smoke Program");
  const incRow = await SupportSession.findOne({ sessionId: fullSessionId });
  check("session.actionCount incremented", (incRow?.actionCount || 0) >= 1, `actionCount=${incRow?.actionCount}`);

  // C2 — full token, failed write (500) → NOT audited
  const beforeFail = await PlatformAuditLog.countDocuments({ action: "support.action", "meta.sessionId": fullSessionId });
  const c2 = await runMw(makeReq({ token: fullToken, method: "DELETE", url: "/api/programs/64a000000000000000000999" }));
  c2.res.emitFinish(500);
  await delay(250);
  const afterFail = await PlatformAuditLog.countDocuments({ action: "support.action", "meta.sessionId": fullSessionId });
  check("failed write (>=400) → NOT audited", afterFail === beforeFail, `count ${beforeFail}→${afterFail}`);

  /* ════════════ D. view-only enforcement ════════════ */
  console.log("\nD. view-only");

  // D1 — view-only token, POST → 403 VIEW_ONLY, no audit
  const beforeVO = await PlatformAuditLog.countDocuments({ action: "support.action", "meta.sessionId": viewSessionId });
  const d1 = await runMw(makeReq({ token: viewToken, method: "POST", url: "/api/programs", body: { x: 1 } }));
  const afterVO = await PlatformAuditLog.countDocuments({ action: "support.action", "meta.sessionId": viewSessionId });
  check("view-only POST → 403 VIEW_ONLY", !d1.nexted && d1.res.statusCode === 403 && d1.res.body?.code === "VIEW_ONLY");
  check("view-only blocked write → not audited", afterVO === beforeVO);

  // D2 — view-only token, GET → passthrough
  const d2 = await runMw(makeReq({ token: viewToken, method: "GET" }));
  check("view-only GET → passthrough", d2.nexted && !d2.res.ended);

  /* ════════════ E. kill switch: end + revoke + expiry ════════════ */
  console.log("\nE. kill switch");

  // E1 — endSupportSession (from tenant context) ends the FULL session
  const e1res = makeRes();
  await superAdminController.endSupportSession(makeReq({ token: fullToken }), e1res);
  const endedRow = await SupportSession.findOne({ sessionId: fullSessionId });
  check("endSupportSession → status ended", e1res.statusCode === 200 && endedRow?.status === "ended");
  const e1mw = await runMw(makeReq({ token: fullToken, method: "GET" }));
  check("ended session → next request 401 (kill switch)", !e1mw.nexted && e1mw.res.statusCode === 401);

  // E2 — revokeSession (operator) revokes the VIEW-ONLY session
  const e2res = makeRes();
  await supportSessionController.revokeSession(makeReq({ user: superadmin, params: { sessionId: viewSessionId } }), e2res);
  const revokedRow = await SupportSession.findOne({ sessionId: viewSessionId });
  check("revokeSession → status revoked", e2res.statusCode === 200 && revokedRow?.status === "revoked");
  const e2mw = await runMw(makeReq({ token: viewToken, method: "GET" }));
  check("revoked session → next request 401 (kill switch)", !e2mw.nexted && e2mw.res.statusCode === 401);
  const revokeAudit = await PlatformAuditLog.findOne({ action: "support.session_revoked", "meta.sessionId": viewSessionId });
  check("revoke writes session_revoked audit", !!revokeAudit);

  // E3 — expiry: start a session, force expiresAt into the past → 401 + flips to expired
  const e3 = await startSession(superadmin, org._id, { mode: "website", access: "full", userId: String(calciteUser._id), reason: "smoke expiry" });
  await SupportSession.updateOne({ sessionId: e3.body.sessionId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const e3mw = await runMw(makeReq({ token: e3.body.token, method: "GET" }));
  const e3row = await SupportSession.findOne({ sessionId: e3.body.sessionId });
  check("expired session → 401 + status flips to expired", !e3mw.nexted && e3mw.res.statusCode === 401 && e3row?.status === "expired");

  /* ════════════ F. operator read APIs ════════════ */
  console.log("\nF. operator read APIs");

  // F1 — listSessions filtered by calcite returns our sessions
  const f1res = makeRes();
  await supportSessionController.listSessions(makeReq({ user: superadmin, query: { organisationId: String(org._id), limit: 100 } }), f1res);
  const listedIds = (f1res.body?.sessions || []).map((s) => s.sessionId);
  check("listSessions returns calcite sessions", createdSessionIds.every((id) => listedIds.includes(id)), `${f1res.body?.sessions?.length} rows`);

  // F2 — getSession returns the session + its audited actions
  const f2res = makeRes();
  await supportSessionController.getSession(makeReq({ user: superadmin, params: { sessionId: fullSessionId } }), f2res);
  const actions = f2res.body?.actions || [];
  check("getSession returns session + actions", f2res.body?.session?.sessionId === fullSessionId && actions.some((a) => a.action === "support.action"), `${actions.length} activity rows`);

  // F3 — global audit list returns support.action entries
  const f3res = makeRes();
  await supportSessionController.listAudit(makeReq({ user: superadmin, query: { action: "support.action", limit: 50 } }), f3res);
  check("listAudit (support.action) returns entries", (f3res.body?.entries || []).length >= 1, `${f3res.body?.total} total`);

  /* ── show the audit trail we produced ─────────────────────────────────── */
  console.log("\nAudit trail produced for the FULL session (what the detail screen shows):");
  const trail = await PlatformAuditLog.find({ "meta.sessionId": fullSessionId }).sort({ createdAt: 1 });
  trail.forEach((a) => console.log(`  • ${a.action.padEnd(26)} ${a.meta?.label || ""} ${a.meta?.method ? `[${a.meta.method} ${a.meta.path} ${a.meta.status}]` : ""}`));
}

/* ── run + always clean up ───────────────────────────────────────────────── */
(async () => {
  let failed = false;
  try {
    await main();
  } catch (err) {
    console.error("\nFATAL:", err.message);
    failed = true;
  } finally {
    // Clean up everything this test created — nothing else is touched.
    let delSessions = { deletedCount: 0 }, delAudit = { deletedCount: 0 };
    if (createdSessionIds.length) {
      delSessions = await SupportSession.deleteMany({ sessionId: { $in: createdSessionIds } });
      delAudit = await PlatformAuditLog.deleteMany({ "meta.sessionId": { $in: createdSessionIds } });
    }
    const passed = results.filter((r) => r.pass).length;
    const failedCount = results.length - passed;
    console.log("\n" + "─".repeat(60));
    console.log(`RESULT: ${passed}/${results.length} checks passed${failedCount ? `, ${failedCount} FAILED` : ""}`);
    console.log(`CLEANUP: removed ${delSessions.deletedCount} SupportSession + ${delAudit.deletedCount} audit rows (created sessionIds: ${createdSessionIds.length})`);
    await mongoose.disconnect();
    process.exit(failed || failedCount ? 1 : 0);
  }
})();
