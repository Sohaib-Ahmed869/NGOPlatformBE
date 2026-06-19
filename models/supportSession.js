const mongoose = require("mongoose");

/**
 * One platform-support impersonation session. The JWT minted by `actAs` carries
 * the matching `sessionId`; the middleware (middleware/supportSession.js) looks
 * this row up on every tenant request and rejects the token the moment the
 * session is no longer "active" — so "End session" / "Revoke" / expiry are a real
 * server-side kill switch, not just a browser-side clear.
 *
 * The lifecycle (mutable status) lives here; the per-action audit trail lives in
 * PlatformAuditLog rows tagged with `meta.sessionId`.
 */
const supportSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },

    organisationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organisation", required: true },
    orgSlug: { type: String, default: "" },

    // The operator who is accountable for everything done in the session.
    impersonatorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    impersonatorEmail: { type: String, default: "" },

    // The identity being impersonated (org admin in "admin" mode, the reported
    // donor/customer in "website" mode).
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    targetEmail: { type: String, default: "" },
    targetRole: { type: String, default: "" },

    mode: { type: String, enum: ["admin", "website"], default: "admin" },
    access: { type: String, enum: ["full", "view_only"], default: "full" },

    reason: { type: String, default: "" },
    ticketId: { type: mongoose.Schema.Types.ObjectId, ref: "SupportTicket", default: null },

    status: {
      type: String,
      enum: ["active", "ended", "revoked", "expired"],
      default: "active",
      index: true,
    },

    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    endedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    actionCount: { type: Number, default: 0 },

    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
  },
  { timestamps: true }
);

supportSessionSchema.index({ organisationId: 1, startedAt: -1 });
supportSessionSchema.index({ status: 1, startedAt: -1 });

module.exports = mongoose.model("SupportSession", supportSessionSchema);
