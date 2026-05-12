// Newsletter Subscription Model
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const newsletterSubscriptionSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
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

const NewsletterSubscription = mongoose.model(
  "NewsletterSubscription",
  newsletterSubscriptionSchema
);

module.exports = NewsletterSubscription;
