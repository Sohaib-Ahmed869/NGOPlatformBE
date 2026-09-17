/**
 * Integration API — platform billing: the revenue summary, the invoices
 * Donexus bills its tenants (mirrored from Stripe), and discount coupons.
 * Coupon writes go through services/couponService.js, shared with the console.
 */
const mongoose = require("mongoose");
const PlatformInvoice = require("../../models/platformInvoice");
const couponService = require("../../services/couponService");
const { billingStats } = require("../../services/platformStats");
const input = require("../../utils/operatorInput");
const { ServiceError } = require("../../utils/serviceError");
const { ok } = require("../../utils/integrationResponse");
const S = require("../../utils/integrationSerializers");
const { assertKnownFields, reasonFrom, isObjectId } = require("./shared");
const { listInvoices } = require("./queries");

/* ── revenue summary ───────────────────────────────────────────────────── */

/** Plan rows and cycle counts in the snake_case contract. Shared with /dashboard. */
function serializeRevenue(m) {
  return {
    currency: S.CURRENCY,
    mrr: m.mrr,
    arr: m.mrr * 12,
    collected_lifetime: m.collected,
    tenants_total: m.totalOrganisations,
    subscriptions_active: m.activeSubscriptions,
    subscriptions_comped: m.compedSubscriptions,
    subscriptions_past_due: m.failedPayments,
    paying_by_cycle: { monthly: m.byCycle?.monthly || 0, yearly: m.byCycle?.annual || 0 },
    plans: (m.plans || []).map((p) => ({
      code: p.code,
      name: p.name,
      subscribers: p.count || 0,
      paying_subscribers: p.payingCount || 0,
      mrr: p.revenue || 0,
      list_price: { monthly: p.monthly || 0, yearly: p.annual || 0 },
    })),
    recent_signups: (m.recentSignups || []).map((o) => ({
      id: String(o._id),
      name: o.name,
      slug: o.slug,
      plan_code: o.plan || null,
      subscription_status: o.subscriptionStatus,
      owner: o.adminUserId && o.adminUserId.email ? { id: String(o.adminUserId._id), name: o.adminUserId.name || "", email: o.adminUserId.email } : null,
      created_at: o.createdAt ? new Date(o.createdAt).toISOString() : null,
    })),
  };
}

/**
 * GET /billing/summary — MRR (monthly-normalised: annual ÷ 12, comps excluded,
 * per-tenant override prices applied), subscriber counts per plan and cycle,
 * lifetime collected revenue. Same numbers as the console's Billing screen.
 */
exports.summary = async (req, res) => {
  ok(res, serializeRevenue(await billingStats()));
};
exports.serializeRevenue = serializeRevenue;

/* ── invoices ──────────────────────────────────────────────────────────── */

/** GET /invoices?status=&tenant_id=&search=&from=&to=&page=&limit= */
exports.listInvoices = async (req, res) => {
  const { data, meta } = await listInvoices(req.query);
  ok(res, data, { meta });
};

/** GET /invoices/:invoiceId — by Donexus id or Stripe invoice id (in_…). */
exports.getInvoice = async (req, res) => {
  const key = String(req.params.invoiceId || "");
  const filter = isObjectId(key) ? { _id: new mongoose.Types.ObjectId(key) } : /^in_[A-Za-z0-9]+$/.test(key) ? { stripeInvoiceId: key } : null;
  if (!filter) throw new ServiceError(400, "VALIDATION_ERROR", "invoiceId must be an invoice id or a Stripe invoice id (in_…)", { field: "invoiceId" });
  const inv = await PlatformInvoice.findOne(filter).populate("organisationId", "name slug").lean();
  if (!inv) throw new ServiceError(404, "INVOICE_NOT_FOUND", "No invoice with that id", { invoice_id: key });
  ok(res, S.serializeInvoice(inv));
};

/* ── coupons ───────────────────────────────────────────────────────────── */

const COUPON_FIELDS = ["code", "description", "type", "value", "currency", "duration", "duration_in_months", "plan_codes", "max_redemptions", "redeem_by", "reason"];

/** snake_case wire body → couponService's camelCase input. */
const toCouponInput = (b) => ({
  code: b.code,
  description: b.description,
  type: b.type,
  value: b.value,
  currency: b.currency,
  duration: b.duration,
  durationInMonths: b.duration_in_months,
  planCodes: b.plan_codes,
  maxRedemptions: b.max_redemptions,
  redeemBy: b.redeem_by,
});

const syncWarnings = (sync) => (sync && sync.stripeSynced === false ? [{ code: "STRIPE_NOT_SYNCED", message: sync.warning }] : []);

/** GET /coupons?status=active|archived|all — redemption counts refreshed from Stripe. */
exports.listCoupons = async (req, res) => {
  const status = input.oneOf(req.query.status, "status", ["active", "archived", "all"], { required: false });
  if (status.error) throw new ServiceError(400, "VALIDATION_ERROR", status.error, { field: "status" });
  const { coupons, stripeEnabled } = await couponService.listCoupons();
  const rows = coupons.map(S.serializeCoupon).filter((c) => !status.value || status.value === "all" || c.status === status.value);
  ok(res, rows, { meta: { total: rows.length, stripe_enabled: stripeEnabled } });
};

/** GET /coupons/:code */
exports.getCoupon = async (req, res) => {
  ok(res, S.serializeCoupon(await couponService.getCoupon(req.params.code)));
};

/** POST /coupons */
exports.createCoupon = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, COUPON_FIELDS);
  reasonFrom(b);
  const { coupon, sync } = await couponService.createCoupon(toCouponInput(b), req);
  ok(res, S.serializeCoupon(coupon), { status: 201, warnings: syncWarnings(sync) });
};

/** PATCH /coupons/:code  { description?, plan_codes? } — discount terms are immutable; use /replace. */
exports.updateCoupon = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["description", "plan_codes", "reason"]);
  reasonFrom(b);
  const { coupon } = await couponService.updateCoupon(req.params.code, { description: b.description, planCodes: b.plan_codes }, req);
  ok(res, S.serializeCoupon(coupon));
};

/** POST /coupons/:code/replace — archive + reissue with new terms (same or new code). */
exports.replaceCoupon = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, COUPON_FIELDS);
  reasonFrom(b);
  const { coupon, archived, inPlace, sync } = await couponService.replaceCoupon(req.params.code, toCouponInput(b), req);
  const data = S.serializeCoupon(coupon);
  data.replaced = { code: String(req.params.code).toUpperCase(), in_place: inPlace, archived_code: archived };
  ok(res, data, { status: 201, warnings: syncWarnings(sync) });
};

/** POST /coupons/:code/archive */
exports.archiveCoupon = async (req, res) => {
  assertKnownFields(req.body || {}, ["reason"]);
  const { coupon } = await couponService.archiveCoupon(req.params.code, req);
  ok(res, S.serializeCoupon(coupon));
};

/** POST /coupons/:code/restore */
exports.restoreCoupon = async (req, res) => {
  assertKnownFields(req.body || {}, ["reason"]);
  const { coupon, sync } = await couponService.restoreCoupon(req.params.code, req);
  ok(res, S.serializeCoupon(coupon), { warnings: syncWarnings(sync) });
};

/** DELETE /coupons/:code — only a never-redeemed coupon; otherwise 409 COUPON_REDEEMED. */
exports.deleteCoupon = async (req, res) => {
  const { deleted } = await couponService.deleteCoupon(req.params.code, req);
  ok(res, { code: deleted, deleted: true });
};
