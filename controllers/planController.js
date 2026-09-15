const Plan = require("../models/plan");
const Organisation = require("../models/organisation");
const writeAudit = require("../utils/writeAudit");
const stripePlanService = require("../services/stripePlanService");
const planService = require("../services/planService");
const { GROUPS, FEATURES } = require("../config/featureCatalog");
const PlatformSettings = require("../models/platformSettings");
const { emitToSuperAdmins } = require("../services/socket");
const input = require("../utils/operatorInput");
const { isServiceError } = require("../utils/serviceError");

// Create/update/archive live in services/planService.js so the integration API
// edits plans through exactly the same validation, Stripe sync and audit.
const { announcePlans, sanitizeLimits, sanitizeFlags, toPlain } = planService;

/**
 * Answer a planService failure in the console's `{ error }` shape. `details`
 * is spread for the fields the console already reads (archive's
 * subscribersAffected / needsConfirmation).
 */
function sendPlanError(res, err, fallback) {
  if (isServiceError(err)) {
    const { field, ...details } = err.details || {};
    return res.status(err.status).json({ error: err.message, code: err.code, ...details });
  }
  console.error(`${fallback}:`, err);
  return res.status(500).json({ error: fallback });
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
exports.subscriberCounts = subscriberCounts;

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
    const { plan, ...sync } = await planService.createPlan(req.body || {}, req);
    // As with coupons: the plan saves even if Stripe provisioning failed, and a
    // plan with no Stripe Price can't be subscribed to — sync carries the warning.
    res.status(201).json({ plan, ...sync });
  } catch (err) {
    sendPlanError(res, err, "Failed to create plan");
  }
};

/** PATCH /api/superadmin/plans/:code */
exports.updatePlan = async (req, res) => {
  try {
    const { plan, priceChanged, subscribersAffected } = await planService.updatePlan(req.params.code, req.body || {}, req);
    res.json({ plan, priceChanged, subscribersAffected });
  } catch (err) {
    sendPlanError(res, err, "Failed to update plan");
  }
};

/** POST /api/superadmin/plans/:code/archive */
exports.archivePlan = async (req, res) => {
  try {
    // Archiving with tenants still active on the plan must be a decision, not
    // an accident — the console asks for confirm:true once it knows the number.
    const { plan, subscribersAffected } = await planService.archivePlan(req.params.code, { confirm: req.body?.confirm === true }, req);
    res.json({ plan, subscribersAffected });
  } catch (err) {
    sendPlanError(res, err, "Failed to archive plan");
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
      try {
        if (patch.features !== undefined) entry.flags = sanitizeFlags(patch.features);
        if (patch.limits !== undefined) entry.limits = sanitizeLimits(patch.limits);
      } catch (err) {
        if (isServiceError(err)) return res.status(400).json({ error: `${code}: ${err.message}` });
        throw err;
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
