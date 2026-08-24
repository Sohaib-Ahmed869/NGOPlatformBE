const Coupon = require("../models/coupon");
const writeAudit = require("../utils/writeAudit");
const stripeCouponService = require("../services/stripeCouponService");
const { emitToSuperAdmins } = require("../services/socket");
const { refreshRedemptions, reconcileRedemptions, hasRedemptionsLeft } = require("../utils/couponRedemptions");
const Plan = require("../models/plan");
const planPricing = require("../config/planPricing");
const input = require("../utils/operatorInput");

// Tell open operator consoles the coupon list moved (they cache it per session).
const announceCoupons = (code) => emitToSuperAdmins("coupon:updated", { code: code || null });

// Customers type this at checkout, so keep it to a plain token.
const RE_COUPON_CODE = /^[A-Z0-9][A-Z0-9_-]{1,38}[A-Z0-9]$/;

// One platform billing currency — an amount-off coupon in any other currency is
// rejected by Stripe when it meets the subscription.
const PLATFORM_CURRENCY = (planPricing.currency || "aud").toLowerCase();

/** GET /api/superadmin/coupons */
exports.listCoupons = async (req, res) => {
  try {
    const coupons = await Coupon.find().sort({ createdAt: -1 }).lean();
    // One Stripe call brings every redemption count up to date, so the console
    // (and the "never redeemed → deletable" rule) reflects reality.
    await reconcileRedemptions(coupons);
    res.json({ coupons, stripeEnabled: stripeCouponService.isStripeEnabled() });
  } catch (err) {
    console.error("List coupons error:", err);
    res.status(500).json({ error: "Failed to fetch coupons" });
  }
};

/**
 * Shared create/replace input check. Validates before anything touches Stripe —
 * Stripe rejects these outright, and a coupon that looks real in the console but
 * never synced is worse than a 400.
 * @returns {{error:string}|{values:object}}
 */
function parseCouponInput(body = {}) {
  const { code, description, type, value, currency, duration, durationInMonths, planCodes, maxRedemptions, redeemBy } = body;
  if (!code || !value) return { error: "code and value are required" };

  // A promotion code is typed by customers at checkout and appears in URLs, so
  // it has to be a plain token. Spaces and markup were both accepted before,
  // producing Stripe promotion codes nobody could actually enter.
  const normCode = String(code).toUpperCase().trim();
  if (!RE_COUPON_CODE.test(normCode)) {
    return { error: "Coupon code must be 3–40 characters, letters and numbers only (hyphens and underscores allowed)" };
  }

  const kind = type === "amount" ? "amount" : "percent";
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Discount value must be a positive number" };
  if (kind === "percent" && amount > 100) return { error: "A percent discount cannot exceed 100" };
  if (kind === "amount" && Math.round(amount * 100) !== amount * 100) {
    return { error: "An amount discount cannot have fractions of a cent" };
  }

  // An amount-off coupon must be in the same currency as the subscription it's
  // applied to, or Stripe refuses it at checkout. Defaulting to "usd" while the
  // platform bills in AUD produced coupons that looked live and never worked.
  const ccy = String(currency || PLATFORM_CURRENCY).toLowerCase().trim();
  if (!/^[a-z]{3}$/.test(ccy)) return { error: "Currency must be a 3-letter code like aud" };
  if (kind === "amount" && ccy !== PLATFORM_CURRENCY) {
    return { error: `An amount discount must be in ${PLATFORM_CURRENCY.toUpperCase()} — the currency the plans are billed in` };
  }

  // "0" is a truthy string, so a plain `maxRedemptions ? …` would store 0 —
  // a coupon nobody can ever redeem.
  const maxUses = maxRedemptions === "" || maxRedemptions == null ? null : Number(maxRedemptions);
  if (maxUses !== null && (!Number.isFinite(maxUses) || maxUses < 1)) {
    return { error: "Max redemptions must be at least 1, or left blank for unlimited" };
  }

  const repeating = duration === "repeating";
  let months = null;
  if (repeating) {
    months = Number(durationInMonths);
    if (!Number.isInteger(months) || months < 1 || months > 36) {
      return { error: "A repeating discount must run for 1–36 whole months" };
    }
  }

  let expiry = null;
  if (redeemBy) {
    expiry = new Date(redeemBy);
    if (Number.isNaN(expiry.getTime())) return { error: "Invalid expiry date" };
    // Compare against yesterday so "today" is still a usable expiry.
    if (expiry.getTime() < Date.now() - 24 * 60 * 60 * 1000) return { error: "Expiry date is in the past" };
  }

  const desc = input.text(description, "Description", { max: 300 });
  if (desc.error) return { error: desc.error };

  const plans = input.stringList(planCodes, "Plan whitelist", { max: 20, maxLength: 40 });
  if (plans.error) return { error: plans.error };

  return {
    values: {
      code: normCode,
      description: desc.value,
      type: kind,
      value: amount,
      currency: ccy,
      duration: ["once", "forever", "repeating"].includes(duration) ? duration : "once",
      durationInMonths: repeating ? months : null,
      planCodes: plans.value,
      maxRedemptions: maxUses,
      redeemBy: expiry,
    },
  };
}

