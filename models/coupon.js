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
    // percent (1–100) OR amount in major units.
    //
    // Validated HERE, not only in the controller. The controller has rejected
    // percentages over 100 for a while, yet the collection still holds coupons
    // at 554% and 3e19% — they predate that check and nothing at the schema
    // level stopped them, so they persist and would be handed straight to
    // Stripe (which refuses anything over 100) by any code path that revives
    // them. A comment saying "1–100" is not a constraint; this is.
    value: {
      type: Number,
      required: true,
      validate: [
        {
          validator: (v) => Number.isFinite(v) && v > 0,
          message: "Discount value must be a positive number",
        },
        {
          // `this` is the document on a full save. On an update query it is not,
          // so guard rather than reading type off undefined — a findOneAndUpdate
          // simply skips the cross-field half of the rule.
          validator: function checkPercentCeiling(v) {
            if (!this || this.type !== "percent") return true;
            return v <= 100;
          },
          message: "A percent discount cannot exceed 100",
        },
      ],
    },
    currency: { type: String, default: "usd" }, // for `amount` type
    duration: { type: String, enum: ["once", "forever", "repeating"], default: "once" },
    // for `repeating`. Stripe caps duration_in_months, and a fractional or
    // zero month is rejected outright rather than rounded.
    durationInMonths: {
      type: Number,
      default: null,
      validate: {
        validator: (v) => v == null || (Number.isInteger(v) && v >= 1 && v <= 36),
        message: "A repeating discount must run for 1–36 whole months",
      },
    },
    planCodes: { type: [String], default: [] }, // whitelist; empty = all plans
    // null = unlimited. 0 would be a coupon nobody can ever redeem, which reads
    // as "unlimited" in every UI that treats it as falsy.
    maxRedemptions: {
      type: Number,
      default: null,
      validate: {
        validator: (v) => v == null || (Number.isInteger(v) && v >= 1),
        message: "Max redemptions must be at least 1, or left blank for unlimited",
      },
    },
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
