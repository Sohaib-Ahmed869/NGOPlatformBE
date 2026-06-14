/**
 * Plan ranking + which plan a page's CONTENT editing requires.
 * Lower plans can still show/hide/reorder any page — they just can't customise
 * the content of pages above their tier (those keep their default content).
 */
const PLAN_RANK = { basic: 1, professional: 2, enterprise: 3 };

// Pages not listed here default to "basic" (editable on every plan).
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
  return PAGE_MIN_PLAN[key] || "basic";
}

/** Does `orgPlan` meet the minimum `requiredPlan`? */
function planAllows(orgPlan, requiredPlan) {
  return planRank(orgPlan) >= planRank(requiredPlan || "basic");
}

module.exports = { PLAN_RANK, PAGE_MIN_PLAN, planRank, pageMinPlan, planAllows };
