const Plan = require("../models/plan");
const Organisation = require("../models/organisation");
const writeAudit = require("../utils/writeAudit");
const stripePlanService = require("../services/stripePlanService");
const planPricing = require("../config/planPricing");
const { GROUPS, FEATURES, METER_KEYS, FLAG_KEYS } = require("../config/featureCatalog");
const PlatformSettings = require("../models/platformSettings");
const { emitToSuperAdmins } = require("../services/socket");
const input = require("../utils/operatorInput");

// Tell every open operator console that the plan catalogue moved, so their
// cached copies revalidate (the console caches plans for the session).
const announcePlans = (code) => emitToSuperAdmins("plan:updated", { code: code || null });

// One platform billing currency (no per-plan currency — see PLATFORM_CURRENCY).
const PLATFORM_CURRENCY = (planPricing.currency || "aud").toLowerCase();

/**
 * Flags a plan whose Stripe provisioning didn't land, so the console can say so
 * instead of reporting a clean save. Returns {} when Stripe isn't configured —
 * that's a deliberate setup, not something to warn about on every save.
 */
function planSyncWarning(plan) {
  if (!stripePlanService.isStripeEnabled()) return {};
  const missing = ["monthly", "annual"].filter(
    (cycle) => Number(plan.price?.[cycle]) > 0 && !plan.stripePriceIds?.[cycle],
  );
  if (!plan.stripeProductId || missing.length) {
    const what = !plan.stripeProductId ? "product" : `${missing.join(" and ")} price`;
    return {
      stripeSynced: false,
      warning: `Saved, but the Stripe ${what} could not be created — nobody can subscribe to "${plan.code}" until it syncs. Run "npm run fix:stripe-catalog".`,
    };
  }
  return { stripeSynced: true };
}

// Mixed/Map/subdoc → plain object.
const toPlain = (v) =>
  !v ? {} : typeof v.toObject === "function" ? v.toObject() : v instanceof Map ? Object.fromEntries(v) : { ...v };

// A plan code ends up in URLs (/superadmin/plans/:code), in Stripe metadata and
// on the public pricing page, so it has to be a slug. Without this, "<script>…"
// and "a/../b" were both accepted as plan codes.
const RE_PLAN_CODE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

// Prices are in whole currency units. Stripe takes an integer number of cents,
// so anything finer than 2dp cannot be charged, and a negative amount is not a
// discount — it's a plan that pays the customer.
const PRICE_RULES = { min: 0, max: 1_000_000, allowNull: true, decimals: 2 };

/**
 * Validate the price block. The old code did `Number(price?.monthly) || 0`,
 * which is the single most damaging line in this file: a typo'd "12o" became 0
 * and published the tier as FREE, and a negative amount saved happily and then
 * failed silently against Stripe.
 * @returns {{error:string}|{value:{monthly?:number,annual?:number}}}
 */
function parsePrice(price, { required = false } = {}) {
  if (price === undefined || price === null) {
    if (required) return { error: "A price is required" };
    return { value: {} };
  }
  if (typeof price !== "object" || Array.isArray(price)) return { error: "Price must be an object" };
  const out = {};
  for (const cycle of ["monthly", "annual"]) {
    if (price[cycle] === undefined) continue;
    const label = cycle === "monthly" ? "Monthly price" : "Annual price";
    const n = input.number(price[cycle], label, PRICE_RULES);
    if (n.error) return { error: n.error };
    out[cycle] = n.value === null ? 0 : n.value;
  }
  return { value: out };
}

// Keep only valid catalog meter keys; "" / null / undefined → null (= unlimited).
// A non-numeric or negative quota is refused rather than coerced — `Number("abc")`
// wrote NaN, and NaN fails every quota comparison, so the plan silently allowed
// nothing.
function sanitizeLimits(limits = {}) {
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) {
    return { error: "Limits must be an object" };
  }
  const out = {};
  for (const k of METER_KEYS) {
    if (limits[k] === undefined) continue;
    if (typeof limits[k] === "boolean") {
      out[k] = limits[k];
      continue;
    }
    const n = input.number(limits[k], `Limit "${k}"`, { min: 0, max: 1e9, allowNull: true, integer: true });
    if (n.error) return { error: n.error };
    out[k] = n.value;
  }
  return { value: out };
}

// Keep only valid catalog flag keys, coerced to booleans.
function sanitizeFlags(flags = {}) {
  const out = {};
  for (const k of FLAG_KEYS) {
    if (flags[k] !== undefined) out[k] = !!flags[k];
  }
  return out;
}

