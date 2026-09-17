/**
 * Integration API — plans, the feature-flag catalogue, and /ping.
 * Writes go through services/planService.js, shared with the console.
 */
const Plan = require("../../models/plan");
const PlatformAuditLog = require("../../models/platformAuditLog");
const planService = require("../../services/planService");
const { subscriberCounts } = require("../planController");
const { GROUPS, FLAGS, METERS } = require("../../config/featureCatalog");
const input = require("../../utils/operatorInput");
const { ServiceError } = require("../../utils/serviceError");
const { ok } = require("../../utils/integrationResponse");
const S = require("../../utils/integrationSerializers");
const { assertKnownFields, reasonFrom, requireBoolean } = require("./shared");

/** GET /ping — exercises the real auth path; echoes the key NAME, never the key. */
exports.ping = async (req, res) => {
  ok(res, { service: "donexus", key: req.integration.keyName, actor: req.integration.actorEmail || null, time: new Date().toISOString() });
};

/** GET /feature-flags — the catalogue behind plan `feature_flags` and `limits` keys. */
exports.featureFlags = async (req, res) => {
  ok(res, {
    // code / category / name — the same field names as the Stewardex catalogue.
    categories: GROUPS.map((g) => ({ code: g.key, name: g.label, description: g.blurb || "" })),
    flags: FLAGS.map((f) => ({
      code: f.key,
      category: f.group,
      name: f.label,
      description: f.description || "",
      core: !!f.core,
      vertical: f.vertical || null,
    })),
    limits: METERS.map((m) => ({ code: m.key, category: m.group, name: m.label, description: m.description || "", unit: m.unit || null })),
  });
};

/** GET /plans?status=active|archived|all */
exports.list = async (req, res) => {
  const status = input.oneOf(req.query.status, "status", ["active", "archived", "all"], { required: false });
  if (status.error) throw new ServiceError(400, "VALIDATION_ERROR", status.error, { field: "status" });
  const filter = status.value === "active" ? { isActive: { $ne: false } } : status.value === "archived" ? { isActive: false } : {};
  const [plans, counts] = await Promise.all([Plan.find(filter).sort({ sortOrder: 1, createdAt: 1 }).lean(), subscriberCounts()]);
  ok(res, plans.map((p) => S.serializePlan(p, { subscribers: counts[p.code] || { total: 0, active: 0 } })), {
    meta: { total: plans.length },
  });
};

async function planDetail(code) {
  const plan = await Plan.findOne({ code }).lean();
  if (!plan) throw new ServiceError(404, "PLAN_NOT_FOUND", "Plan not found", { code });
  const [counts, audit] = await Promise.all([
    subscriberCounts(),
    PlatformAuditLog.find({ targetType: "plan", targetId: { $in: [code, new RegExp(`(^|,)${input.escapeRegex(code)}(,|$)`)] } })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
  ]);
  return {
    ...S.serializePlan(plan, { subscribers: counts[plan.code] || { total: 0, active: 0 } }),
    price_history: S.serializePriceHistory(plan),
    revisions: audit.map((a) => ({
      id: String(a._id),
      action: a.action,
      actor: a.actorEmail || null,
      at: a.createdAt ? new Date(a.createdAt).toISOString() : null,
      diff: a.meta?.changes || null,
      reason: a.meta?.reason || null,
    })),
  };
}

/** GET /plans/:code */
exports.get = async (req, res) => {
  ok(res, await planDetail(String(req.params.code).toLowerCase()));
};

const WRITE_FIELDS = [
  "name",
  "description",
  "pricing",
  "limits",
  "feature_flags",
  "marketing_features",
  "is_public",
  "is_popular",
  "sort_order",
  "color",
  "reason",
];

