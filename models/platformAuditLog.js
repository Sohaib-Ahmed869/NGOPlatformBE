const mongoose = require("mongoose");

/**
 * Append-only log of platform-operator (super admin) actions: plan edits,
 * subscription changes, suspensions, comps, overrides, impersonation, etc.
 * Separate from any per-tenant audit trail. Written via utils/writeAudit.js.
 */
const platformAuditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    actorEmail: { type: String, default: "" },
    action: { type: String, required: true }, // e.g. "plan.created", "org.suspended"
    organisationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organisation", default: null },
    targetType: { type: String, default: "" }, // "plan" | "organisation" | ...
    targetId: { type: String, default: "" },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
  },
  { timestamps: true }
);

platformAuditLogSchema.index({ organisationId: 1, createdAt: -1 });
platformAuditLogSchema.index({ actorId: 1, createdAt: -1 });
platformAuditLogSchema.index({ action: 1, createdAt: -1 });

module.exports = mongoose.model("PlatformAuditLog", platformAuditLogSchema);