// { code: { total, active } } subscriber counts across all organisations.
//
// `deletedAt: null` is load-bearing. Soft delete is the SuperAdmin console's
// Danger Zone action, and models/organisation.js states the contract plainly:
// a deleted org is "hidden from every SuperAdmin list/stat". This aggregate was
// the one place that ignored it, so the plan cards were counting rows nobody
// can see anywhere else in the console — 22 of 25 organisations on this
// platform are soft-deleted, which is why every card read 11/11/3 when the real
// tenant count is 0/2/1.
//
// `total` still includes suspended-but-not-deleted tenants on purpose: they are
// on the plan and would come back if reactivated. `active` is the narrower
// figure — a live subscription — and the two are meant to differ.
async function subscriberCounts() {
  const rows = await Organisation.aggregate([
    { $match: { plan: { $nin: [null, ""] }, deletedAt: null } },
    {
      $group: {
        _id: "$plan",
        total: { $sum: 1 },
        active: {
          $sum: { $cond: [{ $eq: ["$subscriptionStatus", "active"] }, 1, 0] },
        },
      },
    },
  ]);
  const map = {};
  rows.forEach((r) => {
    map[r._id] = { total: r.total, active: r.active };
  });
  return map;
}

/** GET /api/superadmin/plans */
exports.listPlans = async (req, res) => {
  try {
    const [plans, counts] = await Promise.all([
      Plan.find().sort({ sortOrder: 1, createdAt: 1 }).lean(),
      subscriberCounts(),
    ]);
    const withCounts = plans.map((p) => ({
      ...p,
      subscribers: counts[p.code] || { total: 0, active: 0 },
    }));
    res.json({ plans: withCounts, stripeEnabled: stripePlanService.isStripeEnabled() });
  } catch (err) {
    console.error("List plans error:", err);
    res.status(500).json({ error: "Failed to fetch plans" });
  }
};

/** POST /api/superadmin/plans */
exports.createPlan = async (req, res) => {
  try {
    const { code, price, limits, featureFlags, features, color, isPublic, isPopular } = req.body;

    const normCode = String(code ?? "").toLowerCase().trim().replace(/\s+/g, "-");
    if (!normCode) return res.status(400).json({ error: "code and name are required" });
    if (!RE_PLAN_CODE.test(normCode)) {
      return res.status(400).json({
        error: "Plan code must be 3–40 characters, lowercase letters, numbers and hyphens only",
      });
    }

    // The name is capped because Stripe rejects product names over 5 000
    // characters — an over-long name saved here and then permanently broke
    // every later sync for that plan.
    const v = input.collect({
      name: input.text(req.body.name, "Name", { max: 120, required: true, allowEmpty: false }),
      description: input.text(req.body.description, "Description", { max: 500 }),
      sortOrder: input.number(req.body.sortOrder, "Sort order", { min: -9999, max: 9999, allowNull: true, integer: true }),
      features: input.stringList(features, "Features", { max: 30, maxLength: 120 }),
    });
    if (v.error) return res.status(400).json({ error: v.error });

    const parsedPrice = parsePrice(price);
    if (parsedPrice.error) return res.status(400).json({ error: parsedPrice.error });
    const parsedLimits = sanitizeLimits(limits);
    if (parsedLimits.error) return res.status(400).json({ error: parsedLimits.error });

    if (await Plan.findOne({ code: normCode })) {
      return res.status(409).json({ error: "A plan with this code already exists" });
    }

    const plan = new Plan({
      code: normCode,
      name: v.values.name,
      description: v.values.description,
      currency: PLATFORM_CURRENCY, // single platform currency
      price: { monthly: parsedPrice.value.monthly || 0, annual: parsedPrice.value.annual || 0 },
      limits: parsedLimits.value,
      featureFlags: sanitizeFlags(featureFlags),
      features: v.values.features,
      color: color || "#10b981",
      isPublic: isPublic !== false,
      isPopular: !!isPopular,
      sortOrder: v.values.sortOrder ?? 0,
    });

    // Provision in Stripe (best-effort — plan still saves if Stripe is down).
    try {
      const synced = await stripePlanService.provisionPlan(plan);
      plan.stripeProductId = synced.stripeProductId;
      plan.stripePriceIds = synced.stripePriceIds;
    } catch (e) {
      console.error("Stripe provision failed (plan saved unsynced):", e.message);
    }

    await plan.save();
    await writeAudit(req, "plan.created", {
      targetType: "plan",
      targetId: plan.code,
      meta: { name: plan.name, price: plan.price },
    });
    announcePlans(plan.code);
    // As with coupons: the plan saves even if Stripe provisioning failed, and a
    // plan with no Stripe Price can't be subscribed to. Don't report that as a
    // clean success.
    res.status(201).json({ plan, ...planSyncWarning(plan) });
  } catch (err) {
    // Two operators saving the same new code milliseconds apart both clear the
    // findOne above; the unique index catches the loser and it belongs as a 409.
    if (input.isDuplicateKey(err)) {
      return res.status(409).json({ error: "A plan with this code already exists" });
    }
    console.error("Create plan error:", err);
    res.status(500).json({ error: "Failed to create plan" });
  }
};

