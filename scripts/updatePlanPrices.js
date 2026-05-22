/**
 * scripts/updatePlanPrices.js
 *
 * Applies the amounts in config/planPricing.js to Stripe and to every
 * existing organisation.
 *
 * Stripe Price objects are immutable — you cannot edit the amount of an
 * existing price. So this script:
 *   1. Reads each current price ID from .env (config/stripePrices.js).
 *   2. Looks up its Stripe Product + currency + interval.
 *   3. Creates a NEW Stripe Price on the same product with the new amount.
 *   4. Migrates every organisation that has an active Stripe subscription
 *      onto the new price that matches its plan + billing cycle.
 *   5. Prints the 6 new price IDs — paste them into .env so future
 *      sign-ups use the new amounts.
 *
 * Usage:
 *   node scripts/updatePlanPrices.js            # dry run — shows what would change
 *   node scripts/updatePlanPrices.js --apply    # actually create prices + migrate
 *
 * Existing subscriptions are updated with proration_behavior: "none",
 * so no organisation is charged mid-cycle — the new amount takes effect
 * from their next renewal.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const connectDB = require("../config/db");
const Organisation = require("../models/organisation");
const stripePrices = require("../config/stripePrices");
const planPricing = require("../config/planPricing");

const APPLY = process.argv.includes("--apply");

// plan/cycle → env var name (mirrors config/stripePrices.js)
const ENV_KEYS = {
  basic: { monthly: "STRIPE_PRICE_BASIC_MONTHLY", annual: "STRIPE_PRICE_BASIC_ANNUAL" },
  professional: { monthly: "STRIPE_PRICE_PRO_MONTHLY", annual: "STRIPE_PRICE_PRO_ANNUAL" },
  enterprise: { monthly: "STRIPE_PRICE_ENT_MONTHLY", annual: "STRIPE_PRICE_ENT_ANNUAL" },
};

async function run() {
  console.log(`\n=== Plan price update — ${APPLY ? "APPLY MODE" : "DRY RUN"} ===\n`);

  const plans = ["basic", "professional", "enterprise"];
  const cycles = ["monthly", "annual"];

  // oldPriceId → newPriceId, and plan/cycle → newPriceId
  const newPriceByPlanCycle = {};
  const newPriceByOldId = {};

  for (const plan of plans) {
    newPriceByPlanCycle[plan] = {};
    for (const cycle of cycles) {
      const oldId = stripePrices[plan]?.[cycle];
      const amount = planPricing[plan]?.[cycle];

      if (!oldId) {
        console.warn(`! Skipping ${plan}/${cycle} — no current price ID in .env (${ENV_KEYS[plan][cycle]})`);
        continue;
      }
      if (!amount) {
        console.warn(`! Skipping ${plan}/${cycle} — no amount in config/planPricing.js`);
        continue;
      }

      const oldPrice = await stripe.prices.retrieve(oldId);
      const oldAmount = (oldPrice.unit_amount || 0) / 100;
      const interval = oldPrice.recurring?.interval || (cycle === "annual" ? "year" : "month");
      const currency = oldPrice.currency || planPricing.currency;

      console.log(`${plan}/${cycle}:  $${oldAmount} → $${amount}  (product ${oldPrice.product}, ${interval}ly, ${currency})`);

      if (!APPLY) {
        newPriceByPlanCycle[plan][cycle] = "(dry-run)";
        continue;
      }

      const newPrice = await stripe.prices.create({
        product: oldPrice.product,
        currency,
        unit_amount: Math.round(amount * 100),
        recurring: { interval },
        nickname: `${plan} ${cycle} — $${amount}`,
        metadata: { plan, cycle, replaces: oldId },
      });

      newPriceByPlanCycle[plan][cycle] = newPrice.id;
      newPriceByOldId[oldId] = newPrice.id;
      console.log(`   ✓ created new price ${newPrice.id}`);
    }
  }

  // ── Migrate existing organisations ──
  const orgs = await Organisation.find({
    stripeSubscriptionId: { $exists: true, $nin: [null, ""] },
  }).select("name slug plan billingCycle stripeSubscriptionId subscriptionStatus");

  console.log(`\n${orgs.length} organisation(s) with a Stripe subscription:\n`);

  let migrated = 0;
  for (const org of orgs) {
    const cycle = org.billingCycle || "monthly";
    const targetPriceId = newPriceByPlanCycle[org.plan]?.[cycle];
    const tag = `  ${org.name} (${org.slug}) — ${org.plan}/${cycle}`;

    if (!targetPriceId || targetPriceId === "(dry-run)") {
      console.log(`${tag}: would migrate to new ${org.plan}/${cycle} price`);
      continue;
    }

    try {
      const sub = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
      const item = sub.items?.data?.[0];
      if (!item) {
        console.log(`${tag}: ⚠ subscription has no line item — skipped`);
        continue;
      }
      if (item.price?.id === targetPriceId) {
        console.log(`${tag}: already on new price — skipped`);
        continue;
      }
      await stripe.subscriptions.update(org.stripeSubscriptionId, {
        items: [{ id: item.id, price: targetPriceId }],
        proration_behavior: "none", // new amount applies from next renewal
      });
      migrated++;
      console.log(`${tag}: ✓ migrated to ${targetPriceId}`);
    } catch (err) {
      console.log(`${tag}: ✗ failed — ${err.message}`);
    }
  }

  // ── Summary ──
  console.log("\n=== Summary ===");
  if (APPLY) {
    console.log(`Migrated ${migrated} subscription(s).`);
    console.log("\nUpdate these lines in NGOPlatformBE/.env so new sign-ups use the new prices:\n");
    for (const plan of plans) {
      for (const cycle of cycles) {
        const id = newPriceByPlanCycle[plan]?.[cycle];
        if (id && id !== "(dry-run)") console.log(`${ENV_KEYS[plan][cycle]}=${id}`);
      }
    }
  } else {
    console.log("Dry run only — no Stripe prices created, no subscriptions changed.");
    console.log("Re-run with --apply to make these changes.");
  }
  console.log("");
}

(async () => {
  try {
    await connectDB();
    await run();
  } catch (err) {
    console.error("Price update failed:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
})();
