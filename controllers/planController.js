const Plan = require("../models/plan");
const Organisation = require("../models/organisation");
const writeAudit = require("../utils/writeAudit");
const stripePlanService = require("../services/stripePlanService");

// null = unlimited; blank/undefined → null; otherwise a number.
function sanitizeLimits(limits = {}) {
  const num = (v) =>
    v === null || v === "" || v === undefined ? null : Number(v);
  return {
    campaigns: num(limits.campaigns),
    volunteers: num(limits.volunteers),
    volunteerEnabled: !!limits.volunteerEnabled,
  };
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
    const { code, name, description, currency, price, limits, features, color, isPublic, sortOrder } =
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
      currency: (currency || "usd").toLowerCase(),
      price: { monthly: Number(price?.monthly) || 0, annual: Number(price?.annual) || 0 },
      limits: sanitizeLimits(limits),
      features: Array.isArray(features) ? features.filter(Boolean) : [],
      color: color || "#10b981",
      isPublic: isPublic !== false,
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

    const { name, description, currency, price, limits, features, color, isPublic, isActive, sortOrder } =
      req.body;

    if (name !== undefined) plan.name = name;
    if (description !== undefined) plan.description = description;
    if (currency !== undefined) plan.currency = String(currency).toLowerCase();
    if (limits !== undefined) plan.limits = sanitizeLimits(limits);
    if (features !== undefined) {
      plan.features = Array.isArray(features) ? features.filter(Boolean) : plan.features;
    }
    if (color !== undefined) plan.color = color;
    if (isPublic !== undefined) plan.isPublic = !!isPublic;
    if (sortOrder !== undefined) plan.sortOrder = Number(sortOrder) || 0;
    if (isActive !== undefined) {
      plan.isActive = !!isActive;
      if (isActive) plan.archivedAt = null;
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
