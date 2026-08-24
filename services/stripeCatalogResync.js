/**
 * Re-point the SaaS catalogue at whichever Stripe account is currently active.
 *
 * Why this exists: Plan.stripeProductId / stripePriceIds and Coupon.stripeCouponId
 * are ids that live inside ONE Stripe account. Change the platform's secret key
 * to a different account and every one of them silently becomes a dangling
 * reference — tenant signup then fails at checkout with "No such price", weeks
 * of subscriptions can't renew, and nothing in the console hints at the cause.
 *
 * scripts/reconcileStripeCatalog.js does the same repair from the CLI. This is
 * the in-request version, used by the console's account-switch flow so the
 * operator repairs the catalogue in the same breath as swapping the key rather
 * than discovering the breakage from a customer.
 *
 * Everything here is idempotent: an id that still resolves in the active account
 * is left alone, so switching back to a previous account is a no-op.
 */
const platformStripe = require("../services/platformStripe");
const stripePlanService = require("./stripePlanService");
const stripeCouponService = require("./stripeCouponService");
const Plan = require("../models/plan");
const Coupon = require("../models/coupon");

/**
 * Does this Stripe object exist in the ACTIVE account? Distinguishes "missing"
 * from "the API is unreachable" — treating a network blip as missing would
 * recreate a healthy catalogue and orphan every live subscription's price.
 */
async function probe(fn) {
  try {
    await fn();
    return { present: true };
  } catch (e) {
    const missing =
      e?.statusCode === 404 || e?.code === "resource_missing" || /No such /i.test(e?.message || "");
    if (missing) return { present: false };
    throw e;
  }
}

/**
 * What the catalogue currently references — shown to the operator BEFORE they
 * confirm an account switch, so "this will break 4 plans and 2 coupons" is
 * visible at the moment of decision rather than afterwards.
 *
 * Counts stored ids only; it deliberately makes no Stripe calls, because it runs
 * while the key is still being decided and must never fail the save.
 */
async function summarize() {
  const [plans, coupons] = await Promise.all([
    Plan.find({ stripeProductId: { $nin: ["", null] } }).select("code name").lean(),
    Coupon.find({ isActive: true, stripeCouponId: { $nin: ["", null] } }).select("code").lean(),
  ]);
  return {
    plans: plans.length,
    coupons: coupons.length,
    planNames: plans.map((p) => p.name || p.code),
    couponCodes: coupons.map((c) => c.code),
  };
}

/** Repair every plan whose product/prices don't resolve in the active account. */
async function resyncPlans(report) {
  const stripe = platformStripe.stripe;
  const plans = await Plan.find({});

  for (const plan of plans) {
    try {
      let stale = false;

      if (plan.stripeProductId) {
        const res = await probe(() => stripe.products.retrieve(plan.stripeProductId));
        if (!res.present) {
          plan.stripeProductId = "";
          stale = true;
        }
      } else if (plan.isActive !== false) {
        stale = true; // never provisioned, or cleared by an earlier partial run
      }

      for (const cycle of ["monthly", "annual"]) {
        const id = plan.stripePriceIds?.[cycle];
        if (!id) continue;
        const res = await probe(() => stripe.prices.retrieve(id));
        if (!res.present) {
          plan.stripePriceIds[cycle] = "";
          stale = true;
        }
      }

      if (!stale) {
        report.plans.unchanged.push(plan.code);
        continue;
      }

      const synced = await stripePlanService.resyncPlan(plan);
      plan.stripeProductId = synced.stripeProductId;
      plan.stripePriceIds.monthly = synced.stripePriceIds.monthly || "";
      plan.stripePriceIds.annual = synced.stripePriceIds.annual || "";
      await plan.save();
      report.plans.repaired.push(plan.code);
    } catch (e) {
      // One bad plan must not abort the rest — a half-migrated catalogue is
      // worse than a fully-reported partial one.
      report.plans.failed.push({ code: plan.code, error: e.message });
    }
  }
}

/** Repair every active coupon whose Stripe coupon doesn't resolve. */
async function resyncCoupons(report) {
  const stripe = platformStripe.stripe;
  const coupons = await Coupon.find({ isActive: true });

  for (const coupon of coupons) {
    try {
      if (coupon.stripeCouponId) {
        const res = await probe(() => stripe.coupons.retrieve(coupon.stripeCouponId));
        if (res.present) {
          report.coupons.unchanged.push(coupon.code);
          continue;
        }
      }
      // Stripe coupons are immutable, so repair always means creating a fresh
      // one (and a fresh promotion code) in the active account.
      const synced = await stripeCouponService.createStripeCoupon(coupon);
      if (!synced.stripeCouponId) throw new Error("Stripe did not return a coupon id");
      coupon.stripeCouponId = synced.stripeCouponId;
      coupon.stripePromotionCodeId = synced.stripePromotionCodeId;
      await coupon.save();
      if (!synced.stripePromotionCodeId) {
        throw new Error("coupon created but its promotion code could not be issued");
      }
      report.coupons.repaired.push(coupon.code);
    } catch (e) {
      report.coupons.failed.push({ code: coupon.code, error: e.message });
    }
  }
}

/**
 * Re-create anything the active Stripe account doesn't recognise.
 * Returns a report the console renders verbatim — never throws for a single
 * broken row, so the operator always sees what did and didn't survive.
 */
async function resync() {
  const report = {
    plans: { repaired: [], unchanged: [], failed: [] },
    coupons: { repaired: [], unchanged: [], failed: [] },
  };
  if (!platformStripe.isStripeConfigured()) return report;

  await resyncPlans(report);
  await resyncCoupons(report);
  return report;
}

module.exports = { summarize, resync };
