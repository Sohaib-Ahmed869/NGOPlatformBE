/**
 * scripts/applyPlanCatalogue.js
 *
 * Brings the Plan collection in line with the published pricing schedule:
 * Essentials / Professional / Enterprise, in AUD excluding GST, with a one-off
 * onboarding fee each. Anything else still active is ARCHIVED, not deleted.
 *
 *   npm run plans:apply              # dry run — prints the diff, writes nothing
 *   npm run plans:apply -- --apply   # actually write to Mongo + Stripe
 *   npm run plans:apply -- --apply --migrate-orgs
 *                                    # also move orgs off archived plans
 *
 * Dry run is the DEFAULT on purpose. This script writes to the platform's live
 * database and mints real Stripe Prices, and a Stripe Price cannot be deleted
 * once created — only archived. Read the diff before passing --apply.
 *
 * WHY ARCHIVE RATHER THAN DELETE
 * models/organisation.js stores the plan as a CODE STRING, not a ref, so a
 * deleted plan leaves every organisation on it pointing at nothing — limits and
 * feature flags stop resolving and those tenants silently fall back to
 * defaults. isActive:false + archivedAt is what the model was built for: the
 * plan stops being sellable, existing references keep resolving.
 *
 * The entry tier's code is `essentials` (it was `basic` before the rename in
 * scripts/renamePlanCode.js). `basic` still resolves as a rank alias in
 * config/planTiers.js and middleware/planEnforcement.js so stale links and
 * replayed webhooks do not fall through.
 *
 * Re-runnable. Everything is matched on `code` and only changed fields are
 * written, so a second run on an already-correct catalogue is a no-op.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Plan = require("../models/plan");
const Organisation = require("../models/organisation");
const planPricing = require("../config/planPricing");
const stripePlanService = require("../services/stripePlanService");
const platformStripe = require("../services/platformStripe");

const APPLY = process.argv.includes("--apply");
const MIGRATE_ORGS = process.argv.includes("--migrate-orgs");
const CURRENCY = planPricing.currency || "aud";

/** The published schedule. `code` is internal; `name` is what the world sees. */
const CATALOGUE = [
  {
    code: "essentials",
    name: "Essentials",
    sortOrder: 1,
    isPopular: false,
    color: "#0F3D2E",
    description: "New and small charities. Core fundraising, one branded site, standard support.",
  },
  {
    code: "professional",
    name: "Professional",
    sortOrder: 2,
    isPopular: true,
    color: "#1F7A55",
    description: "Established charities running programs, events and recurring giving.",
  },
  {
    code: "enterprise",
    name: "Enterprise",
    sortOrder: 3,
    isPopular: false,
    color: "#2FA36B",
    description: "Multi-program organisations needing the full suite and priority support.",
  },
];

const money = (n) => `A$${Number(n || 0).toLocaleString("en-AU")}`;
const tag = () => (APPLY ? "" : "  [dry run]");

