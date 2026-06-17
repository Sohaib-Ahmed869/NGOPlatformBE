const { getEffectiveLimits } = require("../utils/effectiveLimits");

const planHierarchy = { basic: 1, professional: 2, enterprise: 3 };

/**
 * Blocks request if org's plan is below the minimum required plan.
 * Usage: requirePlan('professional')
 */
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
 * limits + per-tenant override) for a resource. A limit of null / Infinity /
 * undefined means unlimited.
 *   checkLimit('campaigns')  → counts active Program documents
 *   checkLimit('volunteers') → counts Join (volunteer application) documents
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

    const orgId = req.organisation._id;
    let currentCount = 0;

    if (resource === "campaigns") {
      const Program = require("../models/program");
      currentCount = await Program.countDocuments({ organisationId: orgId, status: "active" });
    } else if (resource === "volunteers") {
      const Join = require("../models/join");
      currentCount = await Join.countDocuments({ organisationId: orgId });
    } else {
      return next(); // no known collection for this resource
    }

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
 * Blocks a request when a boolean feature flag is OFF in the org's EFFECTIVE
 * limits (dynamic plan + override). Usage: requireFeature('volunteerEnabled')
 */
const requireFeature = (flag, label) => async (req, res, next) => {
  if (!req.organisation) {
    return res.status(400).json({ error: "No organisation context" });
  }
  try {
    const limits = await getEffectiveLimits(req.organisation);
    if (limits[flag]) return next();
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
