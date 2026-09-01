/**
 * scripts/renamePlanCode.js
 *
 * Renames a plan's CODE and repoints every reference to it. Written for
 * basic -> essentials, but takes the pair as arguments so the next rename does
 * not need a new script.
 *
 *   npm run plans:rename -- basic essentials             # dry run
 *   npm run plans:rename -- basic essentials --apply     # commit
 *
 * A plan code is not just a label. models/organisation.js stores it as a plain
 * STRING on `plan` — there is no ref and no foreign key — so renaming the Plan
 * document alone strands every organisation on the old value: their limits and
 * feature flags stop resolving and they quietly fall back to defaults. The
 * rename and the repoint have to happen together, which is the whole reason
 * this script exists rather than an edit in the console.
 *
 * Also updated:
 *   - Plan.code
 *   - Organisation.plan
 *   - Organisation.subscription.planCode / planOverride.plan, where present
 *   - the Stripe Product's planCode metadata, and each Price's, so Stripe
 *     reporting keys off the new code too
 *
 * Not updated, deliberately: historical audit rows and priceHistory entries.
 * Those are a record of what happened at the time and rewriting them would be
 * falsifying the log. `basic` also survives as a rank alias in
 * config/planTiers.js and middleware/planEnforcement.js so anything that
 * replays an old payload still ranks correctly.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Plan = require("../models/plan");
const Organisation = require("../models/organisation");
const platformStripe = require("../services/platformStripe");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [FROM, TO] = args;
const APPLY = process.argv.includes("--apply");

async function run() {
  if (!FROM || !TO) {
    console.error("Usage: npm run plans:rename -- <fromCode> <toCode> [--apply]");
    process.exitCode = 1;
    return;
  }
  console.log(`\n=== Rename plan code: ${FROM} -> ${TO} ===${APPLY ? "" : "  [dry run]"}\n`);

  const source = await Plan.findOne({ code: FROM });
  const clash = await Plan.findOne({ code: TO });
  if (!source) {
    console.log(`No plan with code "${FROM}" — nothing to rename.`);
  } else if (clash) {
    // `code` is a unique index; saving over an existing one throws a duplicate
    // key error halfway through, after the org updates have already run.
    console.error(`! A plan already uses the code "${TO}" (${clash.name}). Resolve that first.`);
    process.exitCode = 1;
    return;
  }

  const orgCount = await Organisation.countDocuments({ plan: FROM });
  console.log(`plan document      : ${source ? `"${source.name}" (${FROM})` : "—"}`);
  console.log(`organisations      : ${orgCount} on "${FROM}"`);

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply to commit.\n");
    return;
  }

  if (source) {
    source.code = TO;
    await source.save();
    console.log(`\n+ Plan.code -> ${TO}`);

    // Keep Stripe's own metadata in step, or Stripe-side reporting and any
    // webhook that reads planCode keeps reporting the old tier.
    if (platformStripe.isStripeConfigured()) {
      try {
        if (source.stripeProductId) {
          await platformStripe.stripe.products.update(source.stripeProductId, { metadata: { planCode: TO } });
          console.log("+ Stripe product metadata.planCode updated");
        }
        for (const cycle of ["monthly", "annual"]) {
          const id = source.stripePriceIds?.[cycle];
          if (id) await platformStripe.stripe.prices.update(id, { metadata: { planCode: TO, cycle } });
        }
        console.log("+ Stripe price metadata updated");
      } catch (e) {
        console.warn(`! Stripe metadata update failed (safe to retry): ${e.message}`);
      }
    }
  }

  const r = await Organisation.updateMany({ plan: FROM }, { $set: { plan: TO } });
  console.log(`+ ${r.modifiedCount} organisation(s) repointed`);

  // Nested plan references, only where the field actually exists.
  for (const path of ["subscription.planCode", "planOverride.plan"]) {
    const res = await Organisation.updateMany({ [path]: FROM }, { $set: { [path]: TO } });
    if (res.modifiedCount) console.log(`+ ${res.modifiedCount} organisation(s) ${path}`);
  }

  const left = await Organisation.countDocuments({ plan: FROM });
  console.log(`\nOrganisations still on "${FROM}": ${left}`);
  const plans = await Plan.find({}).sort({ sortOrder: 1 }).select("code name").lean();
  console.log(`Plan codes now: ${plans.map((p) => `${p.code} (${p.name})`).join(", ")}\n`);
}

(async () => {
  try {
    await connectDB();
    await platformStripe.prime();
    await run();
  } catch (err) {
    console.error("renamePlanCode failed:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
})();
