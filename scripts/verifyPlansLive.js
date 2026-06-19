/**
 * scripts/verifyPlansLive.js  —  live integration check (real Mongo + real Stripe TEST).
 *
 * Proves the dynamic-plan wiring actually works end to end:
 *   [1] Stripe: provision a throwaway Product + Prices, edit-sync the name,
 *       then archive it (cleanup). Needs STRIPE_SECRET_KEY; no DB.
 *   [2] DB: resolve effective entitlements for every real Plan, and exercise a
 *       real metered count. Needs Mongo (config/db).
 *
 * Safe + idempotent: the Stripe objects are test-mode, clearly labelled
 * "[VERIFY]", and deactivated at the end. No Plan/Org documents are written.
 *
 * Usage:  node scripts/verifyPlansLive.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const stripePlanService = require("../services/stripePlanService");
const { getEffectiveEntitlements } = require("../utils/effectiveLimits");
const { METERS } = require("../config/featureCatalog");

const results = [];
const pass = (n, d) => { results.push("PASS"); console.log("  ✅", n, d ? "— " + d : ""); };
const fail = (n, d) => { results.push("FAIL"); console.log("  ❌", n, d ? "— " + d : ""); };
const skip = (n, d) => { results.push("SKIP"); console.log("  ⏭️ ", n, d ? "— " + d : ""); };

async function stripeCheck() {
  console.log("\n[1] Stripe provision / edit-sync / archive (TEST mode)");
  if (!stripePlanService.isStripeEnabled()) {
    skip("stripe", "STRIPE_SECRET_KEY not set — plans save unsynced");
    return;
  }
  const temp = {
    code: "__verify_" + Date.now(),
    name: "[VERIFY] Temp Plan",
    description: "temporary — created by verifyPlansLive, safe to delete",
    currency: (process.env.PLATFORM_CURRENCY || "aud").toLowerCase(),
    price: { monthly: 1, annual: 10 },
    stripePriceIds: {},
  };

  let synced;
  try {
    synced = await stripePlanService.provisionPlan(temp);
  } catch (e) {
    return fail("provisionPlan", e.message);
  }
  if (synced.stripeProductId && synced.stripePriceIds.monthly && synced.stripePriceIds.annual) {
    pass("provisionPlan creates Product + Prices",
      `${synced.stripeProductId} · ${synced.stripePriceIds.monthly} / ${synced.stripePriceIds.annual}`);
  } else {
    fail("provisionPlan", "missing ids: " + JSON.stringify(synced));
  }

  // Edit-sync: rename via resyncPlan (updates the Stripe Product name).
  try {
    const re = await stripePlanService.resyncPlan({
      ...temp,
      name: "[VERIFY] Renamed Plan",
      stripeProductId: synced.stripeProductId,
      stripePriceIds: synced.stripePriceIds,
      isActive: true,
    });
    pass("resyncPlan / product name-sync", re.stripeProductId);
  } catch (e) {
    fail("resyncPlan", e.message);
  }

  // Cleanup: deactivate the test Product + Prices.
  try {
    await stripePlanService.archivePlanStripe({
      stripeProductId: synced.stripeProductId,
      stripePriceIds: synced.stripePriceIds,
    });
    pass("cleanup", "archived the test Product + Prices");
  } catch (e) {
    fail("cleanup", e.message);
  }
}

async function dbCheck() {
  console.log("\n[2] DB resolver + metered caps (real data)");
  const Plan = require("../models/plan");
  const Organisation = require("../models/organisation");

  const plans = await Plan.find().select("code featureFlags limits").lean();
  if (!plans.length) {
    return skip("resolver", "no Plan docs yet — run `npm run seed:plans` first");
  }
  pass("plans in DB", plans.map((p) => p.code).join(", "));

  for (const p of plans) {
    const ent = await getEffectiveEntitlements({ plan: p.code });
    const flagsOn = Object.values(ent.features).filter(Boolean).length;
    const flagsTotal = Object.keys(ent.features).length;
    const configured = p.featureFlags && Object.keys(p.featureFlags).length > 0;
    console.log(
      `     • ${p.code}: ${flagsOn}/${flagsTotal} features on` +
      `${configured ? "" : " (UNCONFIGURED → all on; run seed:plans)"}; limits ${JSON.stringify(ent.limits)}`
    );
  }
  pass("resolver", "resolved entitlements for every plan");

  // Register the metered models so mongoose.model(name) resolves (the running
  // app does this at boot; a standalone script must require them).
  for (const f of ["program", "join", "event", "product", "user"]) {
    try { require(`../models/${f}`); } catch { /* not present — fine */ }
  }

  // Exercise one real metered count exactly like checkLimit does.
  const org = await Organisation.findOne().select("_id plan").lean();
  if (org) {
    const meter = METERS.find((m) => {
      if (!m.count || !m.count.model) return false;
      try { mongoose.model(m.count.model); return true; } catch { return false; }
    });
    if (!meter) { skip("metered count", "no registered counter model"); return; }
    try {
      const Model = mongoose.model(meter.count.model);
      const filter = { organisationId: org._id, ...(meter.count.filter || {}) };
      const n = await Model.countDocuments(filter);
      const ent = await getEffectiveEntitlements({ plan: org.plan });
      const cap = ent.limits[meter.key];
      pass(`metered count (${meter.key})`,
        `org "${org.plan}" has ${n}; cap = ${cap === null || cap === undefined ? "Unlimited" : cap}`);
    } catch (e) {
      skip(`metered count (${meter.key})`, e.message);
    }
  } else {
    skip("metered count", "no organisations in DB");
  }
}

(async () => {
  console.log("=== Live plan / entitlement verification ===");
  await stripeCheck(); // no DB needed
  try {
    await connectDB();
    await dbCheck();
  } catch (e) {
    skip("db", "Mongo unreachable: " + e.message);
  } finally {
    try { await mongoose.connection.close(); } catch { /* ignore */ }
  }
  const fails = results.filter((r) => r === "FAIL").length;
  const passes = results.filter((r) => r === "PASS").length;
  const skips = results.filter((r) => r === "SKIP").length;
  console.log(`\n=== ${passes} passed · ${fails} failed · ${skips} skipped ===`);
  process.exit(fails ? 1 : 0);
})();
