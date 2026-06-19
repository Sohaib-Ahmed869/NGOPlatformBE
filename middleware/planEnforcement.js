const mongoose = require("mongoose");
const { getEffectiveLimits, getEffectiveEntitlements } = require("../utils/effectiveLimits");
const { METER_MAP } = require("../config/featureCatalog");

// Legacy flag names → canonical catalog flag keys.
const FLAG_ALIASES = { volunteerEnabled: "volunteers" };

// Resolve a Mongoose model by its registered name without guessing file paths.
// Returns null if the model isn't registered (→ enforcement safely no-ops).
function getModel(name) {
  try {
    return mongoose.model(name);
  } catch {
    return null;
  }
}

/**
 * @deprecated Tier hierarchy gating doesn't understand custom dynamic plans.
 * Prefer capability gating via requireFeature(flag). Kept for any legacy callers.
 */
const planHierarchy = { basic: 1, professional: 2, enterprise: 3 };
const requirePlan = (minPlan) => (req, res, next) => {
  if (!req.organisation) {
    return res.status(400).json({ error: "No organisation context" });
  }
  const orgLevel = planHierarchy[req.organisation.plan] || 0;
  const requiredLevel = planHierarchy[minPlan] || 0;
  if (orgLevel < requiredLevel) {
    return res.status(403).json({
      error: `This feature requires the ${minPlan} plan or higher`,
      upgradeRequired: true,
      currentPlan: req.organisation.plan,
      requiredPlan: minPlan,
    });
  }
  next();
};

/**
 * Blocks creation when the org has reached its EFFECTIVE limit (dynamic plan
 * limits + per-tenant override) for a metered resource. A limit of
 * null / Infinity / undefined means unlimited.
 *
 * Counting is driven by config/featureCatalog.js `count` metadata, so any new
 * meter is enforced automatically — no code change here.
 *   checkLimit('campaigns')  → Program { status:'active' }
 *   checkLimit('volunteers') → Join
 */
const checkLimit = (resource) => async (req, res, next) => {
  if (!req.organisation) {
    return res.status(400).json({ error: "No organisation context" });
  }

  try {
    const limits = await getEffectiveLimits(req.organisation);
    const limit = limits[resource];

    // Unlimited / undefined / non-finite → allow.
    if (limit === undefined || limit === null || !Number.isFinite(limit)) {
      return next();
    }

    const meta = METER_MAP[resource];
    const Model = meta && meta.count ? getModel(meta.count.model) : null;
    if (!Model) return next(); // no known counter → don't block

    const orgField = (meta.count && meta.count.orgField) || "organisationId";
    const filter = { [orgField]: req.organisation._id, ...(meta.count.filter || {}) };
    const currentCount = await Model.countDocuments(filter);

    if (currentCount >= limit) {
      return res.status(403).json({
        error: `You have reached the limit of ${limit} ${resource} on your ${req.organisation.plan} plan`,
        upgradeRequired: true,
        limit,
        current: currentCount,
      });
    }

    next();
  } catch (error) {
    console.error("Plan enforcement error:", error);
    res.status(500).json({ error: "Server error checking plan limits" });
  }
};

/**
 * Blocks a request when a boolean capability flag is OFF in the org's EFFECTIVE
 * entitlements (dynamic plan featureFlags + override).
 * Usage: requireFeature('events') / requireFeature('newsletter', 'Newsletter')
 */
const requireFeature = (flag, label) => async (req, res, next) => {
  if (!req.organisation) {
    return res.status(400).json({ error: "No organisation context" });
  }
  try {
    const { features } = await getEffectiveEntitlements(req.organisation);
    const key = FLAG_ALIASES[flag] || flag;
    if (features[key]) return next();
    return res.status(403).json({
      error: `${label || flag} is not available on your ${req.organisation.plan} plan`,
      upgradeRequired: true,
    });
  } catch (error) {
    console.error("Feature gate error:", error);
    res.status(500).json({ error: "Server error checking plan features" });
  }
};

module.exports = { requirePlan, checkLimit, requireFeature };
