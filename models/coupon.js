const mongoose = require("mongoose");

/**
 * A SaaS subscription discount coupon, synced to a Stripe Coupon (+ Promotion
 * Code so the human `code` is enterable at checkout). Applied to the SaaS
 * registration checkout session.
 */
const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, default: "" },
    type: { type: String, enum: ["percent", "amount"], default: "percent" },
    value: { type: Number, required: true }, // percent (1–100) OR amount in major units
    currency: { type: String, default: "usd" }, // for `amount` type
    duration: { type: String, enum: ["once", "forever", "repeating"], default: "once" },
    durationInMonths: { type: Number, default: null }, // for `repeating`
    planCodes: { type: [String], default: [] }, // whitelist; empty = all plans
    maxRedemptions: { type: Number, default: null },
    timesRedeemed: { type: Number, default: 0 },
    redeemBy: { type: Date, default: null },
    stripeCouponId: { type: String, default: "" },
    stripePromotionCodeId: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Coupon", couponSchema);