/**
 * A whitelist naming a plan that doesn't exist produces a coupon that can never
 * apply to anything — it reads as configured in the console and silently fails
 * at checkout.
 * @returns {Promise<string|null>} an error message, or null
 */
async function checkPlanCodes(codes = []) {
  if (!codes.length) return null;
  const found = await Plan.find({ code: { $in: codes } }).select("code").lean();
  const known = new Set(found.map((p) => p.code));
  const missing = codes.filter((c) => !known.has(c));
  if (missing.length) return `No such plan: ${missing.join(", ")}`;
  return null;
}

/**
 * Flags a coupon whose Stripe half didn't land, so the console can say so.
 * Returns {} when everything synced (or when Stripe isn't configured at all —
 * that's a deliberate setup, not a failure to warn about on every save).
 */
function syncWarning(coupon) {
  if (!stripeCouponService.isStripeEnabled()) return {};
  if (!coupon.stripeCouponId) {
    return {
      stripeSynced: false,
      warning: `Saved, but it could not be created in Stripe — "${coupon.code}" will not apply at checkout. Run "npm run fix:stripe-catalog" once Stripe is reachable.`,
    };
  }
  if (!coupon.stripePromotionCodeId) {
    return {
      stripeSynced: false,
      warning: `Saved and created in Stripe, but the promotion code "${coupon.code}" could not be issued, so customers can't enter it. Run "npm run fix:stripe-catalog".`,
    };
  }
  return { stripeSynced: true };
}

/** Persist a coupon and best-effort sync it to Stripe (saves either way). */
async function createAndSync(values) {
  const coupon = new Coupon(values);
  try {
    const synced = await stripeCouponService.createStripeCoupon(coupon);
    coupon.stripeCouponId = synced.stripeCouponId;
    coupon.stripePromotionCodeId = synced.stripePromotionCodeId;
  } catch (e) {
    console.error("Stripe coupon sync failed (coupon saved unsynced):", e.message);
  }
  try {
    await coupon.save();
  } catch (e) {
    // The Stripe coupon exists by now, so a failed save (e.g. two operators
    // racing the same code past the duplicate check) would strand it there
    // forever. Take it back out before surfacing the error.
    if (coupon.stripeCouponId) {
      await stripeCouponService.archiveStripeCoupon(coupon).catch(() => {});
    }
    throw e;
  }
  return coupon;
}

/** POST /api/superadmin/coupons */
exports.createCoupon = async (req, res) => {
  try {
    const { error, values } = parseCouponInput(req.body);
    if (error) return res.status(400).json({ error });
    const planError = await checkPlanCodes(values.planCodes);
    if (planError) return res.status(400).json({ error: planError });
    if (await Coupon.findOne({ code: values.code })) {
      return res.status(409).json({ error: "Coupon code already exists" });
    }

    const coupon = await createAndSync(values);
    await writeAudit(req, "coupon.created", { targetType: "coupon", targetId: coupon.code, meta: { type: coupon.type, value: coupon.value } });
    announceCoupons(coupon.code);
    // Sync is best-effort, so a coupon can save while its Stripe half failed —
    // and a coupon with no Stripe promotion code silently does nothing at
    // checkout. Report that rather than a clean success.
    res.status(201).json({ coupon, ...syncWarning(coupon) });
  } catch (err) {
    // createAndSync already unwinds the Stripe half on a failed save; the unique
    // index losing a race is a conflict, not a server fault.
    if (input.isDuplicateKey(err)) {
      return res.status(409).json({ error: "Coupon code already exists" });
    }
    console.error("Create coupon error:", err);
    res.status(500).json({ error: "Failed to create coupon" });
  }
};

/**
 * PATCH /api/superadmin/coupons/:code   { description?, planCodes? }
 *
 * Only the fields that DON'T exist in Stripe's economics. A Stripe Coupon is
 * immutable apart from name/metadata — percent_off, amount_off, duration,
 * max_redemptions and redeem_by can never be changed after creation. To change
 * any of those, use /replace (archive + recreate).
 */
exports.updateCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findOne({ code: String(req.params.code).toUpperCase() });
    if (!coupon) return res.status(404).json({ error: "Coupon not found" });

    const { description, planCodes } = req.body || {};
    if (description === undefined && planCodes === undefined) {
      return res.status(400).json({ error: "Nothing to update" });
    }
    const before = { description: coupon.description, planCodes: [...(coupon.planCodes || [])] };
    if (description !== undefined) {
      const d = input.text(description, "Description", { max: 300 });
      if (d.error) return res.status(400).json({ error: d.error });
      coupon.description = d.value;
    }
    if (planCodes !== undefined) {
      const list = input.stringList(planCodes, "Plan whitelist", { max: 20, maxLength: 40 });
      if (list.error) return res.status(400).json({ error: list.error });
      const planError = await checkPlanCodes(list.value);
      if (planError) return res.status(400).json({ error: planError });
      coupon.planCodes = list.value;
    }
    await coupon.save();

    await writeAudit(req, "coupon.updated", {
      targetType: "coupon",
      targetId: coupon.code,
      meta: { before, after: { description: coupon.description, planCodes: coupon.planCodes } },
    });
    announceCoupons(coupon.code);
    res.json({ coupon });
  } catch (err) {
    console.error("Update coupon error:", err);
    res.status(500).json({ error: "Failed to update coupon" });
  }
};

