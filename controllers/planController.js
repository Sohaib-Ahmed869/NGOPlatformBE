const Plan = require("../models/plan");
const Organisation = require("../models/organisation");
const writeAudit = require("../utils/writeAudit");
const stripePlanService = require("../services/stripePlanService");
const planPricing = require("../config/planPricing");
const { GROUPS, FEATURES, METER_KEYS, FLAG_KEYS } = require("../config/featureCatalog");
const PlatformSettings = require("../models/platformSettings");

// One platform billing currency (no per-plan currency — see PLATFORM_CURRENCY).
const PLATFORM_CURRENCY = (planPricing.currency || "aud").toLowerCase();

// Mixed/Map/subdoc → plain object.
const toPlain = (v) =>
  !v ? {} : typeof v.toObject === "function" ? v.toObject() : v instanceof Map ? Object.fromEntries(v) : { ...v };

// Keep only valid catalog meter keys; "" / null / undefined → null (= unlimited).
function sanitizeLimits(limits = {}) {
  const num = (v) => (v === null || v === "" || v === undefined ? null : Number(v));
  const out = {};
  for (const k of METER_KEYS) {
    if (limits[k] !== undefined) out[k] = num(limits[k]);
  }
  return out;
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
async function subscriberCounts() {
  const rows = await Organisation.aggregate([
    { $match: { plan: { $nin: [null, ""] } } },
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
      Plan.find().sort({ sortOrder: 1, createdAt: 1 }),
      subscriberCounts(),
    ]);
    const withCounts = plans.map((p) => ({
      ...p.toObject(),
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
    const { code, name, description, price, limits, featureFlags, features, color, isPublic, isPopular, sortOrder } =
      req.body;
    if (!code || !name) {
      return res.status(400).json({ error: "code and name are required" });
    }
    const normCode = String(code).toLowerCase().trim().replace(/\s+/g, "-");
    if (await Plan.findOne({ code: normCode })) {
      return res.status(409).json({ error: "A plan with this code already exists" });
    }

    const plan = new Plan({
      code: normCode,
      name,
      description: description || "",
      currency: PLATFORM_CURRENCY, // single platform currency
      price: { monthly: Number(price?.monthly) || 0, annual: Number(price?.annual) || 0 },
      limits: sanitizeLimits(limits),
      featureFlags: sanitizeFlags(featureFlags),
      features: Array.isArray(features) ? features.filter(Boolean) : [],
      color: color || "#10b981",
      isPublic: isPublic !== false,
      isPopular: !!isPopular,
      sortOrder: Number(sortOrder) || 0,
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
    res.status(201).json({ plan });
  } catch (err) {
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

    const prevName = plan.name;
    const prevDescription = plan.description;

    if (name !== undefined) plan.name = name;
    if (description !== undefined) plan.description = description;
    // currency is platform-wide (PLATFORM_CURRENCY) — intentionally not editable.
    if (limits !== undefined) {
      plan.limits = { ...toPlain(plan.limits), ...sanitizeLimits(limits) };
      plan.markModified("limits");
    }
    if (featureFlags !== undefined) {
      plan.featureFlags = { ...toPlain(plan.featureFlags), ...sanitizeFlags(featureFlags) };
      plan.markModified("featureFlags");
    }
    if (features !== undefined) {
      plan.features = Array.isArray(features) ? features.filter(Boolean) : plan.features;
    }
    if (color !== undefined) plan.color = color;
    if (isPublic !== undefined) plan.isPublic = !!isPublic;
    if (isPopular !== undefined) plan.isPopular = !!isPopular;
    if (sortOrder !== undefined) plan.sortOrder = Number(sortOrder) || 0;
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

    // Detect amount changes per cycle.
    const changed = [];
    if (price) {
      for (const cycle of ["monthly", "annual"]) {
        if (price[cycle] !== undefined && Number(price[cycle]) !== Number(plan.price[cycle])) {
          changed.push(cycle);
        }
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
      for (const cycle of changed) plan.price[cycle] = Number(price[cycle]) || 0;

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

    plan.isActive = false;
    plan.isPublic = false;
    plan.archivedAt = new Date();
    await plan.save();
    await stripePlanService.archivePlanStripe(plan);
    await writeAudit(req, "plan.archived", { targetType: "plan", targetId: plan.code });
    res.json({ plan });
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

    const result = await stripePlanService.migrateSubscribers(plan, {
      proration: req.body?.proration || "none",
    });
    await writeAudit(req, "plan.subscribers_migrated", {
      targetType: "plan",
      targetId: plan.code,
      meta: result,
    });
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
    const incoming = Array.isArray(req.body?.bullets) ? req.body.bullets : [];
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
    const updated = [];

    for (const code of codes) {
      const plan = byCode[code];
      if (!plan) continue;
      const patch = incoming[code] || {};
      if (patch.features !== undefined) {
        plan.featureFlags = { ...toPlain(plan.featureFlags), ...sanitizeFlags(patch.features) };
        plan.markModified("featureFlags");
      }
      if (patch.limits !== undefined) {
        plan.limits = { ...toPlain(plan.limits), ...sanitizeLimits(patch.limits) };
        plan.markModified("limits");
      }
      await plan.save();
      updated.push(plan.code);
    }

    await writeAudit(req, "plan.entitlements_updated", {
      targetType: "plan",
      targetId: updated.join(","),
      meta: { plans: updated },
    });
    res.json({ updated, plans });
  } catch (err) {
    console.error("Bulk entitlements error:", err);
    res.status(500).json({ error: "Failed to update entitlements" });
  }
};
