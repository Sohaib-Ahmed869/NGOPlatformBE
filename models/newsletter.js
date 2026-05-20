// Newsletter Subscription Model
const mongoose = require("mongoose");
const newsletterSubscriptionSchema = new mongoose.Schema(
  {
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      default: null,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    status: {
      type: String,
      enum: ["active", "unsubscribed"],
      default: "active",
    },
    source: {
      type: String,
      default: "website",
    },
  },
  {
    timestamps: true,
  }
);

newsletterSubscriptionSchema.index({ organisationId: 1, email: 1 }, { unique: true });

const NewsletterSubscription = mongoose.model(
  "NewsletterSubscription",
  newsletterSubscriptionSchema
);

module.exports = NewsletterSubscription;
