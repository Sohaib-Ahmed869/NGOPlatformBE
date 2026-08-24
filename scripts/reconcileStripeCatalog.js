/**
 * Reconcile the SaaS catalogue (plans + coupons) against Stripe.
 *
 * Plan and coupon sync is deliberately best-effort — a Stripe outage must not
 * stop an operator saving a plan. The cost is that a failed sync is invisible:
 * the row saves with empty (or stale) Stripe ids, the console reports success,
 * and the discount silently doesn't work at checkout weeks later. This script
 * is the counterpart to that trade-off.
 *
 *   node scripts/reconcileStripeCatalog.js            # report only (default)
 *   node scripts/reconcileStripeCatalog.js --fix      # repair what's broken
 *   node scripts/reconcileStripeCatalog.js --plans    # limit to plans
 *   node scripts/reconcileStripeCatalog.js --coupons  # limit to coupons
 *
 * Safe to re-run. Reads the Stripe key from the SuperAdmin console first, then
 * STRIPE_SECRET_KEY — so it reconciles against whichever account is actually
 * live (see services/platformStripe.js).
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const platformStripe = require("../services/platformStripe");
const stripePlanService = require("../services/stripePlanService");
const stripeCouponService = require("../services/stripeCouponService");
const Plan = require("../models/plan");
const Coupon = require("../models/coupon");

const ARGS = process.argv.slice(2);
const FIX = ARGS.includes("--fix");
const ONLY_PLANS = ARGS.includes("--plans");
const ONLY_COUPONS = ARGS.includes("--coupons");

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
};
const line = () => console.log("─".repeat(78));

const stats = { checked: 0, healthy: 0, broken: 0, fixed: 0, failed: 0 };

/** Does this Stripe object exist? Distinguishes "missing" from "API is down". */
async function exists(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    // A malformed/unknown id is a genuine "missing"; anything else (network,
    // auth, rate limit) must NOT be treated as missing or --fix would happily
    // recreate the entire catalogue against a healthy Stripe account.
    const missing =
      e?.statusCode === 404 ||
      e?.code === "resource_missing" ||
      /No such /i.test(e?.message || "");
    if (missing) return { ok: false, missing: true, error: e.message };
    throw e;
  }
}

/* ── plans ───────────────────────────────────────────────────────────────── */

async function checkPlan(plan, stripe) {
  const problems = [];

  let productOk = false;
  if (!plan.stripeProductId) {
    problems.push("no Stripe product id stored");
  } else {
    const res = await exists(() => stripe.products.retrieve(plan.stripeProductId));
    if (res.missing) problems.push(`product ${plan.stripeProductId} does not exist in Stripe`);
    else if (res.value.active === false) problems.push(`product ${plan.stripeProductId} is archived`);
    else productOk = true;
  }

  for (const cycle of ["monthly", "annual"]) {
    const amount = Number(plan.price?.[cycle]) || 0;
    const priceId = plan.stripePriceIds?.[cycle] || "";
    if (amount <= 0) {
      // A free cycle correctly has no Stripe Price.
      if (priceId) problems.push(`${cycle} is free but still points at ${priceId}`);
      continue;
    }
    if (!priceId) {
      problems.push(`${cycle} (${amount}) has no Stripe price id`);
      continue;
    }
    const res = await exists(() => stripe.prices.retrieve(priceId));
    if (res.missing) {
      problems.push(`${cycle} price ${priceId} does not exist in Stripe`);
      continue;
    }
    const pr = res.value;
    if (pr.active === false) problems.push(`${cycle} price ${priceId} is archived`);
    const expected = Math.round(amount * 100);
    if (pr.unit_amount !== expected) {
      problems.push(
        `${cycle} price is ${(pr.unit_amount / 100).toFixed(2)} in Stripe but ${amount.toFixed(2)} in the DB`,
      );
    }
    if (productOk && pr.product !== plan.stripeProductId) {
      problems.push(`${cycle} price belongs to product ${pr.product}, not ${plan.stripeProductId}`);
    }
  }
  return problems;
}

