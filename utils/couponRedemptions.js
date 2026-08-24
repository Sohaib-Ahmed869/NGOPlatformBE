/**
 * Keeping `Coupon.timesRedeemed` honest.
 *
 * Stripe is the authority: it increments a coupon's `times_redeemed` when the
 * coupon is actually applied to a subscription, and it enforces
 * `max_redemptions` server-side. Our local field is a mirror that nothing in
 * this app ever incremented, so `maxRedemptions` checks were effectively
 * running against seed data. These helpers read the real number back and
 * persist it, so every decision point (checkout validation, applying the
 * discount, the console list, the delete guard) agrees with Stripe.
 */
const Coupon = require("../models/coupon");
const stripeCouponService = require("../services/stripeCouponService");

/**
 * Refresh ONE coupon's count from Stripe and persist any change.
 * Falls back to the stored value if Stripe is unreachable or doesn't have the
 * coupon (archiving deletes it there), so this never blocks a checkout.
 *
 * @param {object} coupon a Mongoose Coupon document
 * @returns {Promise<number>} the count to make decisions with
 */
async function refreshRedemptions(coupon) {
  if (!coupon) return 0;
  const stored = coupon.timesRedeemed || 0;
  if (!coupon.stripeCouponId) return stored;
  try {
    const live = await stripeCouponService.fetchRedemptionCount(coupon.stripeCouponId);
    if (live === null) return stored;
    if (live !== stored) {
      coupon.timesRedeemed = live;
      await coupon.save();
    }
    return live;
  } catch (err) {
    console.error(`Redemption refresh failed for ${coupon.code}:`, err.message);
    return stored;
  }
}

/**
 * Reconcile a whole list in one Stripe pass. Mutates the given objects (which
 * may be `.lean()` plain objects) so the response carries fresh numbers, and
 * writes the differences back.
 *
 * Best-effort: on any failure the stored counts are served unchanged rather
 * than failing the request.
 *
 * @param {object[]} coupons
 */
async function reconcileRedemptions(coupons = []) {
  if (!coupons.length) return;
  try {
    const counts = await stripeCouponService.fetchRedemptionCounts();
    if (!counts.size) return;
    const ops = [];
    for (const c of coupons) {
      if (!c.stripeCouponId) continue;
      const live = counts.get(c.stripeCouponId);
      // `undefined` means Stripe no longer has it (archived) — leave the
      // stored history alone rather than zeroing it.
      if (live === undefined || live === (c.timesRedeemed || 0)) continue;
      c.timesRedeemed = live;
      ops.push({ updateOne: { filter: { _id: c._id }, update: { $set: { timesRedeemed: live } } } });
    }
    if (ops.length) await Coupon.bulkWrite(ops);
  } catch (err) {
    console.error("Redemption reconcile failed (serving stored counts):", err.message);
  }
}

/** True when the coupon still has redemptions left. */
const hasRedemptionsLeft = (coupon, used) => !coupon.maxRedemptions || used < coupon.maxRedemptions;

module.exports = { refreshRedemptions, reconcileRedemptions, hasRedemptionsLeft };