/**
 * POST /api/superadmin/coupons/:code/replace   { ...new coupon fields }
 *
 * The honest version of "edit the discount": archive the original and create a
 * replacement. Tenants already carrying the old discount keep it — Stripe does
 * not strip a redeemed coupon from an existing subscription.
 */
exports.replaceCoupon = async (req, res) => {
  try {
    const original = await Coupon.findOne({ code: String(req.params.code).toUpperCase() });
    if (!original) return res.status(404).json({ error: "Coupon not found" });
    if (original.archivedAt) return res.status(400).json({ error: "That coupon is already archived" });

    const { error, values } = parseCouponInput(req.body);
    if (error) return res.status(400).json({ error });
    const planError = await checkPlanCodes(values.planCodes);
    if (planError) return res.status(400).json({ error: planError });

    const sameCode = values.code === original.code;
    if (!sameCode && (await Coupon.findOne({ code: values.code }))) {
      return res.status(409).json({ error: "Coupon code already exists" });
    }

    // Snapshot the old terms for the audit trail before anything changes.
    const from = {
      type: original.type,
      value: original.value,
      duration: original.duration,
      durationInMonths: original.durationInMonths,
      maxRedemptions: original.maxRedemptions,
      redeemBy: original.redeemBy,
      timesRedeemed: original.timesRedeemed || 0,
    };

    let created;
    if (!sameCode) {
      // Different code → create first, so a failure leaves the original live.
      created = await createAndSync(values);
      original.isActive = false;
      original.archivedAt = new Date();
      await original.save();
      await stripeCouponService.archiveStripeCoupon(original);
    } else {
      // Same code → keep ONE row. `code` is uniquely indexed, so an archived
      // copy can't sit alongside a live one; the terms are rewritten in place
      // and the before/after is preserved in the audit log instead. Stripe gets
      // a brand-new coupon either way because its coupons are immutable.
      await stripeCouponService.archiveStripeCoupon(original); // drops the old Stripe coupon
      Object.assign(original, values, {
        isActive: true,
        archivedAt: null,
        // The new Stripe coupon starts at zero redemptions, and
        // maxRedemptions is enforced against this counter.
        timesRedeemed: 0,
        stripeCouponId: "",
        stripePromotionCodeId: "",
      });
      try {
        const synced = await stripeCouponService.createStripeCoupon(original);
        original.stripeCouponId = synced.stripeCouponId;
        original.stripePromotionCodeId = synced.stripePromotionCodeId;
      } catch (e) {
        console.error("Stripe sync failed for the replacement (saved unsynced):", e.message);
      }
      await original.save();
      created = original;
    }

    await writeAudit(req, "coupon.replaced", {
      targetType: "coupon",
      targetId: created.code,
      meta: {
        replaced: original.code,
        inPlace: sameCode,
        from,
        to: { type: created.type, value: created.value, duration: created.duration },
      },
    });
    announceCoupons(created.code);
    res.status(201).json({ coupon: created, archived: sameCode ? null : original.code, inPlace: sameCode });
  } catch (err) {
    if (input.isDuplicateKey(err)) {
      return res.status(409).json({ error: "Coupon code already exists" });
    }
    console.error("Replace coupon error:", err);
    res.status(500).json({ error: "Failed to replace coupon" });
  }
};

/**
 * DELETE /api/superadmin/coupons/:code
 *
 * Hard delete, allowed ONLY for a coupon nobody has redeemed — for cleaning up
 * typos. Once a coupon has been used it's a financial record explaining why a
 * tenant pays what they pay, so it can only be archived.
 */
exports.deleteCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findOne({ code: String(req.params.code).toUpperCase() });
    if (!coupon) return res.status(404).json({ error: "Coupon not found" });

    // Re-check against Stripe rather than the stored mirror — this is
    // irreversible, so a stale zero must not be what authorises it.
    const used = await refreshRedemptions(coupon);
    if (used > 0) {
      return res.status(409).json({
        error: `${coupon.code} has been redeemed ${used} time${used === 1 ? "" : "s"} — archive it instead so the discount history is kept`,
      });
    }

    // Removes the Stripe coupon and deactivates its promotion code.
    await stripeCouponService.archiveStripeCoupon(coupon);
    await Coupon.deleteOne({ _id: coupon._id });

    await writeAudit(req, "coupon.deleted", {
      targetType: "coupon",
      targetId: coupon.code,
      meta: { type: coupon.type, value: coupon.value, neverRedeemed: true },
    });
    announceCoupons(coupon.code);
    res.json({ deleted: coupon.code });
  } catch (err) {
    console.error("Delete coupon error:", err);
    res.status(500).json({ error: "Failed to delete coupon" });
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
    announceCoupons(coupon.code);
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
