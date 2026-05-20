const planLimits = require("../config/planLimits");
const User = require("../models/user");

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
 * Checks if org has hit its limit for a given resource.
 * Usage: checkLimit('campaigns') or checkLimit('volunteers')
 */
const checkLimit = (resource) => async (req, res, next) => {
  if (!req.organisation) {
    return res.status(400).json({ error: "No organisation context" });
  }

  const limits = planLimits[req.organisation.plan];
  if (!limits) {
    return res.status(500).json({ error: "Unknown plan" });
  }

  const limit = limits[resource];
  if (limit === undefined) {
    return next(); // No limit defined for this resource
  }

  if (limit === Infinity) {
    return next();
  }

  try {
    let currentCount = 0;
    const orgId = req.organisation._id;

    if (resource === "campaigns") {
      // Lazy-require to avoid circular dependency (Program model created in Phase 3)
      const Program = require("../models/program");
      currentCount = await Program.countDocuments({
        organisationId: orgId,
        status: "active",
      });
    } else if (resource === "volunteers") {
      currentCount = await User.countDocuments({
        organisationId: orgId,
        role: "donor",
      });
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

module.exports = { requirePlan, checkLimit };
