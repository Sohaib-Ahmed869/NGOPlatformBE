/**
 * Stripe sync for SaaS coupons. Creates a Stripe Coupon plus a Promotion Code
 * (so the human-readable code is enterable at checkout). Degrades gracefully
 * when STRIPE_SECRET_KEY is unset.
 */
const stripe = process.env.STRIPE_SECRET_KEY
  ? require("stripe")(process.env.STRIPE_SECRET_KEY)
  : null;

const isStripeEnabled = () => !!stripe;

async function createStripeCoupon(coupon) {
  if (!stripe) return { stripeCouponId: "", stripePromotionCodeId: "" };

  const params = { duration: coupon.duration, name: coupon.code };
  if (coupon.type === "percent") {
    params.percent_off = coupon.value;
  } else {
    params.amount_off = Math.round(coupon.value * 100);
    params.currency = coupon.currency || "usd";
  }
  if (coupon.duration === "repeating" && coupon.durationInMonths) {
    params.duration_in_months = coupon.durationInMonths;
  }
  if (coupon.maxRedemptions) params.max_redemptions = coupon.maxRedemptions;
  if (coupon.redeemBy) params.redeem_by = Math.floor(new Date(coupon.redeemBy).getTime() / 1000);

  const c = await stripe.coupons.create(params);

  let promo = null;
  try {
    promo = await stripe.promotionCodes.create({ coupon: c.id, code: coupon.code });
  } catch (e) {
    console.error("Promotion code create failed:", e.message);
  }
  return { stripeCouponId: c.id, stripePromotionCodeId: promo?.id || "" };
}

async function archiveStripeCoupon(coupon) {
  if (!stripe) return;
  try {
    if (coupon.stripePromotionCodeId) {
      await stripe.promotionCodes.update(coupon.stripePromotionCodeId, { active: false });
    }
    if (coupon.stripeCouponId) {
      await stripe.coupons.del(coupon.stripeCouponId);
    }
  } catch (e) {
    console.error("archiveStripeCoupon failed:", e.message);
  }
}

module.exports = { isStripeEnabled, createStripeCoupon, archiveStripeCoupon };
