/**
 * Plan ranking + which plan a page's CONTENT editing requires.
 * Lower plans can still show/hide/reorder any page — they just can't customise
 * the content of pages above their tier (those keep their default content).
 */
const PLAN_RANK = {
  essentials: 1,
  professional: 2,
  enterprise: 3,
  // Legacy alias. The entry tier was coded "basic" until it was renamed to
  // Essentials; keeping the rank here means an old ?plan=basic link, a webhook
  // replaying an old payload, or a row the rename migration missed still ranks
  // as tier 1 instead of falling through planRank's `|| 1` default and only
  // APPEARING to work.
  basic: 1,
};

// Pages not listed here default to "essentials" (editable on every plan).
const PAGE_MIN_PLAN = {
  initiatives: "professional",
  education: "professional",
  food: "professional",
  water: "professional",
  emergencies: "professional",
  giving: "enterprise",
  ramadan: "enterprise",
  zakat: "enterprise",
};

function planRank(plan) {
  return PLAN_RANK[plan] || 1;
}

function pageMinPlan(key) {
  return PAGE_MIN_PLAN[key] || "essentials";
}

/** Does `orgPlan` meet the minimum `requiredPlan`? */
function planAllows(orgPlan, requiredPlan) {
  return planRank(orgPlan) >= planRank(requiredPlan || "essentials");
}

module.exports = { PLAN_RANK, PAGE_MIN_PLAN, planRank, pageMinPlan, planAllows };
