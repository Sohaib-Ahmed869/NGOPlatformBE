const Plan = require("../models/plan");
const planLimits = require("../config/planLimits");
const { FLAGS, FLAG_KEYS, METER_KEYS } = require("../config/featureCatalog");

/** Mixed/Map/subdoc → plain object. */
function toPlain(v) {
  if (!v) return {};
  if (typeof v.toObject === "function") return v.toObject();
  if (v instanceof Map) return Object.fromEntries(v);
  return { ...v };
}

/**
 * Resolve an organisation's EFFECTIVE entitlements = its plan's feature flags +
 * metered limits, with any per-tenant `override` merged on top.
 *
 * Returns { features:{ [flag]:boolean }, limits:{ [meter]:number|null } }
 * where a `null` limit means UNLIMITED.
 *
 * Backward-compat rules so nothing breaks before the SuperAdmin matrix is set:
 *   - A plan with NO featureFlags configured yet gates nothing (all flags ON).
 *   - Falls back to the legacy static config/planLimits.js when no dynamic Plan
 *     document exists (pre-seed).
 *   - The legacy `volunteerEnabled` flag maps to the `volunteers` capability.
 */
async function getEffectiveEntitlements(org) {
  const planDoc = await Plan.findOne({ code: org.plan }).select("limits featureFlags");

  // ── Feature flags ──────────────────────────────────────────────────────
  const features = {};
  for (const f of FLAGS) features[f.key] = true; // default: available

  const pf = toPlain(planDoc && planDoc.featureFlags);
  const hasFlagConfig = Object.keys(pf).length > 0;
  if (hasFlagConfig) {
    for (const f of FLAGS) {
      features[f.key] = f.core ? true : pf[f.key] !== undefined ? !!pf[f.key] : false;
    }
  } else if (planDoc) {
    // Dynamic plan exists but flags not configured → honour the legacy
    // volunteerEnabled hint if present, leave everything else available.
    const pl = toPlain(planDoc.limits);
    if (pl.volunteerEnabled !== undefined) features.volunteers = !!pl.volunteerEnabled;
  } else {
    // No dynamic plan yet → legacy static config.
    const legacy = planLimits[org.plan] || {};
    if (legacy.volunteerEnabled !== undefined) features.volunteers = !!legacy.volunteerEnabled;
  }

  // ── Metered limits ─────────────────────────────────────────────────────
  const limits = {};
  if (planDoc) {
    const pl = toPlain(planDoc.limits);
    for (const k of METER_KEYS) {
      if (pl[k] !== undefined) limits[k] = pl[k]; // number | null(unlimited)
    }
  } else {
    const legacy = planLimits[org.plan] || {};
    limits.campaigns = Number.isFinite(legacy.campaigns) ? legacy.campaigns : null;
    limits.volunteers = Number.isFinite(legacy.volunteers) ? legacy.volunteers : null;
  }

  // ── Per-tenant override (covers both flags and meters) ─────────────────
  const override = org.override && org.override.limits ? toPlain(org.override.limits) : null;
  if (override) {
    for (const k of Object.keys(override)) {
      const v = override[k];
      if (v === undefined) continue;
      if (k === "volunteerEnabled") features.volunteers = !!v; // legacy key
      // Meter keys win over flag keys. The catalog has keys in BOTH namespaces
      // ("volunteers"), and this used to test flags first — so an override of
      // the volunteers quota flipped the capability flag instead and the quota
      // itself was never applied.
      else if (METER_KEYS.includes(k)) limits[k] = v; // numeric (null = unlimited)
      else if (FLAG_KEYS.includes(k)) features[k] = !!v; // legacy: flags stored in limits
      else limits[k] = v;
    }
  }
  const flagOverride = org.override && org.override.featureFlags ? toPlain(org.override.featureFlags) : null;
  if (flagOverride) {
    for (const f of FLAGS) {
      if (f.core || flagOverride[f.key] === undefined) continue; // core flags cannot be switched off
      features[f.key] = !!flagOverride[f.key];
    }
  }

  return { features, limits };
}

/**
 * Legacy flat shape kept for existing callers (middleware/planEnforcement.js,
 * etc.): the metered limits with `volunteerEnabled` folded back in.
 */
async function getEffectiveLimits(org) {
  const { features, limits } = await getEffectiveEntitlements(org);
  return { ...limits, volunteerEnabled: !!features.volunteers };
}

module.exports = { getEffectiveEntitlements, getEffectiveLimits };
