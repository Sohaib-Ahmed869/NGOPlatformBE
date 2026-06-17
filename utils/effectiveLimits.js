const Plan = require("../models/plan");
const planLimits = require("../config/planLimits");

/**
 * Effective entitlement limits for an organisation = its plan's limits, with any
 * per-tenant override merged on top. A `null` value means UNLIMITED.
 *
 * Falls back to the legacy static config/planLimits.js when no dynamic Plan
 * document exists yet (pre-seed). Returns a plain object safe to JSON-serialise
 * (Infinity from the legacy config becomes null = unlimited over the wire).
 */
async function getEffectiveLimits(org) {
  let base = {};
  const planDoc = await Plan.findOne({ code: org.plan }).select("limits");
  if (planDoc && planDoc.limits) {
    base = planDoc.limits.toObject ? planDoc.limits.toObject() : { ...planDoc.limits };
  } else {
    const legacy = planLimits[org.plan] || {};
    base = {
      campaigns: Number.isFinite(legacy.campaigns) ? legacy.campaigns : null, // Infinity → null
      volunteers: Number.isFinite(legacy.volunteers) ? legacy.volunteers : null,
      volunteerEnabled: !!legacy.volunteerEnabled,
    };
  }

  const override = org.override && org.override.limits ? org.override.limits : null;
  const merged = { ...base };
  if (override && typeof override === "object") {
    for (const k of Object.keys(override)) {
      if (override[k] !== undefined) merged[k] = override[k]; // null = unlimited
    }
  }
  return merged;
}

module.exports = { getEffectiveLimits };
