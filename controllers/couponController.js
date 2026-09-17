const Coupon = require("../models/coupon");
const couponService = require("../services/couponService");
const { refreshRedemptions, hasRedemptionsLeft } = require("../utils/couponRedemptions");
const { isServiceError } = require("../utils/serviceError");

// Validation, Stripe sync and audit for every operator action live in
// services/couponService.js, shared with the integration API. These handlers
// only translate to the console's `{ error }` / `{ coupon, stripeSynced, warning }` shape.

function sendCouponError(res, err, fallback) {
  if (isServiceError(err)) {
    // `hint` (restore) is read by the console at the top level.
    const { field, ...details } = err.details || {};
    return res.status(err.status).json({ error: err.message, code: err.code, ...details });
  }
  console.error(`${fallback}:`, err);
  return res.status(500).json({ error: fallback });
}

/** GET /api/superadmin/coupons */
exports.listCoupons = async (req, res) => {
  try {
    res.json(await couponService.listCoupons());
  } catch (err) {
    sendCouponError(res, err, "Failed to fetch coupons");
  }
};

/** POST /api/superadmin/coupons */
exports.createCoupon = async (req, res) => {
  try {
    const { coupon, sync } = await couponService.createCoupon(req.body, req);
    // Sync is best-effort: a coupon with no Stripe promotion code silently does
    // nothing at checkout, so that is reported rather than a clean success.
    res.status(201).json({ coupon, ...sync });
  } catch (err) {
    sendCouponError(res, err, "Failed to create coupon");
  }
};

/** PATCH /api/superadmin/coupons/:code   { description?, planCodes? } — terms go through /replace. */
exports.updateCoupon = async (req, res) => {
  try {
    const { coupon } = await couponService.updateCoupon(req.params.code, req.body || {}, req);
    res.json({ coupon });
  } catch (err) {
    sendCouponError(res, err, "Failed to update coupon");
  }
};

/** POST /api/superadmin/coupons/:code/replace   { ...new coupon fields } */
exports.replaceCoupon = async (req, res) => {
  try {
    const { coupon, archived, inPlace } = await couponService.replaceCoupon(req.params.code, req.body, req);
    res.status(201).json({ coupon, archived, inPlace });
  } catch (err) {
    sendCouponError(res, err, "Failed to replace coupon");
  }
};

/** DELETE /api/superadmin/coupons/:code — only a never-redeemed coupon. */
exports.deleteCoupon = async (req, res) => {
  try {
    res.json(await couponService.deleteCoupon(req.params.code, req));
  } catch (err) {
    sendCouponError(res, err, "Failed to delete coupon");
  }
};

/** POST /api/superadmin/coupons/:code/archive */
exports.archiveCoupon = async (req, res) => {
  try {
    const { coupon } = await couponService.archiveCoupon(req.params.code, req);
    res.json({ coupon });
  } catch (err) {
    sendCouponError(res, err, "Failed to archive coupon");
  }
};

/** POST /api/superadmin/coupons/:code/restore — recreates the Stripe coupon. */
exports.restoreCoupon = async (req, res) => {
  try {
    const { coupon, sync } = await couponService.restoreCoupon(req.params.code, req);
    res.json({ coupon, ...sync });
  } catch (err) {
    sendCouponError(res, err, "Failed to restore coupon");
  }
};

/**
 * GET /api/saas/coupon/:code?plan=xxx   (public — pricing/registration page)
 * Validates a coupon and returns its discount, without exposing Stripe ids.
 */
exports.validateCoupon = async (req, res) => {
  try {
    const { plan } = req.query;
    const coupon = await Coupon.findOne({ code: String(req.params.code).toUpperCase().trim(), isActive: true });
    if (!coupon) return res.status(404).json({ valid: false, error: "Invalid coupon" });
    if (coupon.redeemBy && new Date(coupon.redeemBy) < new Date()) {
      return res.status(400).json({ valid: false, error: "Coupon expired" });
    }
    // Only capped coupons need the live lookup, so uncapped ones stay a pure
    // DB read. Without this the check ran against a counter nothing updates.
    if (coupon.maxRedemptions) {
      const used = await refreshRedemptions(coupon);
      if (!hasRedemptionsLeft(coupon, used)) {
        return res.status(400).json({ valid: false, error: "Coupon fully redeemed" });
      }
    }
    if (plan && coupon.planCodes?.length && !coupon.planCodes.includes(plan)) {
      return res.status(400).json({ valid: false, error: "Not valid for this plan" });
    }
    res.json({
      valid: true,
      code: coupon.code,
      type: coupon.type,
      value: coupon.value,
      currency: coupon.currency,
      description: coupon.description,
    });
  } catch (err) {
    console.error("Validate coupon error:", err);
    res.status(500).json({ valid: false, error: "Failed to validate coupon" });
  }
};