/** PATCH /api/superadmin/plans/:code */
exports.updatePlan = async (req, res) => {
  try {
    const plan = await Plan.findOne({ code: req.params.code });
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const { name, description, price, limits, featureFlags, features, color, isPublic, isPopular, isActive, sortOrder } =
      req.body;

    // Validate everything BEFORE mutating the document, so a rejected save
    // leaves the plan exactly as it was. The previous version applied each
    // field as it read it, so a bad price arrived after the name had already
    // been overwritten in memory.
    const v = input.collect({
      name: name === undefined ? { value: undefined } : input.text(name, "Name", { max: 120, required: true, allowEmpty: false }),
      description: description === undefined ? { value: undefined } : input.text(description, "Description", { max: 500 }),
      sortOrder: sortOrder === undefined ? { value: undefined } : input.number(sortOrder, "Sort order", { min: -9999, max: 9999, integer: true }),
      features: features === undefined ? { value: undefined } : input.stringList(features, "Features", { max: 30, maxLength: 120 }),
    });
    if (v.error) return res.status(400).json({ error: v.error });

    let parsedLimits;
    if (limits !== undefined) {
      parsedLimits = sanitizeLimits(limits);
      if (parsedLimits.error) return res.status(400).json({ error: parsedLimits.error });
    }
    const parsedPrice = parsePrice(price);
    if (parsedPrice.error) return res.status(400).json({ error: parsedPrice.error });

    const prevName = plan.name;
    const prevDescription = plan.description;

    if (v.values.name !== undefined) plan.name = v.values.name;
    if (v.values.description !== undefined) plan.description = v.values.description;
    // currency is platform-wide (PLATFORM_CURRENCY) — intentionally not editable.
    if (parsedLimits) {
      plan.limits = { ...toPlain(plan.limits), ...parsedLimits.value };
      plan.markModified("limits");
    }
    if (featureFlags !== undefined) {
      plan.featureFlags = { ...toPlain(plan.featureFlags), ...sanitizeFlags(featureFlags) };
      plan.markModified("featureFlags");
    }
    if (v.values.features !== undefined) plan.features = v.values.features;
    if (color !== undefined) plan.color = color;
    if (isPublic !== undefined) plan.isPublic = !!isPublic;
    if (isPopular !== undefined) plan.isPopular = !!isPopular;
    if (v.values.sortOrder !== undefined) plan.sortOrder = v.values.sortOrder;
    if (isActive !== undefined) {
      plan.isActive = !!isActive;
      if (isActive) plan.archivedAt = null;
    }

    // Push name/description edits to the Stripe Product (best-effort).
    if (plan.stripeProductId && (plan.name !== prevName || plan.description !== prevDescription)) {
      try {
        await stripePlanService.syncProduct(plan);
      } catch (e) {
        console.error("Stripe product sync failed:", e.message);
      }
    }

    // Detect amount changes per cycle (against the validated values).
    const changed = [];
    for (const cycle of ["monthly", "annual"]) {
      if (parsedPrice.value[cycle] !== undefined && parsedPrice.value[cycle] !== Number(plan.price[cycle])) {
        changed.push(cycle);
      }
    }

    let priceChanged = false;
    if (changed.length) {
      // Snapshot the old amounts + price IDs before mutating (grandfathering).
      plan.priceHistory.push({
        monthly: plan.price.monthly,
        annual: plan.price.annual,
        stripePriceIds: {
          monthly: plan.stripePriceIds?.monthly || "",
          annual: plan.stripePriceIds?.annual || "",
        },
        replacedAt: new Date(),
      });
      for (const cycle of changed) plan.price[cycle] = parsedPrice.value[cycle];

      // Mint new immutable Stripe Prices for the changed cycles.
      try {
        const synced = await stripePlanService.repriceChangedCycles(plan, changed);
        if (synced.stripeProductId) plan.stripeProductId = synced.stripeProductId;
        for (const cycle of changed) {
          if (synced.stripePriceIds?.[cycle] !== undefined) {
            plan.stripePriceIds[cycle] = synced.stripePriceIds[cycle];
          }
        }
      } catch (e) {
        console.error("Stripe reprice failed:", e.message);
      }
      priceChanged = true;
    }

    await plan.save();

    // How many live-subscription tenants are still on the old price.
    let subscribersAffected = 0;
    if (priceChanged) {
      subscribersAffected = await Organisation.countDocuments({
        plan: plan.code,
        stripeSubscriptionId: { $nin: [null, ""] },
        subscriptionStatus: "active",
      });
    }

    await writeAudit(req, priceChanged ? "plan.price_changed" : "plan.updated", {
      targetType: "plan",
      targetId: plan.code,
      meta: { changed, price: plan.price },
    });
    announcePlans(plan.code);
    res.json({ plan, priceChanged, subscribersAffected });
  } catch (err) {
    console.error("Update plan error:", err);
    res.status(500).json({ error: "Failed to update plan" });
  }
};

