// A newsletter campaign — a single broadcast email composed by an admin and
// sent to an audience of subscribers. Stored so drafts, schedules and a full
// send history are all available in the admin.
const mongoose = require("mongoose");

const newsletterCampaignSchema = new mongoose.Schema(
  {
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      default: null,
      index: true,
    },
    subject: { type: String, default: "", trim: true },
    body: { type: String, default: "" }, // sanitised rich-text HTML

    status: {
      type: String,
      enum: ["draft", "scheduled", "sending", "sent", "failed"],
      default: "draft",
      index: true,
    },

    // Who receives it. all_active = every active subscriber; recent = active &
    // joined within `days`; source = active with a matching `source`.
    audience: {
      type: {
        type: String,
        enum: ["all_active", "recent", "source"],
        default: "all_active",
      },
      days: { type: Number, default: 30 },
      source: { type: String, default: "" },
    },

    scheduledAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },

    // How it was delivered. "mailchimp" campaigns also store the Mailchimp id.
    provider: { type: String, enum: ["smtp", "mailchimp"], default: "smtp" },
    mailchimpCampaignId: { type: String, default: "" },
    error: { type: String, default: "" }, // last failure reason (for the admin)

    // Tenant front-end origin captured at send/schedule time, used to build the
    // absolute unsubscribe link inside each email.
    originUrl: { type: String, default: "" },

    stats: {
      recipients: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("NewsletterCampaign", newsletterCampaignSchema);
