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
const stripePrices = require("../config/stripePrices");
const stripePlanService = require("../services/stripePlanService");
const { FLAG_KEYS } = require("../config/featureCatalog");

const stripe = process.env.STRIPE_SECRET_KEY
  ? require("stripe")(process.env.STRIPE_SECRET_KEY)
  : null;

const DEFS = [
  { code: "basic", name: "Basic", color: "#06b6d4", sortOrder: 1, description: "For small charities getting started." },
  { code: "professional", name: "Professional", color: "#10b981", sortOrder: 2, description: "Growing organisations that need more." },
  { code: "enterprise", name: "Enterprise", color: "#f59e0b", sortOrder: 3, description: "Unlimited scale for large charities." },
];

// ── Default entitlement matrix per tier (config/featureCatalog.js keys) ──────
// Capability flags that are ON for each tier; any flag not listed defaults OFF
// (enterprise gets every flag). Operators tune these in the Features matrix.
const TIER_FLAGS_ON = {
  basic: ["donations", "recurringGiving", "programs", "volunteers", "contacts", "partners", "cmsPages", "initiatives", "islamicGiving", "ownStripe"],
  professional: ["donations", "recurringGiving", "programs", "p2pCampaigns", "store", "events", "volunteers", "newsletter", "contacts", "supportTickets", "partners", "cmsPages", "initiatives", "sectionBuilder", "islamicGiving", "ownStripe", "paypal", "customEmail", "savedCards"],
  enterprise: FLAG_KEYS, // everything
};
// Metered quotas per tier (null = Unlimited).
const TIER_LIMITS = {
  basic: { campaigns: 5, volunteers: 50, eventsQuota: 0, p2pQuota: 0, productsQuota: 0, adminSeats: 2 },
  professional: { campaigns: 50, volunteers: 500, eventsQuota: 50, p2pQuota: 25, productsQuota: 100, adminSeats: 10 },
  enterprise: { campaigns: null, volunteers: null, eventsQuota: null, p2pQuota: null, productsQuota: null, adminSeats: null },
};

const flagsFor = (code) => {
  const on = new Set(TIER_FLAGS_ON[code] || FLAG_KEYS);
  return Object.fromEntries(FLAG_KEYS.map((k) => [k, on.has(k)]));
};
const limitsFor = (code) => ({ ...(TIER_LIMITS[code] || {}) });

async function run() {
  console.log("\n=== Seeding dynamic plans ===\n");
  for (const def of DEFS) {
    const existing = await Plan.findOne({ code: def.code });
    if (existing) {
      // Backfill entitlements onto plans seeded before the featureFlags upgrade,
      // without clobbering any operator-tuned values.
      const hasFlags = existing.featureFlags && Object.keys(existing.featureFlags).length > 0;
      if (!hasFlags) {
        existing.featureFlags = flagsFor(def.code);
        if (!existing.limits || Object.keys(existing.limits).length === 0) {
          existing.limits = limitsFor(def.code);
        }
        existing.markModified("featureFlags");
        existing.markModified("limits");
        await existing.save();
        console.log(`~ ${def.code} backfilled featureFlags + limits`);
      } else {
        console.log(`= ${def.code} already configured — skipping`);
      }
      continue;
    }

    const pricing = planPricing[def.code] || { monthly: 0, annual: 0 };
    const envIds = stripePrices[def.code] || {};

    const plan = new Plan({
      code: def.code,
      name: def.name,
      description: def.description,
      color: def.color,
      sortOrder: def.sortOrder,
      currency: planPricing.currency || "aud",
      price: { monthly: pricing.monthly || 0, annual: pricing.annual || 0 },
      limits: limitsFor(def.code),
      featureFlags: flagsFor(def.code),
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
