/**
 * services/couponService.js — SaaS subscription discount coupons (Stripe-synced):
 * list, create, edit, replace, archive, restore, delete.
 *
 * Shared by the SuperAdmin console (controllers/couponController.js) and the
 * integration API (controllers/integration/billingController.js), so a coupon
 * created from either place is validated, Stripe-synced and audited the same.
 * Input uses the model's camelCase names; failures throw ServiceError.
 *
 * Stripe coupons are immutable apart from name/metadata, which is why editing is
 * split: `updateCoupon` for the fields that only live here (description, plan
 * whitelist) and `replaceCoupon` for the discount terms.
 */
const Coupon = require("../models/coupon");
const Plan = require("../models/plan");
const writeAudit = require("../utils/writeAudit");
const input = require("../utils/operatorInput");
const stripeCouponService = require("./stripeCouponService");
const planPricing = require("../config/planPricing");
const { emitToSuperAdmins } = require("./socket");
const { refreshRedemptions, reconcileRedemptions } = require("../utils/couponRedemptions");
const { ServiceError } = require("../utils/serviceError");

// Tell open operator consoles the coupon list moved (they cache it per session).
const announceCoupons = (code) => emitToSuperAdmins("coupon:updated", { code: code || null });

// Customers type this at checkout, so keep it to a plain token.
const RE_COUPON_CODE = /^[A-Z0-9][A-Z0-9_-]{1,38}[A-Z0-9]$/;

// One platform billing currency — an amount-off coupon in any other currency is
// rejected by Stripe when it meets the subscription.
const PLATFORM_CURRENCY = (planPricing.currency || "aud").toLowerCase();

const invalid = (message, field) => new ServiceError(400, "VALIDATION_ERROR", message, field ? { field } : undefined);
const codeTaken = () => new ServiceError(409, "COUPON_CODE_TAKEN", "Coupon code already exists");

async function loadCoupon(code) {
  const coupon = await Coupon.findOne({ code: String(code || "").toUpperCase().trim() });
  if (!coupon) throw new ServiceError(404, "COUPON_NOT_FOUND", "Coupon not found", { code: String(code || "") });
  return coupon;
}

/**
 * Shared create/replace input check. Validates before anything touches Stripe —
 * Stripe rejects these outright, and a coupon that looks real in the console but
 * never synced is worse than a 400.
 */
function parseCouponInput(body = {}) {
  const { code, description, type, value, currency, duration, durationInMonths, planCodes, maxRedemptions, redeemBy } = body || {};
  // `value == null` rather than `!value`: 0 is falsy, so a zero discount was
  // reported as "code and value are required". It is still rejected below, by
  // the message that actually describes the problem.
  if (!code || value == null || value === "") throw invalid("code and value are required", !code ? "code" : "value");

  // A promotion code is typed by customers at checkout and appears in URLs.
  const normCode = String(code).toUpperCase().trim();
  if (!RE_COUPON_CODE.test(normCode)) {
    throw invalid("Coupon code must be 3–40 characters, letters and numbers only (hyphens and underscores allowed)", "code");
  }

  if (type !== undefined && !["percent", "amount"].includes(type)) throw invalid("type must be percent or amount", "type");
  const kind = type === "amount" ? "amount" : "percent";
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw invalid("Discount value must be a positive number", "value");
  if (kind === "percent" && amount > 100) throw invalid("A percent discount cannot exceed 100", "value");
  if (kind === "amount" && Math.round(amount * 100) !== amount * 100) throw invalid("An amount discount cannot have fractions of a cent", "value");

  // Defaulting to "usd" while the platform bills in AUD produced coupons that
  // looked live and never worked.
  const ccy = String(currency || PLATFORM_CURRENCY).toLowerCase().trim();
  if (!/^[a-z]{3}$/.test(ccy)) throw invalid("Currency must be a 3-letter code like aud", "currency");
  if (kind === "amount" && ccy !== PLATFORM_CURRENCY) {
    throw invalid(`An amount discount must be in ${PLATFORM_CURRENCY.toUpperCase()} — the currency the plans are billed in`, "currency");
  }

  // "0" is a truthy string, so a plain `maxRedemptions ? …` would store 0 — a
  // coupon nobody can ever redeem.
  const maxUses = maxRedemptions === "" || maxRedemptions == null ? null : Number(maxRedemptions);
  if (maxUses !== null && (!Number.isFinite(maxUses) || maxUses < 1)) {
    throw invalid("Max redemptions must be at least 1, or left blank for unlimited", "max_redemptions");
  }

  if (duration !== undefined && !["once", "forever", "repeating"].includes(duration)) {
    throw invalid("duration must be once, forever or repeating", "duration");
  }
  const repeating = duration === "repeating";
  let months = null;
  if (repeating) {
    months = Number(durationInMonths);
    if (!Number.isInteger(months) || months < 1 || months > 36) throw invalid("A repeating discount must run for 1–36 whole months", "duration_in_months");
  }

  let expiry = null;
  if (redeemBy) {
    expiry = new Date(redeemBy);
    if (Number.isNaN(expiry.getTime())) throw invalid("Invalid expiry date", "redeem_by");
    // Compare against yesterday so "today" is still a usable expiry.
    if (expiry.getTime() < Date.now() - 24 * 60 * 60 * 1000) throw invalid("Expiry date is in the past", "redeem_by");
  }

  const desc = input.text(description, "Description", { max: 300 });
  if (desc.error) throw invalid(desc.error, "description");
  const plans = input.stringList(planCodes, "Plan whitelist", { max: 20, maxLength: 40 });
  if (plans.error) throw invalid(plans.error, "plan_codes");

  return {
    code: normCode,
    description: desc.value,
    type: kind,
    value: amount,
    currency: ccy,
    duration: duration || "once",
    durationInMonths: repeating ? months : null,
    planCodes: plans.value,
    maxRedemptions: maxUses,
    redeemBy: expiry,
  };
}

