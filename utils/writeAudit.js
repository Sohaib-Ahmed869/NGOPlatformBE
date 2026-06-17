const PlatformAuditLog = require("../models/platformAuditLog");

/**
 * Record a platform-operator action. Best-effort: never throws and never blocks
 * the request — a logging failure must not break the operation it describes.
 *
 * @param {object} req    Express request (actor + ip read from here)
 * @param {string} action dotted action code, e.g. "plan.created"
 * @param {object} extra  { organisationId, targetType, targetId, meta }
 */
async function writeAudit(req, action, extra = {}) {
  try {
    await PlatformAuditLog.create({
      actorId: req?.user?._id,
      actorEmail: req?.user?.email || "",
      action,
      organisationId: extra.organisationId || null,
      targetType: extra.targetType || "",
      targetId: extra.targetId || "",
      meta: extra.meta || {},
      ip:
        (req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim() ||
        req?.ip ||
        req?.socket?.remoteAddress ||
        "",
      userAgent: req?.headers?.["user-agent"] || "",
    });
  } catch (err) {
    console.error("writeAudit failed:", err.message);
  }
}

module.exports = writeAudit;