async function fixPlan(plan) {
  // Clear ids Stripe doesn't recognise so resolveProductId() falls through to
  // creating a fresh Product instead of updating one that isn't there.
  const stripe = platformStripe.stripe;
  if (plan.stripeProductId) {
    const res = await exists(() => stripe.products.retrieve(plan.stripeProductId));
    if (res.missing) plan.stripeProductId = "";
  }
  for (const cycle of ["monthly", "annual"]) {
    const id = plan.stripePriceIds?.[cycle];
    if (!id) continue;
    const res = await exists(() => stripe.prices.retrieve(id));
    const stale =
      res.missing ||
      res.value?.active === false ||
      res.value?.unit_amount !== Math.round((Number(plan.price?.[cycle]) || 0) * 100);
    if (stale) plan.stripePriceIds[cycle] = "";
  }

  const synced = await stripePlanService.resyncPlan(plan);
  plan.stripeProductId = synced.stripeProductId;
  plan.stripePriceIds.monthly = synced.stripePriceIds.monthly || "";
  plan.stripePriceIds.annual = synced.stripePriceIds.annual || "";
  await plan.save();
  return synced;
}

/* ── coupons ─────────────────────────────────────────────────────────────── */

async function checkCoupon(coupon, stripe) {
  const problems = [];

  if (!coupon.stripeCouponId) {
    problems.push("no Stripe coupon id stored (never synced)");
  } else {
    const res = await exists(() => stripe.coupons.retrieve(coupon.stripeCouponId));
    if (res.missing) {
      problems.push(`coupon ${coupon.stripeCouponId} does not exist in Stripe`);
    } else {
      const sc = res.value;
      if (sc.valid === false) problems.push("coupon is no longer valid in Stripe (expired or fully redeemed)");
      if (coupon.type === "percent" && sc.percent_off !== coupon.value) {
        problems.push(`percent is ${sc.percent_off} in Stripe but ${coupon.value} in the DB`);
      }
      if (coupon.type === "amount" && sc.amount_off !== Math.round(coupon.value * 100)) {
        problems.push(
          `amount is ${(sc.amount_off / 100).toFixed(2)} in Stripe but ${coupon.value.toFixed(2)} in the DB`,
        );
      }
      if (sc.duration !== coupon.duration) {
        problems.push(`duration is "${sc.duration}" in Stripe but "${coupon.duration}" in the DB`);
      }
    }
  }

  // The promotion code is what a customer actually types. A coupon with no
  // usable code is just as broken as no coupon at all.
  const promos = await stripe.promotionCodes.list({ code: coupon.code, limit: 100 });
  const live = promos.data.filter((p) => p.active);
  if (!live.length) {
    problems.push(`no active promotion code "${coupon.code}" in Stripe`);
  } else if (coupon.stripeCouponId && !live.some((p) => (p.coupon?.id || p.coupon) === coupon.stripeCouponId)) {
    problems.push(`promotion code "${coupon.code}" points at a different coupon`);
  }
  return problems;
}

async function fixCoupon(coupon) {
  // Stripe coupons are immutable, so repair always means "create a fresh one".
  const synced = await stripeCouponService.createStripeCoupon(coupon);
  if (!synced.stripeCouponId) throw new Error("Stripe did not return a coupon id");
  coupon.stripeCouponId = synced.stripeCouponId;
  coupon.stripePromotionCodeId = synced.stripePromotionCodeId;
  await coupon.save();
  if (!synced.stripePromotionCodeId) {
    throw new Error("coupon created but its promotion code could not be issued");
  }
  return synced;
}

/* ── driver ──────────────────────────────────────────────────────────────── */