/** A whitelist naming a plan that doesn't exist makes a coupon that never applies. */
async function assertPlanCodes(codes = []) {
  if (!codes.length) return;
  const found = await Plan.find({ code: { $in: codes } }).select("code").lean();
  const known = new Set(found.map((p) => p.code));
  const missing = codes.filter((c) => !known.has(c));
  if (missing.length) throw new ServiceError(400, "PLAN_NOT_FOUND", `No such plan: ${missing.join(", ")}`, { field: "plan_codes", missing });
}

/**
 * Whether the coupon's Stripe half landed. `{}` when Stripe isn't configured —
 * a deliberate setup, not a failure to warn about on every save.
 * @returns {{stripeSynced?:boolean, warning?:string}}
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
    // The Stripe coupon exists by now, so a failed save (two operators racing
    // the same code past the duplicate check) would strand it there forever.
    if (coupon.stripeCouponId) await stripeCouponService.archiveStripeCoupon(coupon).catch(() => {});
    if (input.isDuplicateKey(e)) throw codeTaken();
    throw e;
  }
  return coupon;
}

/** Every coupon, newest first, with redemption counts brought up to date from Stripe. */
async function listCoupons() {
  const coupons = await Coupon.find().sort({ createdAt: -1 }).lean();
  await reconcileRedemptions(coupons);
  return { coupons, stripeEnabled: stripeCouponService.isStripeEnabled() };
}

async function getCoupon(code) {
  return loadCoupon(code);
}

/** @returns {Promise<{coupon:object, sync:{stripeSynced?:boolean, warning?:string}}>} */
async function createCoupon(body, req) {
  const values = parseCouponInput(body);
  await assertPlanCodes(values.planCodes);
  if (await Coupon.findOne({ code: values.code })) throw codeTaken();

  const coupon = await createAndSync(values);
  await writeAudit(req, "coupon.created", { targetType: "coupon", targetId: coupon.code, meta: { type: coupon.type, value: coupon.value } });
  announceCoupons(coupon.code);
  return { coupon, sync: syncWarning(coupon) };
}

/** Edit the fields that don't exist in Stripe's economics: `description`, `planCodes`. */
async function updateCoupon(code, { description, planCodes } = {}, req) {
  const coupon = await loadCoupon(code);
  if (description === undefined && planCodes === undefined) throw invalid("Nothing to update");

  const before = { description: coupon.description, planCodes: [...(coupon.planCodes || [])] };
  if (description !== undefined) {
    const d = input.text(description, "Description", { max: 300 });
    if (d.error) throw invalid(d.error, "description");
    coupon.description = d.value;
  }
  if (planCodes !== undefined) {
    const list = input.stringList(planCodes, "Plan whitelist", { max: 20, maxLength: 40 });
    if (list.error) throw invalid(list.error, "plan_codes");
    await assertPlanCodes(list.value);
    coupon.planCodes = list.value;
  }
  await coupon.save();

  await writeAudit(req, "coupon.updated", {
    targetType: "coupon",
    targetId: coupon.code,
    meta: { before, after: { description: coupon.description, planCodes: coupon.planCodes } },
  });
  announceCoupons(coupon.code);
  return { coupon };
}

/**
 * The honest version of "edit the discount": archive the original and create a
 * replacement. Tenants already carrying the old discount keep it — Stripe does
 * not strip a redeemed coupon from an existing subscription.
 * @returns {Promise<{coupon:object, archived:string|null, inPlace:boolean, sync:object}>}
 */
async function replaceCoupon(code, body, req) {
  const original = await loadCoupon(code);
  if (original.archivedAt) throw new ServiceError(409, "COUPON_ARCHIVED", "That coupon is already archived");

  const values = parseCouponInput(body);
  await assertPlanCodes(values.planCodes);
  const sameCode = values.code === original.code;
  if (!sameCode && (await Coupon.findOne({ code: values.code }))) throw codeTaken();

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
    // Same code → keep ONE row (`code` is uniquely indexed). The terms are
    // rewritten in place and the before/after kept in the audit log. Stripe
    // gets a brand-new coupon either way because its coupons are immutable.
    await stripeCouponService.archiveStripeCoupon(original);
    Object.assign(original, values, {
      isActive: true,
      archivedAt: null,
      // The new Stripe coupon starts at zero; maxRedemptions is enforced against this.
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
    meta: { replaced: original.code, inPlace: sameCode, from, to: { type: created.type, value: created.value, duration: created.duration } },
  });
  announceCoupons(created.code);
  return { coupon: created, archived: sameCode ? null : original.code, inPlace: sameCode, sync: syncWarning(created) };
}