/** snake_case wire body → planService's camelCase input. */
function toServiceBody(b) {
  const out = {};
  if (b.name !== undefined) out.name = b.name;
  if (b.description !== undefined) out.description = b.description;
  if (b.limits !== undefined) out.limits = b.limits;
  if (b.feature_flags !== undefined) out.featureFlags = b.feature_flags;
  if (b.marketing_features !== undefined) out.features = b.marketing_features;
  if (b.is_public !== undefined) out.isPublic = requireBoolean(b.is_public, "is_public");
  if (b.is_popular !== undefined) out.isPopular = requireBoolean(b.is_popular, "is_popular");
  if (b.sort_order !== undefined) out.sortOrder = b.sort_order;
  if (b.color !== undefined) {
    if (typeof b.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(b.color)) {
      throw new ServiceError(400, "VALIDATION_ERROR", "color must be a hex colour like #10b981", { field: "color" });
    }
    out.color = b.color;
  }
  if (b.pricing !== undefined) {
    if (b.pricing === null || typeof b.pricing !== "object" || Array.isArray(b.pricing)) {
      throw new ServiceError(400, "VALIDATION_ERROR", "pricing must be an object", { field: "pricing" });
    }
    assertKnownFields(b.pricing, ["currency", "monthly", "yearly", "onboarding_fee"]);
    if (b.pricing.currency !== undefined && String(b.pricing.currency).toUpperCase() !== S.CURRENCY) {
      throw new ServiceError(400, "CURRENCY_MISMATCH", `Plans are priced in ${S.CURRENCY}`, { field: "pricing.currency" });
    }
    const price = {};
    if (b.pricing.monthly !== undefined) price.monthly = b.pricing.monthly;
    if (b.pricing.yearly !== undefined) price.annual = b.pricing.yearly;
    out.price = price;
    if (b.pricing.onboarding_fee !== undefined) out.onboardingFee = b.pricing.onboarding_fee;
  }
  return out;
}

/** POST /plans  { code, name, fork_from?, … } */
exports.create = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["code", "fork_from", ...WRITE_FIELDS]);
  reasonFrom(b);
  const body = { ...toServiceBody(b), code: b.code, forkFrom: b.fork_from };
  const { plan, stripeSynced, warning } = await planService.createPlan(body, req, { strict: true });
  const warnings = stripeSynced === false ? [{ code: "STRIPE_NOT_SYNCED", message: warning }] : [];
  ok(res, await planDetail(plan.code), { status: 201, warnings });
};

/** PATCH /plans/:code — per-key merge for limits/feature_flags, per-cycle for pricing. */
exports.update = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, [...WRITE_FIELDS, "status", "confirm"]);
  reasonFrom(b);
  const body = toServiceBody(b);
  const code = String(req.params.code).toLowerCase();
  const status = input.oneOf(b.status, "status", ["active", "archived"], { required: false });
  if (status.error) throw new ServiceError(400, "VALIDATION_ERROR", status.error, { field: "status" });

  // status "archived" is the same archive as DELETE (and needs the same confirm).
  if (status.value === "archived") {
    if (Object.keys(body).length) {
      throw new ServiceError(400, "VALIDATION_ERROR", "Archive on its own: send status without other fields", { field: "status" });
    }
    const { subscribersAffected } = await planService.archivePlan(code, { confirm: b.confirm === true }, req);
    const data = await planDetail(code);
    data.active_subscriptions = subscribersAffected;
    return ok(res, data);
  }
  if (status.value === "active") body.isActive = true;
  if (!Object.keys(body).length) throw new ServiceError(400, "VALIDATION_ERROR", "Nothing to update");
  const { priceChanged, subscribersAffected } = await planService.updatePlan(code, body, req, { strict: true });
  const data = await planDetail(code);
  data.price_changed = priceChanged;
  // Tenants billed on the previous Stripe price. They keep paying the old
  // amount until migrated (console: Plans → Migrate subscribers).
  data.subscribers_on_previous_price = subscribersAffected;
  const warnings = priceChanged && subscribersAffected
    ? [{ code: "SUBSCRIBERS_GRANDFATHERED", message: `${subscribersAffected} paying tenant(s) stay on the previous price until they are migrated` }]
    : [];
  ok(res, data, { warnings });
};

/** DELETE /plans/:code?confirm=true — archive. Also POST /plans/:code/archive { confirm?, reason? }. */
exports.archive = async (req, res) => {
  if (req.method === "POST") assertKnownFields(req.body || {}, ["confirm", "reason"]);
  const confirm = req.query.confirm === "true" || req.body?.confirm === true;
  const code = String(req.params.code).toLowerCase();
  const { subscribersAffected } = await planService.archivePlan(code, { confirm }, req);
  const data = await planDetail(code);
  data.active_subscriptions = subscribersAffected;
  ok(res, data);
};

