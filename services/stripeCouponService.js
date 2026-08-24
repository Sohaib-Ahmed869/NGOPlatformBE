/**
 * Stripe sync for SaaS coupons. Creates a Stripe Coupon plus a Promotion Code
 * (so the human-readable code is enterable at checkout). Degrades gracefully
 * when no Stripe key is configured.
 *
 * The key comes from the SuperAdmin console (Platform Settings → Stripe) or
 * STRIPE_SECRET_KEY. The guard is a CALL, not a captured boolean, so saving a
 * key in the console enables syncing without a restart.
 */
const { stripe, isStripeConfigured } = require("./platformStripe");

const isStripeEnabled = () => isStripeConfigured();

async function createStripeCoupon(coupon) {
  if (!isStripeEnabled()) return { stripeCouponId: "", stripePromotionCodeId: "" };

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
  const promo = await createPromotionCode(c.id, coupon.code);
  return { stripeCouponId: c.id, stripePromotionCodeId: promo?.id || "" };
}

/**
 * Mint the human-readable promotion code for a coupon.
 *
 * Stripe requires the code string to be unique per account, and promotion codes
 * can only be DEACTIVATED, never deleted. So a coupon that was created, removed
 * and created again — or one recreated by the reconcile script — collides with
 * its own leftover code. Retire the stale one and retry, otherwise the coupon
 * exists in Stripe with no code a customer can actually type at checkout.
 */
async function createPromotionCode(stripeCouponId, code) {
  try {
    return await stripe.promotionCodes.create({ coupon: stripeCouponId, code });
  } catch (e) {
    if (!/already exists|code.*taken|be unique/i.test(e.message || "")) {
      console.error("Promotion code create failed:", e.message);
      return null;
    }
    try {
      const existing = await stripe.promotionCodes.list({ code, limit: 100 });
      for (const p of existing.data) {
        if (p.active) await stripe.promotionCodes.update(p.id, { active: false });
      }
      return await stripe.promotionCodes.create({ coupon: stripeCouponId, code });
    } catch (retryErr) {
      console.error(`Promotion code "${code}" could not be reissued:`, retryErr.message);
      return null;
    }
  }
}

async function archiveStripeCoupon(coupon) {
  if (!isStripeEnabled()) return;
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

/**
 * Stripe owns the redemption count: it increments `times_redeemed` whenever a
 * coupon is actually applied to a subscription, and enforces `max_redemptions`
 * itself. Nothing in this app increments our local mirror, so these read the
 * real numbers back.
 *
 * Note there's no non-Stripe fallback by design — a coupon with no
 * `stripeCouponId` is never applied at checkout, so it can't be redeemed.
 */

/** Live times_redeemed for ONE coupon, or null if Stripe doesn't have it. */
async function fetchRedemptionCount(stripeCouponId) {
  if (!isStripeEnabled() || !stripeCouponId) return null;
  try {
    const c = await stripe.coupons.retrieve(stripeCouponId);
    return c?.times_redeemed || 0;
  } catch (e) {
    // Archiving deletes the Stripe coupon, so a 404 here is expected and just
    // means "no live count" rather than an error worth surfacing.
    if (e?.statusCode === 404 || e?.code === "resource_missing") return null;
    throw e;
  }
}

/**
 * Every coupon's live count in one pass — a handful of list calls instead of
 * one retrieve per coupon.
 * @returns {Promise<Map<string, number>>} stripeCouponId → times_redeemed
 */
async function fetchRedemptionCounts() {
  const map = new Map();
  if (!isStripeEnabled()) return map;
  let startingAfter;
  // Bounded pagination: 10 pages × 100 is far more coupons than a platform
  // realistically runs, and it can't spin forever on a bad response.
  for (let page = 0; page < 10; page++) {
    const res = await stripe.coupons.list({ limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    for (const c of res.data) map.set(c.id, c.times_redeemed || 0);
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }
  return map;
}

module.exports = {
  isStripeEnabled,
  createStripeCoupon,
  createPromotionCode,
  archiveStripeCoupon,
  fetchRedemptionCount,
  fetchRedemptionCounts,
};