/**
 * Hard delete, ONLY for a coupon nobody has redeemed (typo cleanup). Once used
 * it's a financial record explaining why a tenant pays what they pay.
 */
async function deleteCoupon(code, req) {
  const coupon = await loadCoupon(code);
  // Re-check against Stripe rather than the stored mirror — this is irreversible.
  const used = await refreshRedemptions(coupon);
  if (used > 0) {
    throw new ServiceError(
      409,
      "COUPON_REDEEMED",
      `${coupon.code} has been redeemed ${used} time${used === 1 ? "" : "s"} — archive it instead so the discount history is kept`,
      { times_redeemed: used },
    );
  }
  await stripeCouponService.archiveStripeCoupon(coupon);
  await Coupon.deleteOne({ _id: coupon._id });
  await writeAudit(req, "coupon.deleted", { targetType: "coupon", targetId: coupon.code, meta: { type: coupon.type, value: coupon.value, neverRedeemed: true } });
  announceCoupons(coupon.code);
  return { deleted: coupon.code };
}

/** Take a coupon out of circulation (deletes the Stripe coupon; the row is kept). */
async function archiveCoupon(code, req) {
  const coupon = await loadCoupon(code);
  coupon.isActive = false;
  coupon.archivedAt = new Date();
  await coupon.save();
  await stripeCouponService.archiveStripeCoupon(coupon);
  await writeAudit(req, "coupon.archived", { targetType: "coupon", targetId: coupon.code });
  announceCoupons(coupon.code);
  return { coupon };
}

/**
 * Put an archived coupon back into circulation. Not a mirror image of archive:
 * a deleted Stripe Coupon can't be undeleted, so this CREATES a new Stripe
 * Coupon + Promotion Code with the same terms. Those terms must be legal again
 * now — an expiry in the past, exhausted redemptions or a >100% discount
 * (pre-validation coupons exist) each block it by name; the fix is Replace.
 */
async function restoreCoupon(code, req) {
  const coupon = await loadCoupon(code);
  if (!coupon.archivedAt && coupon.isActive) throw new ServiceError(409, "COUPON_ALREADY_ACTIVE", `${coupon.code} is already active`);

  const blockers = [];
  if (coupon.type === "percent" && Number(coupon.value) > 100) blockers.push(`its ${coupon.value}% discount is above the 100% Stripe allows`);
  if (coupon.redeemBy && new Date(coupon.redeemBy).getTime() <= Date.now()) {
    blockers.push(`it expired on ${new Date(coupon.redeemBy).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })}`);
  }
  // Trust Stripe's count over the local mirror where we still have the id.
  const used = coupon.stripeCouponId ? await refreshRedemptions(coupon).catch(() => coupon.timesRedeemed || 0) : coupon.timesRedeemed || 0;
  if (coupon.maxRedemptions && used >= coupon.maxRedemptions) blockers.push(`it has already been redeemed ${used} of ${coupon.maxRedemptions} times`);
  if (blockers.length) {
    const reasons = blockers.length > 1 ? `${blockers.slice(0, -1).join(", ")} and ${blockers[blockers.length - 1]}` : blockers[0];
    throw new ServiceError(400, "COUPON_NOT_RESTORABLE", `${coupon.code} can't be restored as it stands: ${reasons}.`, {
      hint: "Use Replace to reissue this code with new terms.",
    });
  }

  let synced;
  try {
    synced = await stripeCouponService.createStripeCoupon(coupon);
  } catch (e) {
    console.error("Stripe coupon restore failed:", e.message);
    throw new ServiceError(502, "STRIPE_UPDATE_FAILED", `Stripe would not recreate ${coupon.code}: ${e.message}`);
  }
  coupon.stripeCouponId = synced.stripeCouponId;
  coupon.stripePromotionCodeId = synced.stripePromotionCodeId;
  coupon.isActive = true;
  coupon.archivedAt = null;
  await coupon.save();

  await writeAudit(req, "coupon.restored", { targetType: "coupon", targetId: coupon.code, meta: { stripeCouponId: coupon.stripeCouponId, timesRedeemed: used } });
  announceCoupons(coupon.code);
  return { coupon, sync: syncWarning(coupon) };
}

module.exports = {
  PLATFORM_CURRENCY,
  listCoupons,
  getCoupon,
  createCoupon,
  updateCoupon,
  replaceCoupon,
  deleteCoupon,
  archiveCoupon,
  restoreCoupon,
};
