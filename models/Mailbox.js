// A Mailbox is a per-tenant SENDING IDENTITY used for newsletter/marketing
// campaigns. A tenant can connect several (e.g. two Gmail accounts) and the
// campaign sender ROTATES across the healthy ones to multiply daily capacity
// without tripping any single provider's rate limits.
//
// Deliverability lives here: the app sends through the branch's own reputable
// SMTP (Gmail/Outlook/etc.), so SPF/DKIM/DMARC are handled by that provider —
// there is intentionally no signing logic in this repo. What the code DOES own
// is throttling (quotas + health/cooldown) so we never burn sender reputation.
//
// Transactional email (receipts, password resets, notifications) is NOT affected
// by this model — it keeps using organisation.email via services/tenantEmail.js.
const mongoose = require("mongoose");

const mailboxSchema = new mongoose.Schema(
  {
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
      index: true,
    },
    label: { type: String, default: "" }, // friendly name shown in the admin

    // SMTP credentials. The password is AES-256-GCM encrypted (utils/crypto.js)
    // and never returned to any client.
    smtp: {
      host: { type: String, default: "" },
      port: { type: Number, default: 587 },
      secure: { type: Boolean, default: false }, // 465 → true, 587/STARTTLS → false
      username: { type: String, default: "" },
      passwordEnc: { type: String, default: "" },
    },

    // Sender identity used on the From / Reply-To of campaign emails.
    fromName: { type: String, default: "" },
    fromEmail: { type: String, default: "" }, // defaults to smtp.username when blank
    replyTo: { type: String, default: "" },

    // Sending limits (per provider). Gmail ≈ 500/day for a normal account; keep
    // the hourly limit low so sends are spread out (bursty sending = spam flag).
    quotaConfig: {
      dailyLimit: { type: Number, default: 500 },
      hourlyLimit: { type: Number, default: 20 },
    },

    // Rolling usage counters. Reset lazily when their window elapses (see
    // mailbox.service.rollover) rather than on a cron.
    usage: {
      sentToday: { type: Number, default: 0 },
      sentThisHour: { type: Number, default: 0 },
      dayResetAt: { type: Date, default: () => new Date() },
      hourResetAt: { type: Date, default: () => new Date() },
    },

    // Health: `cooldown` is a temporary back-off after a provider rate-limit
    // signal; `unhealthy` is a hard problem (bad credentials) that needs the
    // admin to fix it. Only `healthy` (and expired-cooldown) mailboxes send.
    healthStatus: { type: String, enum: ["healthy", "unhealthy", "cooldown"], default: "healthy" },
    cooldownUntil: { type: Date, default: null },
    lastError: { type: String, default: "" },
    lastUsedAt: { type: Date, default: null },
    lastVerifiedAt: { type: Date, default: null },

    isActive: { type: Boolean, default: true }, // admin can pause a mailbox
    isDefault: { type: Boolean, default: false }, // used for single-mailbox sends (test sends)
  },
  { timestamps: true }
);

mailboxSchema.index({ organisationId: 1, isActive: 1 });

module.exports = mongoose.model("Mailbox", mailboxSchema);
