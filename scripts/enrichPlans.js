/**
 * scripts/enrichPlans.js
 *
 * Enriches the existing dynamic plans with their public marketing details —
 * the tagline (description), the pricing-card bullet list (features), and the
 * "Most popular" highlight (isPopular) — so the home page + /plans pricing
 * section render exactly like the design.
 *
 * Idempotent: matches by `code`, only touches description / features / isPopular
 * (never price, Stripe, limits or featureFlags), and skips codes that don't
 * exist. Run it again any time to reset these fields to the canonical copy.
 *
 * Usage:  node scripts/enrichPlans.js     (or: npm run enrich:plans)
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Plan = require("../models/plan");

const ENRICH = [
  {
    code: "basic",
    description: "For small charities getting started.",
    isPopular: false,
    features: [
      "Up to 3 campaigns",
      "Donation processing",
      "Donor management",
      "Your branded portal",
      "Admin dashboard",
    ],
  },
  {
    code: "professional",
    description: "For growing charities running active appeals.",
    isPopular: true,
    features: [
      "Up to 5 campaigns",
      "Everything in Basic",
      "Up to 10 volunteers",
      "Campaign updates",
      "Event management",
    ],
  },
  {
    code: "enterprise",
    description: "For established charities operating at scale.",
    isPopular: false,
    features: [
      "Unlimited campaigns",
      "Everything in Professional",
      "Unlimited volunteers",
      "Priority support",
      "Tailored onboarding",
    ],
  },
];

async function run() {
  console.log("\n=== Enriching plans (details + popular) ===\n");
  let updated = 0;
  for (const def of ENRICH) {
    const plan = await Plan.findOne({ code: def.code });
    if (!plan) {
      console.log(`- ${def.code} not found — skipping (run npm run seed:plans first)`);
      continue;
    }
    plan.description = def.description;
    plan.features = def.features;
    plan.isPopular = def.isPopular;
    await plan.save();
    updated += 1;
    console.log(`✓ ${def.code} enriched — ${def.features.length} bullets${def.isPopular ? " · ★ most popular" : ""}`);
  }
  console.log(`\nDone. ${updated} plan(s) updated.\n`);
}

(async () => {
  try {
    await connectDB();
    await run();
  } catch (err) {
    console.error("Enrich plans failed:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
})();