/** POST /api/superadmin/plans/:code/archive */
exports.archivePlan = async (req, res) => {
  try {
    const plan = await Plan.findOne({ code: req.params.code });
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    // Archiving deactivates the Stripe prices, so tenants still on the plan
    // have nothing to renew against. That may be intentional during a
    // migration, but it must be a decision, not an accident — the console asks
    // for confirm:true once it knows the number.
    const stillOn = await Organisation.countDocuments({ plan: plan.code, subscriptionStatus: "active" });
    if (stillOn > 0 && req.body?.confirm !== true) {
      return res.status(409).json({
        error: `${stillOn} active tenant${stillOn === 1 ? " is" : "s are"} still on "${plan.code}". Move them to another plan first, or resend with confirm:true to archive anyway.`,
        subscribersAffected: stillOn,
        needsConfirmation: true,
      });
    }

    plan.isActive = false;
    plan.isPublic = false;
    plan.archivedAt = new Date();
    await plan.save();
    await stripePlanService.archivePlanStripe(plan);
    await writeAudit(req, "plan.archived", {
      targetType: "plan",
      targetId: plan.code,
      meta: { subscribersAffected: stillOn, forced: stillOn > 0 },
    });
    announcePlans(plan.code);
    res.json({ plan, subscribersAffected: stillOn });
  } catch (err) {
    console.error("Archive plan error:", err);
    res.status(500).json({ error: "Failed to archive plan" });
  }
};

/** POST /api/superadmin/plans/:code/migrate-subscribers */
exports.migrateSubscribers = async (req, res) => {
  try {
    const plan = await Plan.findOne({ code: req.params.code });
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    // Stripe accepts exactly these three; anything else came back as a 500
    // after the call had already been attempted.
    const proration = input.oneOf(req.body?.proration ?? "none", "Proration", [
      "none",
      "create_prorations",
      "always_invoice",
    ]);
    if (proration.error) return res.status(400).json({ error: proration.error });

    const result = await stripePlanService.migrateSubscribers(plan, { proration: proration.value });
    await writeAudit(req, "plan.subscribers_migrated", {
      targetType: "plan",
      targetId: plan.code,
      meta: result,
    });
    // Tenants moved between prices — org lists/billing totals shift too.
    announcePlans(plan.code);
    emitToSuperAdmins("organisation:updated", {});
    res.json(result);
  } catch (err) {
    console.error("Migrate subscribers error:", err);
    res.status(500).json({ error: "Failed to migrate subscribers" });
  }
};

/** POST /api/superadmin/plans/:code/resync — (re)provision/repair Stripe. */
exports.resyncPlan = async (req, res) => {
  try {
    const plan = await Plan.findOne({ code: req.params.code });
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    if (!stripePlanService.isStripeEnabled()) {
      return res.status(400).json({ error: "Stripe is not configured" });
    }
    const synced = await stripePlanService.resyncPlan(plan);
    plan.stripeProductId = synced.stripeProductId;
    plan.stripePriceIds = synced.stripePriceIds;
    await plan.save();
    await writeAudit(req, "plan.resynced", {
      targetType: "plan",
      targetId: plan.code,
      meta: { stripeProductId: plan.stripeProductId },
    });
    announcePlans(plan.code);
    res.json({ plan });
  } catch (err) {
    console.error("Resync plan error:", err);
    res.status(500).json({ error: err.message || "Failed to resync plan with Stripe" });
  }
};

