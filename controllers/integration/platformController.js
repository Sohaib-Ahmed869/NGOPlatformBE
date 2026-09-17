/**
 * Integration API — platform-wide views: the operator dashboard and the audit log.
 */
const { dashboardStats } = require("../../services/platformStats");
const { ok } = require("../../utils/integrationResponse");
const { serializeRevenue } = require("./billingController");
const { listAudit } = require("./queries");

/**
 * GET /dashboard — the console dashboard: revenue (same figures as
 * /billing/summary), 12-month signup trend and cross-tenant footprint.
 */
exports.dashboard = async (req, res) => {
  const d = await dashboardStats();
  ok(res, {
    ...serializeRevenue(d),
    growth: {
      new_tenants_this_month: d.newThisMonth,
      growth_pct_vs_last_month: d.growthPct,
      signups_by_month: d.signupSeries.map((s) => ({ month: s.month, year: s.year, count: s.count })),
    },
    footprint: {
      donations_total: d.donationsTotal,
      donations_count: d.donationsCount,
      users: d.totalUsers,
      programs: d.totalPrograms,
      events: d.totalEvents,
      p2p_campaigns: d.totalCampaigns,
    },
  });
};

/** GET /audit?tenant_id=&action=&actor=&target_type=&target_id=&from=&to=&search=&page=&limit= */
exports.audit = async (req, res) => {
  const { data, meta } = await listAudit(req.query);
  ok(res, data, { meta });
};