/** POST /plans/:code/restore { reason? } — put an archived plan back on sale (same as PATCH status "active"). */
exports.restore = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["reason"]);
  reasonFrom(b);
  const code = String(req.params.code).toLowerCase();
  const plan = await Plan.findOne({ code }).select("isActive").lean();
  if (!plan) throw new ServiceError(404, "PLAN_NOT_FOUND", "Plan not found", { code });
  if (plan.isActive !== false) throw new ServiceError(409, "PLAN_NOT_ARCHIVED", `"${code}" is not archived`, { code });
  await planService.updatePlan(code, { isActive: true }, req, { strict: true });
  ok(res, await planDetail(code));
};

/** POST /plans/:code/sync-stripe — (re)provision or repair the plan's Stripe product and prices. */
exports.syncStripe = async (req, res) => {
  assertKnownFields(req.body || {}, ["reason"]);
  const code = String(req.params.code).toLowerCase();
  await planService.resyncPlan(code, req);
  ok(res, await planDetail(code));
};

/**
 * POST /plans/:code/migrate-subscribers  { proration?, reason? }
 * Moves Stripe-billed tenants on the plan onto its CURRENT price. Moves money
 * when proration is not "none".
 */
exports.migrateSubscribers = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["proration", "reason"]);
  reasonFrom(b);
  const code = String(req.params.code).toLowerCase();
  const { migrated, failed, skipped, stripeEnabled } = await planService.migrateSubscribers(code, { proration: b.proration }, req);
  const warnings = [];
  if (!stripeEnabled) warnings.push({ code: "STRIPE_UNAVAILABLE", message: "Stripe is not configured, so no subscription was moved" });
  if (failed) warnings.push({ code: "MIGRATION_PARTIAL", message: `${failed} subscription(s) could not be moved — see the server log, then retry` });
  ok(res, { plan_code: code, proration: b.proration || "none", migrated, failed, skipped }, { warnings });
};

const matrixPlan = (p) => ({
  code: p.code,
  name: p.name,
  status: p.isActive === false ? "archived" : "active",
  is_public: p.isPublic !== false,
  sort_order: p.sortOrder || 0,
  feature_flags: S.serializePlan(p).feature_flags,
  limits: S.serializePlan(p).limits,
});

/**
 * GET /feature-matrix?status=active|archived|all — every plan's flags and
 * limits side by side (the console's Features screen), plus the catalogue.
 */
exports.featureMatrix = async (req, res) => {
  const status = input.oneOf(req.query.status, "status", ["active", "archived", "all"], { required: false });
  if (status.error) throw new ServiceError(400, "VALIDATION_ERROR", status.error, { field: "status" });
  const filter = status.value === "archived" ? { isActive: false } : status.value === "all" ? {} : { isActive: { $ne: false } };
  const plans = await Plan.find(filter).sort({ sortOrder: 1, createdAt: 1 }).lean();
  ok(res, {
    categories: GROUPS.map((g) => ({ code: g.key, name: g.label, description: g.blurb || "" })),
    flags: FLAGS.map((f) => ({ code: f.key, category: f.group, name: f.label, core: !!f.core, vertical: f.vertical || null })),
    limits: METERS.map((m) => ({ code: m.key, category: m.group, name: m.label, unit: m.unit || null })),
    plans: plans.map(matrixPlan),
  });
};

/**
 * PUT /feature-matrix  { plans: { <code>: { feature_flags?, limits? } }, reason? }
 * Merges PER KEY into each named plan; plans you don't name are untouched. The
 * whole body is validated before any plan is saved.
 */
exports.updateFeatureMatrix = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["plans", "reason"]);
  const reason = reasonFrom(b);
  if (!b.plans || typeof b.plans !== "object" || Array.isArray(b.plans)) {
    throw new ServiceError(400, "VALIDATION_ERROR", "plans must be an object keyed by plan code", { field: "plans" });
  }
  const incoming = {};
  for (const [code, patch] of Object.entries(b.plans)) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new ServiceError(400, "VALIDATION_ERROR", `plans.${code} must be an object`, { field: `plans.${code}` });
    }
    assertKnownFields(patch, ["feature_flags", "limits"]);
    incoming[String(code).toLowerCase()] = { features: patch.feature_flags, limits: patch.limits };
  }
  const { updated, plans } = await planService.updateEntitlements(incoming, req, { strict: true, reason });
  ok(res, { updated, plans: plans.map((p) => matrixPlan(p.toObject ? p.toObject() : p)) });
};
