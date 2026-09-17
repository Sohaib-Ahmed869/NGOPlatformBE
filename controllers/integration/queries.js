/**
 * Read-only list queries used by more than one integration controller:
 * platform invoices and the operator audit log, each either platform-wide or
 * scoped to one tenant.
 */
const mongoose = require("mongoose");
const Organisation = require("../../models/organisation");
const PlatformInvoice = require("../../models/platformInvoice");
const PlatformAuditLog = require("../../models/platformAuditLog");
const input = require("../../utils/operatorInput");
const { ServiceError } = require("../../utils/serviceError");
const S = require("../../utils/integrationSerializers");
const { isObjectId } = require("./shared");

const INVOICE_STATUSES = ["draft", "open", "paid", "failed", "void", "uncollectible"];
const TENANT_FIELDS = "name slug";

const bad = (message, field) => new ServiceError(400, "VALIDATION_ERROR", message, { field });

/**
 * `from` / `to` on createdAt. A date-only `to` ("2026-08-12") means through the
 * END of that day — as a timestamp it is midnight and would exclude the day.
 */
function dateRange(query) {
  const range = {};
  for (const [key, op] of [["from", "$gte"], ["to", "$lte"]]) {
    if (query[key] === undefined || query[key] === "") continue;
    const raw = input.filterValue(query[key]).trim();
    const d = new Date(raw);
    if (!raw || Number.isNaN(d.getTime())) throw bad(`${key} is not a valid date`, key);
    if (key === "to" && /^\d{4}-\d{2}-\d{2}$/.test(raw)) d.setUTCHours(23, 59, 59, 999);
    range[op] = d;
  }
  return Object.keys(range).length ? range : null;
}

function tenantIdFilter(query) {
  if (query.tenant_id === undefined || query.tenant_id === "") return null;
  const tid = input.filterValue(query.tenant_id);
  if (!isObjectId(tid)) throw bad("tenant_id is not a valid id", "tenant_id");
  return new mongoose.Types.ObjectId(tid);
}

/** Tenants whose name or slug matches a search term. */
async function tenantIdsMatching(rx) {
  const orgs = await Organisation.find({ $or: [{ name: rx }, { slug: rx }] }).select("_id").lean();
  return orgs.map((o) => o._id);
}

/**
 * Platform invoices (the Stripe mirror of what Donexus bills its tenants),
 * newest first, plus money totals across the WHOLE filtered set.
 * @param {object} query   status, tenant_id, search, from, to, page, limit
 * @param {object} [scope]
 * @param {import("mongoose").Types.ObjectId} [scope.organisationId]  force one tenant
 */
async function listInvoices(query = {}, { organisationId } = {}) {
  const filter = {};
  const status = input.oneOf(query.status, "status", INVOICE_STATUSES, { required: false });
  if (status.error) throw bad(status.error, "status");
  if (status.value) filter.status = status.value;

  const tid = organisationId || tenantIdFilter(query);
  if (tid) filter.organisationId = tid;
  const range = dateRange(query);
  if (range) filter.createdAt = range;

  const rx = input.searchRegex(query.search);
  if (rx) {
    filter.$or = [{ number: rx }, { stripeInvoiceId: rx }];
    if (!organisationId) {
      const ids = await tenantIdsMatching(rx);
      if (ids.length) filter.$or.push({ organisationId: { $in: ids } });
    }
  }

  const { page, limit, skip } = input.paging(query, { defaultLimit: 50, maxLimit: 200 });
  const [rows, agg] = await Promise.all([
    PlatformInvoice.find(filter).populate("organisationId", TENANT_FIELDS).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    PlatformInvoice.aggregate([
      { $match: filter },
      {
        $facet: {
          total: [{ $count: "n" }],
          paid: [{ $match: { status: "paid" } }, { $group: { _id: null, amount: { $sum: "$amountPaid" }, count: { $sum: 1 } } }],
          outstanding: [
            { $match: { status: { $in: ["open", "failed", "uncollectible"] } } },
            { $group: { _id: null, amount: { $sum: "$amountDue" }, count: { $sum: 1 } } },
          ],
        },
      },
    ]),
  ]);
  const f = agg[0] || {};
  const total = f.total?.[0]?.n || 0;
  return {
    data: rows.map(S.serializeInvoice),
    meta: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      totals: {
        currency: S.CURRENCY,
        paid_amount: f.paid?.[0]?.amount || 0,
        paid_count: f.paid?.[0]?.count || 0,
        outstanding_amount: f.outstanding?.[0]?.amount || 0,
        outstanding_count: f.outstanding?.[0]?.count || 0,
      },
    },
  };
}

/**
 * The platform operator audit log, newest first — console actions AND every
 * integration write (actor "integration:<key> (<x-actor-email>)").
 * @param {object} query   tenant_id, action, actor, target_type, target_id, from, to, search, page, limit
 * @param {object} [scope]
 * @param {import("mongoose").Types.ObjectId} [scope.organisationId]  force one tenant
 */
async function listAudit(query = {}, { organisationId } = {}) {
  const filter = {};
  const tid = organisationId || tenantIdFilter(query);
  if (tid) filter.organisationId = tid;

  for (const [param, path] of [["action", "action"], ["target_type", "targetType"], ["target_id", "targetId"]]) {
    const v = input.scalarFilter(query[param], param);
    if (v.error) throw bad(v.error, param);
    if (v.value) filter[path] = v.value;
  }
  // `actor` matches the recorded actor label, so "integration:hyper" finds every call made with that key.
  const actorRx = input.searchRegex(query.actor);
  if (actorRx) filter.actorEmail = actorRx;
  const range = dateRange(query);
  if (range) filter.createdAt = range;

  const rx = input.searchRegex(query.search);
  if (rx) {
    filter.$or = [{ action: rx }, { actorEmail: rx }, { targetId: rx }, { targetType: rx }];
    if (!organisationId) {
      const ids = await tenantIdsMatching(rx);
      if (ids.length) filter.$or.push({ organisationId: { $in: ids } });
    }
  }

  const { page, limit, skip } = input.paging(query, { defaultLimit: 100, maxLimit: 500 });
  const [rows, total] = await Promise.all([
    PlatformAuditLog.find(filter).select("-ip -userAgent").populate("organisationId", TENANT_FIELDS).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    PlatformAuditLog.countDocuments(filter),
  ]);
  return { data: rows.map(S.serializeAudit), meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

module.exports = { INVOICE_STATUSES, listInvoices, listAudit };
