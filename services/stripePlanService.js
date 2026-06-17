/**
 * Stripe sync for dynamic SaaS plans (models/plan.js).
 *
 * Stripe Prices are immutable — editing an amount means creating a NEW Price on
 * the same Product. These helpers create products/prices for new plans, mint
 * fresh prices when an amount changes, archive a plan's Stripe objects, and
 * migrate existing subscribers onto a plan's current price.
 *
 * All functions degrade gracefully when STRIPE_SECRET_KEY is unset — the plan
 * is still persisted, just unsynced.
 */
const stripe = process.env.STRIPE_SECRET_KEY
  ? require("stripe")(process.env.STRIPE_SECRET_KEY)
  : null;
const planPricing = require("../config/planPricing");

const isStripeEnabled = () => !!stripe;

const intervalFor = (cycle) => (cycle === "annual" ? "year" : "month");

async function createPriceForCycle(productId, plan, cycle) {
  const amount = Number(plan.price?.[cycle]) || 0;
  if (amount <= 0) return ""; // a cycle priced at 0 has no Stripe Price
  const price = await stripe.prices.create({
    product: productId,
    currency: plan.currency || planPricing.currency || "usd",
    unit_amount: Math.round(amount * 100),
    recurring: { interval: intervalFor(cycle) },
    nickname: `${plan.code} ${cycle} — ${amount}`,
    metadata: { planCode: plan.code, cycle },
  });
  return price.id;
}

/** Create a Stripe Product + monthly/annual Prices for a brand-new plan. */
async function provisionPlan(plan) {
  if (!stripe) return { stripeProductId: "", stripePriceIds: { monthly: "", annual: "" } };
  const product = await stripe.products.create({
    name: plan.name,
    description: plan.description || undefined,
    metadata: { planCode: plan.code },
  });
  const monthly = await createPriceForCycle(product.id, plan, "monthly");
  const annual = await createPriceForCycle(product.id, plan, "annual");
  return { stripeProductId: product.id, stripePriceIds: { monthly, annual } };
}

/**
 * Mint NEW Stripe Prices for the cycles whose amount changed. The caller has
 * already applied the new amounts to `plan`. Returns { stripeProductId,
 * stripePriceIds:{ [cycle]: id } } for the changed cycles only.
 */
async function repriceChangedCycles(plan, changedCycles) {
  if (!stripe) return { stripeProductId: plan.stripeProductId || "", stripePriceIds: {} };

  let productId = plan.stripeProductId;
  // Resolve (or create) the product if the plan doesn't already have one.
  if (!productId) {
    const anyPrice = plan.stripePriceIds?.monthly || plan.stripePriceIds?.annual;
    if (anyPrice) {
      try {
        const pr = await stripe.prices.retrieve(anyPrice);
        productId = pr.product;
      } catch {
        /* fall through to create */
      }
    }
  }
  if (!productId) {
    const product = await stripe.products.create({
      name: plan.name,
      description: plan.description || undefined,
      metadata: { planCode: plan.code },
    });
    productId = product.id;
  }

  const stripePriceIds = {};
  for (const cycle of changedCycles) {
    stripePriceIds[cycle] = await createPriceForCycle(productId, plan, cycle);
  }
  return { stripeProductId: productId, stripePriceIds };
}

/** Deactivate a plan's Stripe Prices + Product (best-effort). */
async function archivePlanStripe(plan) {
  if (!stripe) return;
  try {
    for (const cycle of ["monthly", "annual"]) {
      const id = plan.stripePriceIds?.[cycle];
      if (id) await stripe.prices.update(id, { active: false });
    }
    if (plan.stripeProductId) {
      await stripe.products.update(plan.stripeProductId, { active: false });
    }
  } catch (err) {
    console.error("archivePlanStripe failed:", err.message);
  }
}

/**
 * Move every organisation currently on `plan.code` (with a live Stripe sub) onto
 * the plan's CURRENT price for their billing cycle. proration "none" (default)
 * applies the new amount from next renewal.
 */
async function migrateSubscribers(plan, { proration = "none" } = {}) {
  const result = { migrated: 0, failed: 0, skipped: 0 };
  if (!stripe) return result;
  const Organisation = require("../models/organisation");

  const orgs = await Organisation.find({
    plan: plan.code,
    stripeSubscriptionId: { $nin: [null, ""] },
  }).select("slug plan billingCycle stripeSubscriptionId");

  for (const org of orgs) {
    const cycle = org.billingCycle || "monthly";
    const targetPriceId = plan.stripePriceIds?.[cycle];
    if (!targetPriceId) {
      result.skipped++;
      continue;
    }
    try {
      const sub = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
      const item = sub.items?.data?.[0];
      if (!item || item.price?.id === targetPriceId) {
        result.skipped++;
        continue;
      }
      await stripe.subscriptions.update(org.stripeSubscriptionId, {
        items: [{ id: item.id, price: targetPriceId }],
        proration_behavior: proration,
      });
      result.migrated++;
    } catch (err) {
      console.error(`migrateSubscribers ${org.slug} failed:`, err.message);
      result.failed++;
    }
  }
  return result;
}

module.exports = {
  isStripeEnabled,
  provisionPlan,
  repriceChangedCycles,
  archivePlanStripe,
  migrateSubscribers,
};