async function run() {
  const codes = CATALOGUE.map((c) => c.code);
  console.log(`\n=== Plan catalogue ===${tag()}`);
  console.log(`Stripe: ${stripePlanService.isStripeEnabled() ? "configured" : "NOT configured — prices will not sync"}\n`);

  for (const def of CATALOGUE) {
    const target = planPricing[def.code];
    if (!target) {
      console.warn(`! ${def.code} has no entry in config/planPricing.js — skipped`);
      continue;
    }

    let plan = await Plan.findOne({ code: def.code });
    const isNew = !plan;

    if (isNew) {
      console.log(`+ CREATE ${def.name} (${def.code}) — ${money(target.monthly)}/mo, ${money(target.annual)}/yr, onboarding ${money(target.onboarding)}`);
      if (!APPLY) continue;
      plan = new Plan({ code: def.code, name: def.name, currency: CURRENCY });
    } else {
      const changes = [];
      if (plan.name !== def.name) changes.push(`name "${plan.name}" -> "${def.name}"`);
      if ((plan.currency || "") !== CURRENCY) changes.push(`currency ${plan.currency} -> ${CURRENCY}`);
      if (Number(plan.price?.monthly) !== target.monthly) changes.push(`monthly ${money(plan.price?.monthly)} -> ${money(target.monthly)}`);
      if (Number(plan.price?.annual) !== target.annual) changes.push(`annual ${money(plan.price?.annual)} -> ${money(target.annual)}`);
      if (Number(plan.onboardingFee || 0) !== target.onboarding) changes.push(`onboarding ${money(plan.onboardingFee)} -> ${money(target.onboarding)}`);
      if (plan.isPopular !== def.isPopular) changes.push(`popular ${plan.isPopular} -> ${def.isPopular}`);
      if (!plan.isActive || !plan.isPublic) changes.push("re-activate + publish");
      console.log(changes.length ? `~ UPDATE ${def.code}:\n    ${changes.join("\n    ")}` : `= ${def.code} already correct`);
      if (!changes.length || !APPLY) continue;
    }

    // Which recurring cycles actually changed amount — only those need a new
    // Stripe Price. Captured BEFORE the new amounts are assigned.
    const changedCycles = isNew
      ? []
      : ["monthly", "annual"].filter((c) => Number(plan.price?.[c]) !== Number(target[c]));

    plan.name = def.name;
    plan.description = def.description;
    plan.color = def.color;
    plan.sortOrder = def.sortOrder;
    plan.isPopular = def.isPopular;
    plan.isPublic = true;
    plan.isActive = true;
    plan.archivedAt = null;
    plan.currency = CURRENCY;
    plan.price = { monthly: target.monthly, annual: target.annual };
    plan.onboardingFee = target.onboarding;

    if (isNew) {
      const synced = await stripePlanService.provisionPlan(plan);
      plan.stripeProductId = synced.stripeProductId;
      plan.stripePriceIds = synced.stripePriceIds;
    } else {
      // Rename the Stripe Product so invoices read "Essentials", not "Basic".
      await stripePlanService.syncProduct(plan).catch((e) => console.warn(`  ! product sync: ${e.message}`));
      if (changedCycles.length) {
        // Stripe Prices are immutable: this mints new ones and the old ids go
        // into priceHistory, so anyone already billed stays grandfathered.
        const prev = { monthly: plan.price.monthly, annual: plan.price.annual };
        const synced = await stripePlanService.repriceChangedCycles(plan, changedCycles);
        plan.priceHistory.push({
          monthly: prev.monthly,
          annual: prev.annual,
          stripePriceIds: { ...(plan.stripePriceIds?.toObject?.() || plan.stripePriceIds) },
          replacedAt: new Date(),
        });
        if (synced.stripeProductId) plan.stripeProductId = synced.stripeProductId;
        for (const c of changedCycles) {
          if (synced.stripePriceIds?.[c]) plan.stripePriceIds[c] = synced.stripePriceIds[c];
        }
        console.log(`    stripe: new ${changedCycles.join(" + ")} price(s)`);
      }
    }

    await plan.save();
    console.log(`    saved.`);
  }

  // ── Anything else still sellable gets archived ───────────────────────────
  const strays = await Plan.find({ code: { $nin: codes }, isActive: true });
  for (const p of strays) {
    const n = await Organisation.countDocuments({ plan: p.code });
    console.log(`- ARCHIVE ${p.code} ("${p.name}") — ${n} organisation(s) reference it`);
    if (!APPLY) continue;
    p.isActive = false;
    p.isPublic = false;
    p.archivedAt = new Date();
    await p.save();
    await stripePlanService.archivePlanStripe(p);
    console.log("    archived (Stripe product + prices deactivated).");

    if (MIGRATE_ORGS && n) {
      const r = await Organisation.updateMany({ plan: p.code }, { $set: { plan: "essentials" } });
      console.log(`    moved ${r.modifiedCount} organisation(s) to the entry tier.`);
    } else if (n) {
      console.log(`    ${n} organisation(s) LEFT on this code — pass --migrate-orgs to move them.`);
    }
  }
  if (!strays.length) console.log("\nNo stray plans to archive.");

  const live = await Plan.find({ isActive: true, isPublic: true }).sort({ sortOrder: 1 }).lean();
  console.log(`\nSellable plans now: ${live.map((p) => `${p.name} (${money(p.price?.monthly)}/mo)`).join(", ") || "none"}`);
  if (!APPLY) console.log("\nDry run — nothing was written. Re-run with --apply to commit.\n");
}

(async () => {
  try {
    await connectDB();
    await platformStripe.prime();
    await run();
  } catch (err) {
    console.error("applyPlanCatalogue failed:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
})();
