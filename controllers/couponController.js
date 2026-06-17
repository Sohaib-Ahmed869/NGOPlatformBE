const Coupon = require("../models/coupon");
const writeAudit = require("../utils/writeAudit");
const stripeCouponService = require("../services/stripeCouponService");

/** GET /api/superadmin/coupons */
exports.listCoupons = async (req, res) => {
  try {
    const coupons = await Coupon.find().sort({ createdAt: -1 });
    res.json({ coupons, stripeEnabled: stripeCouponService.isStripeEnabled() });
  } catch (err) {
    console.error("List coupons error:", err);
    res.status(500).json({ error: "Failed to fetch coupons" });
  }
};

/** POST /api/superadmin/coupons */
exports.createCoupon = async (req, res) => {
  try {
    const { code, description, type, value, currency, duration, durationInMonths, planCodes, maxRedemptions, redeemBy } = req.body;
    if (!code || !value) return res.status(400).json({ error: "code and value are required" });
    const normCode = String(code).toUpperCase().trim();
    if (await Coupon.findOne({ code: normCode })) {
      return res.status(409).json({ error: "Coupon code already exists" });
    }

    const coupon = new Coupon({
      code: normCode,
      description: description || "",
      type: type === "amount" ? "amount" : "percent",
      value: Number(value),
      currency: (currency || "usd").toLowerCase(),
      duration: ["once", "forever", "repeating"].includes(duration) ? duration : "once",
      durationInMonths: duration === "repeating" ? Number(durationInMonths) || 1 : null,
      planCodes: Array.isArray(planCodes) ? planCodes.filter(Boolean) : [],
      maxRedemptions: maxRedemptions ? Number(maxRedemptions) : null,
      redeemBy: redeemBy ? new Date(redeemBy) : null,
    });

    try {
      const synced = await stripeCouponService.createStripeCoupon(coupon);
      coupon.stripeCouponId = synced.stripeCouponId;
      coupon.stripePromotionCodeId = synced.stripePromotionCodeId;
    } catch (e) {
      console.error("Stripe coupon sync failed (coupon saved unsynced):", e.message);
    }

    await coupon.save();
    await writeAudit(req, "coupon.created", { targetType: "coupon", targetId: coupon.code, meta: { type: coupon.type, value: coupon.value } });
    res.status(201).json({ coupon });
  } catch (err) {
    console.error("Create coupon error:", err);
    res.status(500).json({ error: "Failed to create coupon" });
  }
};

/** POST /api/superadmin/coupons/:code/archive */
exports.archiveCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findOne({ code: String(req.params.code).toUpperCase() });
    if (!coupon) return res.status(404).json({ error: "Coupon not found" });
    coupon.isActive = false;
    coupon.archivedAt = new Date();
    await coupon.save();
    await stripeCouponService.archiveStripeCoupon(coupon);
    await writeAudit(req, "coupon.archived", { targetType: "coupon", targetId: coupon.code });
    res.json({ coupon });
  } catch (err) {
    console.error("Archive coupon error:", err);
    res.status(500).json({ error: "Failed to archive coupon" });
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
    if (coupon.maxRedemptions && coupon.timesRedeemed >= coupon.maxRedemptions) {
      return res.status(400).json({ valid: false, error: "Coupon fully redeemed" });
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
