const mongoose = require("mongoose");

// Amounts in WHOLE currency units (e.g. 200 = $200). Stripe charges the cents
// equivalent via the Price objects referenced in `stripePriceIds`.
const priceSchema = new mongoose.Schema(
  {
    monthly: { type: Number, default: 0 },
    annual: { type: Number, default: 0 },
  },
  { _id: false }
);

const stripePriceIdSchema = new mongoose.Schema(
  {
    monthly: { type: String, default: "" },
    annual: { type: String, default: "" },
  },
  { _id: false }
);

// `null` on a numeric limit means UNLIMITED (rendered as "Unlimited").
const limitsSchema = new mongoose.Schema(
  {
    campaigns: { type: Number, default: null },
    volunteers: { type: Number, default: null },
    volunteerEnabled: { type: Boolean, default: false },
  },
  { _id: false }
);

// Stripe Prices are immutable — a price edit mints a NEW Price and pushes the
// old amounts + IDs here, so prior subscribers stay grandfathered until migrated.
const priceHistorySchema = new mongoose.Schema(
  {
    monthly: Number,
    annual: Number,
    stripePriceIds: { monthly: String, annual: String },
    replacedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * A SaaS subscription plan the platform sells to tenant organisations.
 * Created/edited from the SuperAdmin portal; auto-provisioned in Stripe.
 * Supersedes the static config/{planPricing,planLimits,stripePrices}.js files.
 */
const planSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    currency: { type: String, default: "usd", lowercase: true },
    price: { type: priceSchema, default: () => ({}) },
    limits: { type: limitsSchema, default: () => ({}) },
    features: { type: [String], default: [] },
    color: { type: String, default: "#10b981" }, // accent for the plan card
    stripeProductId: { type: String, default: "" },
    stripePriceIds: { type: stripePriceIdSchema, default: () => ({}) },
    priceHistory: { type: [priceHistorySchema], default: [] },
    isPublic: { type: Boolean, default: true }, // show on the public pricing page
    isActive: { type: Boolean, default: true }, // assignable / not archived
    sortOrder: { type: Number, default: 0 },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Plan", planSchema);