async function run() {
  const src = platformStripe.describeSource();
  line();
  console.log(
    `Stripe: ${src.configured ? c.ok(`${src.mode} mode`) : c.bad("NOT CONFIGURED")}` +
      c.dim(` (from ${src.secretSource === "database" ? "the SuperAdmin console" : "STRIPE_SECRET_KEY"})`),
  );
  if (!src.configured) {
    console.log(c.bad("No Stripe key available — nothing to reconcile against."));
    return;
  }
  const stripe = platformStripe.stripe;
  const acct = await stripe.accounts.retrieve();
  console.log(`Account: ${acct.settings?.dashboard?.display_name || acct.email || acct.id} (${acct.id})`);
  console.log(FIX ? c.warn("Mode: FIX — missing objects will be created") : c.dim("Mode: report only (pass --fix to repair)"));

  if (!ONLY_COUPONS) {
    line();
    console.log("PLANS" + c.dim("  (active only — an archived plan is not on sale)"));
    const plans = await Plan.find({}).sort({ sortOrder: 1 });
    const inactive = plans.filter((p) => p.isActive === false);
    for (const plan of plans.filter((p) => p.isActive !== false)) {
      stats.checked++;
      const problems = await checkPlan(plan, stripe);
      if (!problems.length) {
        stats.healthy++;
        console.log(`  ${c.ok("✓")} ${plan.code.padEnd(14)} ${c.dim(plan.stripeProductId)}`);
        continue;
      }
      stats.broken++;
      console.log(`  ${c.bad("✗")} ${plan.code.padEnd(14)} ${plan.name}`);
      problems.forEach((p) => console.log(`      ${c.warn("•")} ${p}`));
      if (!FIX) continue;
      try {
        const synced = await fixPlan(plan);
        stats.fixed++;
        console.log(
          `      ${c.ok("→ fixed")} product=${synced.stripeProductId} monthly=${synced.stripePriceIds.monthly || "-"} annual=${synced.stripePriceIds.annual || "-"}`,
        );
      } catch (e) {
        stats.failed++;
        console.log(`      ${c.bad("→ FAILED")} ${e.message}`);
      }
    }
    // Named rather than silently dropped — a bounded scope that isn't stated
    // reads as "everything is covered" when it isn't.
    if (inactive.length) {
      console.log(c.dim(`  skipped ${inactive.length} archived plan(s): ${inactive.map((p) => p.code).join(", ")}`));
    }
  }

  if (!ONLY_PLANS) {
    line();
    console.log("COUPONS" + c.dim("  (active only — archived coupons are meant to be gone from Stripe)"));
    const coupons = await Coupon.find({ isActive: true, archivedAt: null }).sort({ code: 1 });
    for (const coupon of coupons) {
      stats.checked++;
      const problems = await checkCoupon(coupon, stripe);
      if (!problems.length) {
        stats.healthy++;
        console.log(`  ${c.ok("✓")} ${coupon.code.padEnd(16)} ${c.dim(coupon.stripeCouponId)}`);
        continue;
      }
      stats.broken++;
      console.log(`  ${c.bad("✗")} ${coupon.code.padEnd(16)} ${coupon.type === "percent" ? `${coupon.value}%` : `${coupon.value} ${coupon.currency}`}`);
      problems.forEach((p) => console.log(`      ${c.warn("•")} ${p}`));
      if (!FIX) continue;
      try {
        const synced = await fixCoupon(coupon);
        stats.fixed++;
        console.log(`      ${c.ok("→ fixed")} coupon=${synced.stripeCouponId} promo=${synced.stripePromotionCodeId}`);
        if (coupon.timesRedeemed > 0) {
          // The replacement starts at zero uses in Stripe, so a maxRedemptions
          // cap is effectively reset. Say so rather than let it surprise them.
          console.log(
            `      ${c.warn("note")} ${coupon.timesRedeemed} prior redemption(s) are not carried over to the new Stripe coupon`,
          );
        }
      } catch (e) {
        stats.failed++;
        console.log(`      ${c.bad("→ FAILED")} ${e.message}`);
      }
    }
  }

  line();
  console.log(
    `checked ${stats.checked} · ${c.ok(`${stats.healthy} healthy`)} · ` +
      `${stats.broken ? c.bad(`${stats.broken} broken`) : "0 broken"}` +
      (FIX ? ` · ${c.ok(`${stats.fixed} fixed`)}${stats.failed ? ` · ${c.bad(`${stats.failed} failed`)}` : ""}` : ""),
  );
  if (stats.broken && !FIX) {
    console.log(c.warn("Re-run with --fix to create the missing Stripe objects."));
  }
}

(async () => {
  try {
    await connectDB();
    await platformStripe.prime();
    await run();
  } catch (err) {
    console.error("Reconcile failed:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
})();
