/**
 * services/platformStats.js — the platform-wide roll-ups behind the SuperAdmin
 * Billing and Dashboard screens.
 *
 * Shared by the console (controllers/superAdminController.js) and the
 * integration API (controllers/integration/platformController.js) so Calcite
 * Hyper and the console can never quote different MRR for the same month. MRR
 * normalisation itself (annual cycles, comps, overrides) is in
 * services/subscriptionMetrics.js. Everything is aggregated live.
 */
const Organisation = require("../models/organisation");
const User = require("../models/user");
const Plan = require("../models/plan");
const PlatformInvoice = require("../models/platformInvoice");
const Program = require("../models/program");
const Event = require("../models/event");
const Order = require("../models/order");
const GoFundMe = require("../models/goFundMe");
const Join = require("../models/join");
const subscriptionMetrics = require("./subscriptionMetrics");

const activePlans = () => Plan.find({ isActive: true }).sort({ sortOrder: 1 }).select("code name price color").lean();

// Lifetime revenue actually collected (paid invoices in the Stripe mirror).
const collectedTotal = () =>
  PlatformInvoice.aggregate([{ $match: { status: "paid" } }, { $group: { _id: null, total: { $sum: "$amountPaid" } } }]).then(
    (rows) => rows[0]?.total || 0,
  );

const recentSignups = (limit) =>
  Organisation.find({ deletedAt: null })
    .populate("adminUserId", "name email")
    .sort({ createdAt: -1 })
    .limit(limit)
    .select("name slug plan subscriptionStatus createdAt branding")
    .lean();

/** The Billing screen: subscriptions, MRR per plan and cycle, collected revenue. */
async function billingStats() {
  const [orgFacetRes, signups, planDocs, collected] = await Promise.all([
    Organisation.aggregate([{ $match: { deletedAt: null } }, subscriptionMetrics.orgFacet()]),
    recentSignups(10),
    activePlans(),
    collectedTotal(),
  ]);
  const m = subscriptionMetrics.summarise(orgFacetRes[0], planDocs);
  return {
    totalOrganisations: m.totalOrgs,
    activeSubscriptions: m.activeOrgs,
    failedPayments: m.failedPayments,
    mrr: m.mrr,
    collected, // lifetime revenue collected
    compedSubscriptions: m.compedSubscriptions, // active but paying nothing
    byCycle: m.byCycle, // revenue-bearing subscribers per billing cycle
    plans: m.plans, // each carries `count`, `payingCount` and monthly-normalised `revenue`
    byPlan: m.byPlan, // back-compat for any older consumer
    recentSignups: signups,
  };
}

/**
 * The Dashboard: subscription health, a real 12-month signup trend with
 * month-over-month growth, and cross-tenant footprint totals.
 */
async function dashboardStats() {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

  // One pass over Organisations for every roll-up; the growth branches ride
  // along on the shared facet.
  const [orgFacetRes, signups, planDocs, collected, donationsAgg, counts] = await Promise.all([
    Organisation.aggregate([
      { $match: { deletedAt: null } },
      subscriptionMetrics.orgFacet({
        newThisMonth: [{ $match: { createdAt: { $gte: startOfMonth } } }, { $count: "n" }],
        newLastMonth: [{ $match: { createdAt: { $gte: startOfLastMonth, $lt: startOfMonth } } }, { $count: "n" }],
        signupBuckets: [
          { $match: { createdAt: { $gte: twelveMonthsAgo } } },
          { $group: { _id: { y: { $year: "$createdAt" }, m: { $month: "$createdAt" } }, count: { $sum: 1 } } },
        ],
      }),
    ]),
    recentSignups(8),
    activePlans(),
    collectedTotal(),
    Order.aggregate([
      { $match: { paymentStatus: "completed" } },
      { $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
    ]),
    // Footprint counts across four separate collections — genuinely parallel.
    Promise.all([User.estimatedDocumentCount(), Program.estimatedDocumentCount(), Event.estimatedDocumentCount(), GoFundMe.estimatedDocumentCount()]),
  ]);

  const f = orgFacetRes[0] || {};
  const m = subscriptionMetrics.summarise(f, planDocs);
  const [totalUsers, totalPrograms, totalEvents, totalCampaigns] = counts;
  const newThisMonth = subscriptionMetrics.firstCount(f.newThisMonth);
  const newLastMonth = subscriptionMetrics.firstCount(f.newLastMonth);

  // A continuous 12-month signup series (zero-filled).
  const bucketMap = {};
  (f.signupBuckets || []).forEach((b) => {
    bucketMap[`${b._id.y}-${b._id.m}`] = b.count;
  });
  const signupSeries = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    signupSeries.push({
      month: d.toLocaleString("en-US", { month: "short" }),
      year: d.getFullYear(),
      count: bucketMap[`${d.getFullYear()}-${d.getMonth() + 1}`] || 0,
    });
  }
  const growthPct = newLastMonth ? Math.round(((newThisMonth - newLastMonth) / newLastMonth) * 100) : newThisMonth > 0 ? 100 : 0;

  return {
    totalOrganisations: m.totalOrgs,
    activeSubscriptions: m.activeOrgs,
    failedPayments: m.failedPayments,
    compedSubscriptions: m.compedSubscriptions,
    mrr: m.mrr,
    collected,
    byCycle: m.byCycle,
    plans: m.plans,
    recentSignups: signups,
    // Cross-tenant footprint
    donationsTotal: donationsAgg[0]?.total || 0,
    donationsCount: donationsAgg[0]?.count || 0,
    totalUsers,
    totalPrograms,
    totalEvents,
    totalCampaigns,
    // Growth
    newThisMonth,
    growthPct,
    signupSeries,
  };
}

/**
 * One tenant by the numbers, plus current usage of its metered limits
 * (mirrors planEnforcement counting: campaigns = active Programs, volunteers =
 * Join applications).
 * @returns {Promise<{usage:{campaigns:number, volunteers:number}, stats:object}>}
 */
async function tenantFootprint(orgId) {
  const [programAgg, volunteersTotal, usersTotal, eventsTotal, p2pTotal, orderAgg] = await Promise.all([
    // One Programs scan yields both counts.
    Program.aggregate([
      { $match: { organisationId: orgId } },
      { $group: { _id: null, total: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] } } } },
    ]),
    Join.countDocuments({ organisationId: orgId }),
    User.countDocuments({ organisationId: orgId }),
    Event.countDocuments({ organisationId: orgId }),
    GoFundMe.countDocuments({ organisationId: orgId }),
    // One Orders scan yields the count and the paid-donations sum.
    Order.aggregate([
      { $match: { organisationId: orgId } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          donationsRaised: { $sum: { $cond: [{ $in: ["$paymentStatus", ["completed", "active"]] }, "$totalAmount", 0] } },
        },
      },
    ]),
  ]);
  return {
    usage: { campaigns: programAgg[0]?.active || 0, volunteers: volunteersTotal },
    stats: {
      users: usersTotal,
      programs: programAgg[0]?.total || 0,
      events: eventsTotal,
      campaigns: p2pTotal, // P2P fundraisers (GoFundMe)
      volunteers: volunteersTotal,
      orders: orderAgg[0]?.count || 0,
      donationsRaised: orderAgg[0]?.donationsRaised || 0,
    },
  };
}

module.exports = { billingStats, dashboardStats, tenantFootprint };
