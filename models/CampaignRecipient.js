// One row per person per campaign. Lets the sender be resumable/retryable, gives
// accurate per-recipient status, and powers the admin failure list. There is NO
// open-tracking here by design (the tenant declined open pixels).
const mongoose = require("mongoose");

const campaignRecipientSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "NewsletterCampaign", required: true, index: true },
    organisationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organisation", default: null, index: true },
    subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: "NewsletterSubscription", default: null },

    email: { type: String, required: true, lowercase: true, trim: true },
    // Copied from the subscriber at materialise time so the send doesn't have to
    // re-load the subscription just to build the unsubscribe link.
    unsubscribeToken: { type: String, default: "" },

    // queued → not yet attempted; sent → delivered; failed → terminal (after
    // retries); bounced → provider 5xx; skipped → filtered out (invalid address).
    status: { type: String, enum: ["queued", "sent", "failed", "bounced", "skipped"], default: "queued", index: true },

    // rate_limit | auth | hard_bounce | soft_bounce | quota_exhausted | invalid_address | unknown
    failureCode: { type: String, default: "" },
    failureReason: { type: String, default: "" },

    mailboxId: { type: mongoose.Schema.Types.ObjectId, ref: "Mailbox", default: null }, // which mailbox sent it
    attempts: { type: Number, default: 0 },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Idempotent materialisation: one row per (campaign, email).
campaignRecipientSchema.index({ campaignId: 1, email: 1 }, { unique: true });
campaignRecipientSchema.index({ campaignId: 1, status: 1 });

module.exports = mongoose.model("CampaignRecipient", campaignRecipientSchema);
