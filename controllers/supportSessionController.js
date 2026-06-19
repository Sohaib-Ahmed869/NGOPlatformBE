const SupportSession = require("../models/supportSession");
const PlatformAuditLog = require("../models/platformAuditLog");
const writeAudit = require("../utils/writeAudit");

/**
 * GET /api/superadmin/support-sessions
 * List impersonation sessions, newest first. Filters: organisationId, status,
 * impersonatorId. Paginated.
 */
exports.listSessions = async (req, res) => {
  try {
    const { organisationId, status, impersonatorId } = req.query;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const filter = {};
    if (organisationId) filter.organisationId = organisationId;
    if (status && status !== "all") filter.status = status;
    if (impersonatorId) filter.impersonatorId = impersonatorId;

    const [sessions, total] = await Promise.all([
      SupportSession.find(filter)
        .populate("organisationId", "name slug")
        .sort({ startedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      SupportSession.countDocuments(filter),
    ]);

    res.json({ sessions, total, page, limit });
  } catch (err) {
    console.error("List support sessions error:", err);
    res.status(500).json({ error: "Failed to fetch support sessions" });
  }
};

/**
 * GET /api/superadmin/support-sessions/:sessionId
 * One session plus every audited action performed during it.
 */
exports.getSession = async (req, res) => {
  try {
    const session = await SupportSession.findOne({ sessionId: req.params.sessionId }).populate(
      "organisationId",
      "name slug"
    );
    if (!session) return res.status(404).json({ error: "Support session not found" });

    const actions = await PlatformAuditLog.find({ "meta.sessionId": req.params.sessionId }).sort({
      createdAt: 1,
    });

    res.json({ session, actions });
  } catch (err) {
    console.error("Get support session error:", err);
    res.status(500).json({ error: "Failed to fetch support session" });
  }
};

/**
 * POST /api/superadmin/support-sessions/:sessionId/revoke
 * Force-end a live session. The middleware rejects the token on its very next
 * request, so this is an immediate kill switch.
 */
exports.revokeSession = async (req, res) => {
  try {
    const session = await SupportSession.findOne({ sessionId: req.params.sessionId });
    if (!session) return res.status(404).json({ error: "Support session not found" });
    if (session.status !== "active") {
      return res.status(400).json({ error: `Session is already ${session.status}` });
    }

    session.status = "revoked";
    session.endedAt = new Date();
    session.endedBy = req.user._id;
    await session.save();

    await writeAudit(req, "support.session_revoked", {
      organisationId: session.organisationId,
      targetType: "support_session",
      targetId: session.sessionId,
      meta: { sessionId: session.sessionId, actingAs: session.targetEmail },
    });

    res.json({ session });
  } catch (err) {
    console.error("Revoke support session error:", err);
    res.status(500).json({ error: "Failed to revoke support session" });
  }
};

/**
 * GET /api/superadmin/audit
 * Global operator audit log. Filters: organisationId, actorId, action, from, to.
 */
exports.listAudit = async (req, res) => {
  try {
    const { organisationId, actorId, action, from, to } = req.query;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const filter = {};
    if (organisationId) filter.organisationId = organisationId;
    if (actorId) filter.actorId = actorId;
    if (action && action !== "all") filter.action = action;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }

    const [entries, total] = await Promise.all([
      PlatformAuditLog.find(filter)
        .populate("organisationId", "name slug")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      PlatformAuditLog.countDocuments(filter),
    ]);

    res.json({ entries, total, page, limit });
  } catch (err) {
    console.error("List audit error:", err);
    res.status(500).json({ error: "Failed to fetch audit log" });
  }
};