/** GET /api/superadmin/feature-catalog — rows + groups for the matrix screen. */
exports.getFeatureCatalog = async (_req, res) => {
  res.json({ groups: GROUPS, features: FEATURES });
};

/** GET /api/superadmin/plan-bullets — the editable pricing-card bullet library. */
exports.getPlanBullets = async (_req, res) => {
  try {
    const settings = await PlatformSettings.getSingleton();
    res.json({ bullets: settings.planBulletLibrary || [] });
  } catch (err) {
    console.error("Get plan bullets error:", err);
    res.status(500).json({ error: "Failed to fetch bullet library" });
  }
};

/** PUT /api/superadmin/plan-bullets  { bullets:[string] } — replace the library. */
exports.updatePlanBullets = async (req, res) => {
  try {
    // A malformed body used to fall through to `[]` and silently wipe the whole
    // library with a 200 — the operator's bullet list destroyed by a bad request.
    if (!Array.isArray(req.body?.bullets)) {
      return res.status(400).json({ error: "bullets must be a list" });
    }
    const incoming = req.body.bullets;
    // Trim, drop blanks, de-dupe (case-insensitive), cap length.
    const seen = new Set();
    const bullets = [];
    incoming.forEach((b) => {
      const v = String(b || "").trim().slice(0, 80);
      const k = v.toLowerCase();
      if (v && !seen.has(k)) {
        seen.add(k);
        bullets.push(v);
      }
    });
    const settings = await PlatformSettings.getSingleton();
    settings.planBulletLibrary = bullets.slice(0, 50);
    await settings.save();
    emitToSuperAdmins("planBullets:updated", {});
    res.json({ bullets: settings.planBulletLibrary });
  } catch (err) {
    console.error("Update plan bullets error:", err);
    res.status(500).json({ error: "Failed to save bullet library" });
  }
};

/**
 * PUT /api/superadmin/entitlements — bulk-save the feature matrix.
 * Body: { plans: { [code]: { features?: {flag:bool}, limits?: {meter:num|null} } } }
 */
exports.bulkUpdateEntitlements = async (req, res) => {
  try {
    const incoming = req.body?.plans || {};
    const codes = Object.keys(incoming);
    if (!codes.length) return res.status(400).json({ error: "No plans provided" });

    const plans = await Plan.find({ code: { $in: codes } });
    const byCode = Object.fromEntries(plans.map((p) => [p.code, p]));

    // Validate the WHOLE matrix before saving any of it — a bad quota in the
    // last column must not leave the first three already written. A NaN here
    // used to persist and then fail every quota comparison for that plan.
    const staged = [];
    const skipped = [];
    for (const code of codes) {
      const plan = byCode[code];
      if (!plan) {
        skipped.push(code);
        continue;
      }
      const patch = incoming[code] || {};
      const entry = { plan };
      if (patch.features !== undefined) entry.flags = sanitizeFlags(patch.features);
      if (patch.limits !== undefined) {
        const parsed = sanitizeLimits(patch.limits);
        if (parsed.error) return res.status(400).json({ error: `${code}: ${parsed.error}` });
        entry.limits = parsed.value;
      }
      staged.push(entry);
    }

    const updated = [];
    for (const { plan, flags, limits } of staged) {
      if (flags) {
        plan.featureFlags = { ...toPlain(plan.featureFlags), ...flags };
        plan.markModified("featureFlags");
      }
      if (limits) {
        plan.limits = { ...toPlain(plan.limits), ...limits };
        plan.markModified("limits");
      }
      await plan.save();
      updated.push(plan.code);
    }

    await writeAudit(req, "plan.entitlements_updated", {
      targetType: "plan",
      targetId: updated.join(","),
      meta: { plans: updated, skipped },
    });
    announcePlans(null); // several plans at once
    // `skipped` names the codes that matched no plan, so the console can tell a
    // real save from a silent no-op.
    res.json({ updated, skipped, plans });
  } catch (err) {
    console.error("Bulk entitlements error:", err);
    res.status(500).json({ error: "Failed to update entitlements" });
  }
};
