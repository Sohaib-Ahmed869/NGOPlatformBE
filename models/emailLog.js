const mongoose = require("mongoose");

/**
 * One row per attempted send.
 *
 * Before this, a failed transactional email left nothing behind but a
 * console.log on whichever server instance happened to handle the request --
 * so "the donor says they never got their receipt" was unanswerable. Every send
 * now lands here with its outcome, which SMTP identity carried it, and the
 * provider's error verbatim when it failed.
 *
 * Bodies are NOT stored: they contain temporary passwords, reset links and
 * donor details, and a log is a much softer target than the mail itself. The
 * subject and the template key are enough to answer the question.
 */
const emailLogSchema = new mongoose.Schema(
  {
    // Catalog key, or "" for a legacy/ad-hoc sendEmail() call.
    templateKey: { type: String, default: "", index: true },
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      default: null,
      index: true,
    },

    to: { type: String, default: "" },
    subject: { type: String, default: "" },

    // skipped = the template is switched off, or there was no recipient.
    status: {
      type: String,
      enum: ["sent", "failed", "skipped"],
      default: "sent",
      index: true,
    },
    // Which SMTP account actually carried it -- the tenant's own or the
    // platform fallback. The commonest cause of "our mail looks wrong" is
    // silently falling back to the platform account.
    transport: { type: String, enum: ["tenant", "platform"], default: "platform" },

    // Which layer produced the content, so a support question about wording can
    // be traced to the right editor.
    // Where the CONTENT came from -- the layer the resolver landed on. "draft" is
    // an unsaved edit being tested from the editor. This is provenance, NOT the
    // kind of send: a test is marked by meta.test, and writing "test" here fails
    // validation and silently loses the row.
    source: { type: String, enum: ["tenant", "platform", "catalog", "draft", "adhoc"], default: "adhoc" },

    messageId: { type: String, default: "" },
    error: { type: String, default: "" },
    reason: { type: String, default: "" }, // why a send was skipped
    attachments: { type: Number, default: 0 },
    // Wall-clock time the SMTP call took, in ms -- surfaces a slow provider.
    durationMs: { type: Number, default: 0 },

    // Free-form breadcrumbs from the call site (donationId, ticketNumber, ...).
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

// The console's default view: newest first, filtered by tenant and/or status.
emailLogSchema.index({ createdAt: -1 });
emailLogSchema.index({ organisationId: 1, createdAt: -1 });
emailLogSchema.index({ status: 1, createdAt: -1 });
// Recipient lookup ("did sarah@ get her receipt?") is the single most common
// support query this collection exists to answer.
emailLogSchema.index({ to: 1, createdAt: -1 });

// Self-pruning: an email log is an operational record, not an archive, and this
// collection grows with every send. 180 days covers any realistic "did it
// arrive?" question and a full financial-year receipt query.
// Override with EMAIL_LOG_RETENTION_DAYS (0 disables expiry entirely).
const RETENTION_DAYS = Number(process.env.EMAIL_LOG_RETENTION_DAYS ?? 180);
if (RETENTION_DAYS > 0) {
  emailLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 86400 });
}

module.exports = mongoose.model("EmailLog", emailLogSchema);
