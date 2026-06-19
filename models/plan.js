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
    currency: { type: String, default: "aud", lowercase: true },
    price: { type: priceSchema, default: () => ({}) },
    // Metered quotas keyed by config/featureCatalog.js meter keys (e.g.
    // { campaigns: 5, volunteers: 50 }). A `null` value = UNLIMITED; an absent
    // key = fall back to the catalog/legacy default. Mixed so any future metric
    // can be added without a schema change (remember markModified on writes).
    limits: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    // Boolean capability flags keyed by config/featureCatalog.js flag keys
    // (e.g. { events: true, newsletter: false }). Absent key = treated as off
    // for non-core flags. Mixed for the same forward-compat reason as `limits`.
    featureFlags: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    // Free-form marketing bullet points shown on the public pricing card
    // (display only — functional gating lives in `featureFlags`).
    features: { type: [String], default: [] },
    color: { type: String, default: "#10b981" }, // accent for the plan card
    stripeProductId: { type: String, default: "" },
    stripePriceIds: { type: stripePriceIdSchema, default: () => ({}) },
    priceHistory: { type: [priceHistorySchema], default: [] },
    isPublic: { type: Boolean, default: true }, // show on the public pricing page
    isPopular: { type: Boolean, default: false }, // highlight with the "Most popular" ribbon
    isActive: { type: Boolean, default: true }, // assignable / not archived
    sortOrder: { type: Number, default: 0 },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Plan", planSchema);
