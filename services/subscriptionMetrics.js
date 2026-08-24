const planPricing = require("../config/planPricing");

/**
 * Shared subscription roll-ups for the SuperAdmin console.
 *
 * This exists because the Billing screen and the Dashboard each computed MRR
 * their own way. Billing was corrected to normalise annual subscribers, comped
 * tenants and per-tenant price overrides; the Dashboard kept the naive
 * `count × monthly` — so the two screens quoted different MRR for the same
 * month ($4,100 vs $4,000). One implementation, used by both, is the only way
 * that stays fixed.
 *
 * A tenant's real monthly contribution is not the plan's monthly price:
 *   - annual subscribers pay a (usually discounted) yearly figure → ÷12
 *   - comped tenants pay nothing at all → excluded from revenue, counted as subs
 *   - an operator can set a per-tenant price override → wins over the list price
 */

const ACTIVE = { isActive: true, subscriptionStatus: "active" };

// `null` on an override field means "not overridden".
const isSet = (path) => ({ $ne: [{ $ifNull: [path, null] }, null] });
const overrideSum = (path) => ({ $sum: { $cond: [isSet(path), path, 0] } });
const overrideCount = (path) => ({ $sum: { $cond: [isSet(path), 1, 0] } });

/**
 * $facet branches for every Organisation roll-up the console needs, so one pass
 * over the collection replaces the pile of countDocuments + aggregate calls both
 * endpoints used to fire.
 *
 * @param {object} [extra] additional named branches to merge in (e.g. the
 *        dashboard's signup buckets). Spread last so callers can extend without
 *        this module knowing about their screen.
 */
function orgFacet(extra = {}) {
  return {
    $facet: {
      total: [{ $count: "n" }],
      active: [{ $match: ACTIVE }, { $count: "n" }],
      pastDue: [{ $match: { subscriptionStatus: "past_due" } }, { $count: "n" }],
      comped: [{ $match: { ...ACTIVE, isComp: true } }, { $count: "n" }],
      // Everyone active, for the plan-mix donut — comped tenants are real
      // subscribers even though they contribute no revenue.
      planMix: [{ $match: ACTIVE }, { $group: { _id: "$plan", count: { $sum: 1 } } }],
      // Revenue-bearing subscribers, split by plan AND billing cycle.
      revenue: [
        { $match: { ...ACTIVE, isComp: { $ne: true } } },
        {
          $group: {
            _id: { plan: "$plan", cycle: { $ifNull: ["$billingCycle", "monthly"] } },
            count: { $sum: 1 },
            ovMonthlySum: overrideSum("$override.pricing.monthly"),
            ovMonthlyCount: overrideCount("$override.pricing.monthly"),
            ovAnnualSum: overrideSum("$override.pricing.annual"),
            ovAnnualCount: overrideCount("$override.pricing.annual"),
          },
        },
      ],
      ...extra,
    },
  };
}

/** The legacy static tiers, used until the Plan collection has been seeded. */
const LEGACY_TIERS = [
  ["basic", "Basic", "#06b6d4"],
  ["professional", "Professional", "#10b981"],
  ["enterprise", "Enterprise", "#f59e0b"],
];

function basePlans(planDocs) {
  if (planDocs && planDocs.length) {
    return planDocs.map((p) => ({
      code: p.code,
      name: p.name,
      color: p.color || "#10b981",
      monthly: p.price?.monthly || 0,
      annual: p.price?.annual || 0,
    }));
  }
  return LEGACY_TIERS.map(([code, name, color]) => ({
    code,
    name,
    color,
    monthly: planPricing[code]?.monthly || 0,
    annual: planPricing[code]?.annual || 0,
  }));
}

const firstCount = (arr) => arr?.[0]?.n || 0;

/**
 * Turn a facet result + the Plan catalogue into the numbers both screens show.
 *
 * @returns {{totalOrgs, activeOrgs, failedPayments, compedSubscriptions,
 *            plans, mrr, byCycle, byPlan}}
 *          `plans[]` carries `count` (all active subscribers on the plan),
 *          `payingCount` (excludes comps) and monthly-normalised `revenue`.
 */
function summarise(facetResult, planDocs) {
  const f = facetResult || {};

  const countByCode = {};
  (f.planMix || []).forEach((p) => {
    countByCode[p._id] = p.count;
  });

  const base = basePlans(planDocs);
  const byCode = Object.fromEntries(
    base.map((p) => [p.code, { ...p, count: countByCode[p.code] || 0, payingCount: 0, revenue: 0 }]),
  );

  const byCycle = { monthly: 0, annual: 0 };
  for (const row of f.revenue || []) {
    const cycle = row._id.cycle === "annual" ? "annual" : "monthly";
    byCycle[cycle] += row.count;
    const plan = byCode[row._id.plan];
    if (!plan) continue; // a tenant sitting on a plan that no longer exists
    const listMonthly = cycle === "annual" ? (plan.annual || 0) / 12 : plan.monthly || 0;
    const ovCount = cycle === "annual" ? row.ovAnnualCount : row.ovMonthlyCount;
    const ovMonthly = cycle === "annual" ? (row.ovAnnualSum || 0) / 12 : row.ovMonthlySum || 0;
    plan.payingCount += row.count;
    // Overridden tenants pay their override; everyone else pays list.
    plan.revenue += Math.max(row.count - ovCount, 0) * listMonthly + ovMonthly;
  }

  const plans = base.map((p) => ({ ...byCode[p.code], revenue: Math.round(byCode[p.code].revenue) }));
  const byPlan = {};
  plans.forEach((p) => {
    byPlan[p.code] = p.count;
  });

  return {
    totalOrgs: firstCount(f.total),
    activeOrgs: firstCount(f.active),
    failedPayments: firstCount(f.pastDue),
    compedSubscriptions: firstCount(f.comped),
    plans,
    mrr: plans.reduce((sum, p) => sum + p.revenue, 0),
    byCycle,
    byPlan,
  };
}

module.exports = { ACTIVE, orgFacet, summarise, firstCount };
