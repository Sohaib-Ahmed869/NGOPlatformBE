const SupportSession = require("../models/supportSession");
const PlatformAuditLog = require("../models/platformAuditLog");
const Organisation = require("../models/organisation");
const writeAudit = require("../utils/writeAudit");
const { emitToSuperAdmins } = require("../services/socket");

const input = require("../utils/operatorInput");

// Search terms are matched literally — an unescaped "(" throws inside $regex.
const escapeRegex = input.escapeRegex;

/**
 * An id filter arriving on the query string. A malformed value used to reach
 * Mongo and come back as a 500; an object (`?organisationId[$ne]=null`) reached
 * it as a query operator.
 * @returns {{error:string}|{value:string|null}}
 */
function idFilter(raw, label) {
  const v = input.filterValue(raw).trim();
  if (!v) return { value: null };
  if (!input.isObjectId(v)) return { error: `That ${label} is not valid` };
  return { value: v };
}

// Tenants whose name or slug matches — lets a text search reach records that
// only reference the organisation by id. Capped: a one-letter search would
// otherwise pull every tenant's id into an $in.
async function orgIdsMatching(term) {
  const rx = { $regex: term, $options: "i" };
  const rows = await Organisation.find({ $or: [{ name: rx }, { slug: rx }] })
    .select("_id")
    .limit(500)
    .lean();
  return rows.map((o) => o._id);
}

/**
 * Close out sessions that ran past `expiresAt` while nobody was looking.
 *
 * The middleware only flips a row to "expired" when the operator's token comes
 * back through it — so an operator who just closes the tab leaves a row that
 * says "active" forever. On the kill-switch screen that isn't cosmetic: the
 * "Active now" tile, the status filter and the Revoke button all then describe
 * a session that ended an hour ago, and a genuinely live one gets lost among
 * them.
 *
 * Cheap (served by the { status, expiresAt } index, and a no-op once swept), so
 * it runs before every read of this collection. Returns how many it closed.
 */
async function sweepExpired() {
  try {
    const r = await SupportSession.updateMany(
      { status: "active", expiresAt: { $lte: new Date() } },
      // Pipeline form so each row ends at ITS OWN expiry, not "now".
      [{ $set: { status: "expired", endedAt: "$expiresAt" } }]
    );
    const n = r.modifiedCount || 0;
    if (n) emitToSuperAdmins("supportSession:updated", { reason: "expired", count: n });
    return n;
  } catch (err) {
    // A failed sweep must never take the list down with it — the rows are just
    // still marked active, which is what they were a moment ago anyway.
    console.error("Support session expiry sweep failed:", err.message);
    return 0;
  }
}

// The status filter's allowed values, read off the schema so a new lifecycle
// state can never be filterable on one side and rejected on the other.
const STATUSES = ["all", ...SupportSession.schema.path("status").enumValues];

/**
 * Sortable columns for the sessions table and the audit table.
 *
 * "Tenant" sorts by the denormalised `orgSlug` rather than the populated
 * organisation name: the name lives on another collection, so ordering by it
 * would need a $lookup, and the slug is derived from the name — close enough
 * to alphabetical that the column does what it looks like it does.
 */
const SESSION_SORTS = {
  tenant: "orgSlug",
  operator: "impersonatorEmail",
  actingAs: "targetEmail",
  status: "status",
  started: "startedAt",
  expires: "expiresAt",
};

const AUDIT_SORTS = {
  action: "action",
  operator: "actorEmail",
  tenant: "organisationId",
  when: "createdAt",
};

// Distinct-count helper shared by both facets.
const distinctCount = (field) => [
  { $group: { _id: `$${field}` } },
  { $match: { _id: { $nin: [null, ""] } } },
  { $count: "n" },
];

/**
 * GET /api/superadmin/support-sessions
 * List impersonation sessions, newest first. Filters: organisationId, status,
 * impersonatorId, search. Paginated.
 */
