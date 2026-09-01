const TIERS = {
  essentials: { campaigns: 3, volunteers: 0, volunteerEnabled: false },
  professional: { campaigns: 5, volunteers: 10, volunteerEnabled: true },
  enterprise: { campaigns: Infinity, volunteers: Infinity, volunteerEnabled: true },
};

module.exports = {
  ...TIERS,
  // Pre-rename code for the entry tier, aliased BY REFERENCE so the two can
  // never drift. This map is the fallback used when an organisation has no
  // dynamic Plan document, and a lookup miss there does not error — it silently
  // hands back no quota at all, so a stray "basic" would read as unlimited-ish
  // rather than as tier 1. See config/planTiers.js for the matching rank alias.
  basic: TIERS.essentials,
};
