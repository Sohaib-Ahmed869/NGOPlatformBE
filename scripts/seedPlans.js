/**
 * scripts/seedPlans.js
 *
 * One-time seed of the dynamic Plan collection from the legacy static config
 * (config/planPricing.js + config/planLimits.js + config/stripePrices.js).
 *
 * - Reuses existing Stripe Price IDs from .env when present (no duplicate
 *   Stripe objects), resolving the parent Product from one of them.
 * - If no .env price IDs exist and STRIPE_SECRET_KEY is set, provisions a fresh
 *   Stripe Product + Prices for the plan.
 * - Skips any plan code that already exists in the collection.
 *
 * Usage:  node scripts/seedPlans.js     (or: npm run seed:plans)
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Plan = require("../models/plan");
const planPricing = require("../config/planPricing");
const planLimits = require("../config/planLimits");
const stripePrices = require("../config/stripePrices");
const stripePlanService = require("../services/stripePlanService");

const stripe = process.env.STRIPE_SECRET_KEY
  ? require("stripe")(process.env.STRIPE_SECRET_KEY)
  : null;

const DEFS = [
  { code: "basic", name: "Basic", color: "#06b6d4", sortOrder: 1, description: "For small charities getting started." },
  { code: "professional", name: "Professional", color: "#10b981", sortOrder: 2, description: "Growing organisations that need more." },
  { code: "enterprise", name: "Enterprise", color: "#f59e0b", sortOrder: 3, description: "Unlimited scale for large charities." },
];

// Infinity (used by config/planLimits.js for enterprise) → null = Unlimited.
const lim = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function run() {
  console.log("\n=== Seeding dynamic plans ===\n");
  for (const def of DEFS) {
    if (await Plan.findOne({ code: def.code })) {
      console.log(`= ${def.code} already exists — skipping`);
      continue;
    }

    const pricing = planPricing[def.code] || { monthly: 0, annual: 0 };
    const limits = planLimits[def.code] || {};
    const envIds = stripePrices[def.code] || {};

    const plan = new Plan({
      code: def.code,
      name: def.name,
      description: def.description,
      color: def.color,
      sortOrder: def.sortOrder,
      currency: planPricing.currency || "usd",
      price: { monthly: pricing.monthly || 0, annual: pricing.annual || 0 },
      limits: {
        campaigns: lim(limits.campaigns),
        volunteers: lim(limits.volunteers),
        volunteerEnabled: !!limits.volunteerEnabled,
      },
      features: [],
      stripePriceIds: { monthly: envIds.monthly || "", annual: envIds.annual || "" },
    });

    const hasEnvIds = !!(plan.stripePriceIds.monthly || plan.stripePriceIds.annual);

    if (hasEnvIds && stripe) {
      // Resolve the parent product from an existing price so future reprices
      // attach to the same Stripe Product.
      try {
        const anyId = plan.stripePriceIds.monthly || plan.stripePriceIds.annual;
        const pr = await stripe.prices.retrieve(anyId);
        plan.stripeProductId = pr.product;
        console.log(`  • ${def.code} reused .env price IDs (product ${pr.product})`);
      } catch (e) {
        console.warn(`  ! ${def.code} could not resolve product from .env price: ${e.message}`);
      }
    } else if (!hasEnvIds && stripePlanService.isStripeEnabled()) {
      try {
        const synced = await stripePlanService.provisionPlan(plan);
        plan.stripeProductId = synced.stripeProductId;
        plan.stripePriceIds = synced.stripePriceIds;
        console.log(`  ✓ provisioned Stripe for ${def.code}`);
      } catch (e) {
        console.error(`  ! Stripe provision failed for ${def.code}: ${e.message}`);
      }
    }

    await plan.save();
    console.log(`+ created plan ${def.code}`);
  }
  console.log("\nDone.\n");
}

(async () => {
  try {
    await connectDB();
    await run();
  } catch (err) {
    console.error("Seed plans failed:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
})();