exports.listSessions = async (req, res) => {
  try {
    const { search } = req.query;
    const { page, limit } = input.paging(req.query, { defaultLimit: 100, maxLimit: 500 });
    // Ordered newest-first by default: the question this screen exists to
    // answer is "who is inside a tenant right now".
    const sessionSort = input.sorting(req.query, SESSION_SORTS, { defaultKey: "started" });

    // Retire lapsed sessions BEFORE counting, so "Active now" and the status
    // filter agree with what the middleware would actually let through.
    await sweepExpired();

    const filter = {};
    const org = idFilter(req.query.organisationId, "organisation id");
    if (org.error) return res.status(400).json({ error: org.error });
    if (org.value) filter.organisationId = org.value;

    const actor = idFilter(req.query.impersonatorId, "operator id");
    if (actor.error) return res.status(400).json({ error: actor.error });
    if (actor.value) filter.impersonatorId = actor.value;

    // An unknown status used to be passed straight to Mongo, which matched
    // nothing and read as "there are no sessions" rather than "bad filter".
    const status = input.oneOf(req.query.status, "Status", STATUSES, { required: false });
    if (status.error) return res.status(400).json({ error: status.error });
    if (status.value && status.value !== "all") filter.status = status.value;

    // Server-side search: the screen could previously only filter the rows it
    // had already loaded, so a session on page 2 was unreachable.
    const term = search ? escapeRegex(input.filterValue(search).trim()) : "";
    if (term) {
      const rx = { $regex: term, $options: "i" };
      const orgIds = await orgIdsMatching(term);
      filter.$or = [
        { impersonatorEmail: rx },
        { targetEmail: rx },
        { reason: rx },
        { orgSlug: rx },
        { sessionId: rx },
      ];
      if (orgIds.length) filter.$or.push({ organisationId: { $in: orgIds } });
    }

    // `liveNow` is deliberately UNfiltered: it answers "is anyone inside a
    // tenant right now", which no status or search filter should be able to
    // hide. Everything else describes the filtered set.
    const [sessions, summaryAgg, liveNow] = await Promise.all([
      SupportSession.find(filter)
        .populate("organisationId", "name slug branding.logo branding.logoDark branding.iconLogo branding.iconLogoDark")
        .sort(sessionSort.sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      // Counts describe the WHOLE filtered set — they used to be derived from
      // the loaded page while sitting next to a server-wide total.
      SupportSession.aggregate([
        { $match: filter },
        {
          $facet: {
            total: [{ $count: "n" }],
            active: [{ $match: { status: "active" } }, { $count: "n" }],
            operators: distinctCount("impersonatorEmail"),
            tenants: distinctCount("organisationId"),
          },
        },
      ]),
      SupportSession.countDocuments({ status: "active" }),
    ]);

    const f = summaryAgg[0] || {};
    const n = (a) => a?.[0]?.n || 0;

    res.json({
      sessions,
      total: n(f.total),
      summary: {
        activeNow: n(f.active),
        liveNow,
        operators: n(f.operators),
        tenants: n(f.tenants),
      },
      page,
      limit,
      sort: { key: sessionSort.key, dir: sessionSort.dir },
      // The screen counts down to `expiresAt` and decides when a row has
      // lapsed. Anchoring that to server time stops a skewed operator clock
      // from showing a live session as expired (or the reverse).
      serverTime: new Date(),
    });
  } catch (err) {
    console.error("List support sessions error:", err);
    res.status(500).json({ error: "Failed to fetch support sessions" });
  }
};

/**
 * GET /api/superadmin/support-sessions/:sessionId
 * One session plus the audited actions performed during it.
 */
exports.getSession = async (req, res) => {
  try {
    const sessionId = input.filterValue(req.params.sessionId).trim();
    if (!sessionId) return res.status(404).json({ error: "Support session not found" });

    await sweepExpired();

    const session = await SupportSession.findOne({ sessionId })
      .populate("organisationId", "name slug branding.logo branding.logoDark branding.iconLogo branding.iconLogoDark")
      .populate("endedBy", "name email")
      .lean();
    if (!session) return res.status(404).json({ error: "Support session not found" });

    // Backed by the sparse `meta.sessionId` index on PlatformAuditLog — without
    // it this scanned the whole audit collection for every session opened.
    // Capped, too: a busy hour of writes is thousands of rows and the timeline
    // renders every one. The tail is what an operator came to read, so the cap
    // keeps the LATEST N and the response says it did.
    const { limit } = input.paging(req.query, { defaultLimit: 300, maxLimit: 1000 });
    const query = { "meta.sessionId": sessionId };
    const [actionTotal, writeTotal, recent] = await Promise.all([
      PlatformAuditLog.countDocuments(query),
      PlatformAuditLog.countDocuments({ ...query, action: "support.action" }),
      PlatformAuditLog.find(query).sort({ createdAt: -1 }).limit(limit).lean(),
    ]);

    res.json({
      session,
      actions: recent.reverse(), // oldest to newest, for the timeline
      // Counts cover the WHOLE trail, not the page — the sidebar's "write
      // actions" must not shrink just because the timeline was truncated.
      actionTotal,
      writeTotal,
      truncated: actionTotal > recent.length,
      serverTime: new Date(),
    });
  } catch (err) {
    console.error("Get support session error:", err);
    res.status(500).json({ error: "Failed to fetch support session" });
  }
};

/** One audit entry per killed session, so each session's own timeline says why it ended. */
const auditRevoke = (req, s) =>
  writeAudit(req, "support.session_revoked", {
    organisationId: s.organisationId,
    targetType: "support_session",
    targetId: s.sessionId,
    meta: { sessionId: s.sessionId, actingAs: s.targetEmail, orgSlug: s.orgSlug },
  });

/**
 * POST /api/superadmin/support-sessions/:sessionId/revoke
 * Force-end a live session. The middleware rejects the token on its very next
 * request, so this is an immediate kill switch.
 */
exports.revokeSession = async (req, res) => {
  try {
    const sessionId = input.filterValue(req.params.sessionId).trim();
    if (!sessionId) return res.status(404).json({ error: "Support session not found" });

    // Atomic. Two operators hitting Revoke on the same live session used to
    // both read "active", both write, and both be told it worked — the second
    // silently overwriting the first's endedAt/endedBy. Only the winner writes.
    const session = await SupportSession.findOneAndUpdate(
      { sessionId, status: "active" },
      { $set: { status: "revoked", endedAt: new Date(), endedBy: req.user._id } },
      { new: true }
    )
      .populate("organisationId", "name slug branding.logo branding.logoDark branding.iconLogo branding.iconLogoDark")
      .populate("endedBy", "name email")
      .lean();

    if (!session) {
      // Nothing matched: either it never existed, or it is no longer active.
      const existing = await SupportSession.findOne({ sessionId }).select("status").lean();
      if (!existing) return res.status(404).json({ error: "Support session not found" });
      return res.status(409).json({ error: `Session is already ${existing.status}`, status: existing.status });
    }

    await auditRevoke(req, session);
    emitToSuperAdmins("supportSession:updated", { reason: "revoked", sessionId });

    res.json({ session });
  } catch (err) {
    console.error("Revoke support session error:", err);
    res.status(500).json({ error: "Failed to revoke support session" });
  }
};

/**
 * POST /api/superadmin/support-sessions/revoke-all
 * Panic switch: end EVERY live impersonation session at once (optionally only
 * one tenant's). One-at-a-time revoking is the wrong tool when the answer to
 * "who is inside our tenants right now?" needs to become "nobody".
 */
exports.revokeAllSessions = async (req, res) => {
  try {
    await sweepExpired();

    const filter = { status: "active" };
    const org = idFilter(req.body?.organisationId, "organisation id");
    if (org.error) return res.status(400).json({ error: org.error });
    if (org.value) filter.organisationId = org.value;

    const targets = await SupportSession.find(filter)
      .select("sessionId organisationId targetEmail orgSlug")
      .lean();
    if (!targets.length) return res.json({ revoked: 0, sessions: [] });

    const ids = targets.map((s) => s.sessionId);
    // Re-assert `status: "active"` so a session someone else killed in the same
    // instant is left alone rather than having its endedBy rewritten.
    const result = await SupportSession.updateMany(
      { sessionId: { $in: ids }, status: "active" },
      { $set: { status: "revoked", endedAt: new Date(), endedBy: req.user._id } }
    );

    await Promise.all(targets.map((s) => auditRevoke(req, s)));
    // Plus one entry describing the sweep itself.
    await writeAudit(req, "support.sessions_revoked_all", {
      organisationId: org.value || null,
      targetType: "support_session",
      targetId: "",
      meta: { count: result.modifiedCount || 0, sessionIds: ids.slice(0, 50) },
    });
    emitToSuperAdmins("supportSession:updated", { reason: "revoked_all", count: result.modifiedCount || 0 });

    res.json({ revoked: result.modifiedCount || 0, sessions: ids });
  } catch (err) {
    console.error("Revoke all support sessions error:", err);
    res.status(500).json({ error: "Failed to revoke support sessions" });
  }
};

/**
 * GET /api/superadmin/audit
 * Global operator audit log. Filters: organisationId, actorId, action, from, to.
 */
exports.listAudit = async (req, res) => {
  try {
    const { from, to, search } = req.query;
    const { page, limit } = input.paging(req.query, { defaultLimit: 100, maxLimit: 500 });
    const auditSort = input.sorting(req.query, AUDIT_SORTS, { defaultKey: "when" });

    const filter = {};
    const org = idFilter(req.query.organisationId, "organisation id");
    if (org.error) return res.status(400).json({ error: org.error });
    if (org.value) filter.organisationId = org.value;

    const actor = idFilter(req.query.actorId, "operator id");
    if (actor.error) return res.status(400).json({ error: actor.error });
    if (actor.value) filter.actorId = actor.value;

    const action = input.filterValue(req.query.action);
    if (action && action !== "all") filter.action = action;
    if (from || to) {
      const range = {};
      if (from) {
        const d = new Date(from);
        if (!Number.isNaN(d.getTime())) range.$gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (!Number.isNaN(d.getTime())) {
          // A date-only value ("2026-08-12") parses to UTC midnight, so `$lte`
          // excluded everything that happened that day. Treat it as "through
          // the end of that day".
          if (/^\d{4}-\d{2}-\d{2}$/.test(String(to).trim())) d.setUTCHours(23, 59, 59, 999);
          range.$lte = d;
        }
      }
      if (Object.keys(range).length) filter.createdAt = range;
    }

    // Server-side search across the action, who did it, what it targeted and
    // the tenant it belongs to — the screen could only filter its loaded page.
    const term = search ? escapeRegex(String(search).trim()) : "";
    if (term) {
      const rx = { $regex: term, $options: "i" };
      const orgIds = await orgIdsMatching(term);
      filter.$or = [{ action: rx }, { actorEmail: rx }, { targetId: rx }, { targetType: rx }];
      if (orgIds.length) filter.$or.push({ organisationId: { $in: orgIds } });
    }

    const [entries, summaryAgg] = await Promise.all([
      PlatformAuditLog.find(filter)
        .populate("organisationId", "name slug branding.logo branding.logoDark branding.iconLogo branding.iconLogoDark")
        .sort(auditSort.sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      // Whole-filtered-set figures: the strip previously counted distinct
      // operators and tenants from the 50 rows on screen.
      PlatformAuditLog.aggregate([
        { $match: filter },
        {
          $facet: {
            total: [{ $count: "n" }],
            operators: distinctCount("actorEmail"),
            tenants: distinctCount("organisationId"),
            latest: [{ $sort: { createdAt: -1 } }, { $limit: 1 }, { $project: { createdAt: 1 } }],
          },
        },
      ]),
    ]);

    const f = summaryAgg[0] || {};
    const n = (a) => a?.[0]?.n || 0;

    res.json({
      entries,
      total: n(f.total),
      summary: {
        operators: n(f.operators),
        tenants: n(f.tenants),
        latestAt: f.latest?.[0]?.createdAt || null,
      },
      page,
      limit,
      sort: { key: auditSort.key, dir: auditSort.dir },
    });
  } catch (err) {
    console.error("List audit error:", err);
    res.status(500).json({ error: "Failed to fetch audit log" });
  }
};
