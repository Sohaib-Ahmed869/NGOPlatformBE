const mongoose = require("mongoose");

const organisationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Organisation name is required"],
      trim: true,
    },
    slug: {
      type: String,
      required: [true, "Slug is required"],
      unique: true,
      lowercase: true,
      trim: true,
    },
    plan: {
      type: String,
      enum: ["basic", "professional", "enterprise"],
      default: "basic",
    },
    billingCycle: {
      type: String,
      enum: ["monthly", "annual"],
      default: "monthly",
    },
    stripeCustomerId: {
      type: String,
    },
    stripeSubscriptionId: {
      type: String,
    },
    subscriptionStatus: {
      type: String,
      enum: ["pending", "active", "past_due", "cancelled"],
      default: "pending",
    },
    revenueRange: {
      type: String,
      enum: ["0-500", "500-5000000", "5000000+"],
    },
    adminUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    branding: {
      logo: { type: String, default: "" },
      primaryColor: { type: String, default: "#2C2418" },
      accentColor: { type: String, default: "#C9A84C" },
      backgroundColor: { type: String, default: "#FAF7F2" },
      theme: {
        type: String,
        default: "default",
      },
      tagline: { type: String, default: "" },
    },
    // Organisation contact & details (managed by org admin)
    contactEmail: { type: String, default: "" },
    contactPhone: { type: String, default: "" },
    address: { type: String, default: "" },
    website: { type: String, default: "" },
    bankDetails: {
      bankName: { type: String, default: "" },
      bsb: { type: String, default: "" },
      accountNumber: { type: String, default: "" },
      accountName: { type: String, default: "" },
    },
    isActive: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

organisationSchema.index({ stripeCustomerId: 1 });

module.exports = mongoose.model("Organisation", organisationSchema);
