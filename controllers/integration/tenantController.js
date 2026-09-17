/**
 * Integration API — tenants (Donexus: Organisation) and their plan/override.
 * Lifecycle rules live in services/tenantLifecycle.js, shared with the console.
 */
const Organisation = require("../../models/organisation");
const Plan = require("../../models/plan");
const PlatformAuditLog = require("../../models/platformAuditLog");
const PlatformInvoice = require("../../models/platformInvoice");
const writeAudit = require("../../utils/writeAudit");
const input = require("../../utils/operatorInput");
const lifecycle = require("../../services/tenantLifecycle");
const tenantAdmins = require("../../services/tenantAdminService");
const { tenantFootprint } = require("../../services/platformStats");
const { provisionOrganisation } = require("../../services/tenantProvisioning");
const { portalHost, portalScheme } = require("../../services/orgActivation");
const { sendTemplateEmail } = require("../../services/emailUtil");
const { emitToSuperAdmins } = require("../../services/socket");
const { getEffectiveEntitlements } = require("../../utils/effectiveLimits");
const { ServiceError } = require("../../utils/serviceError");
const { ok } = require("../../utils/integrationResponse");
const S = require("../../utils/integrationSerializers");
const { assertKnownFields, reasonFrom, requireBoolean } = require("./shared");
const { listInvoices, listAudit } = require("./queries");

// Credentials and draft/config blobs never leave the server.
const LIST_PROJECTION = "-payment -paypal -email -bankDetails -pendingAdmin -pendingAdminNoPassword -draftDesign -design -volunteerQuestions -eventAudiences -branding";

const STATUS_FILTERS = {
  active: { deletedAt: null, isActive: true },
  suspended: { deletedAt: null, isActive: false, $nor: [{ subscriptionStatus: "pending", adminUserId: null }] },
  pending: { deletedAt: null, isActive: false, subscriptionStatus: "pending", adminUserId: null },
  deleted: { deletedAt: { $ne: null } },
  all: {},
};

/** { orgId: { start, end } } — the latest PAID platform invoice period per tenant, in one query. */
async function latestPaidPeriods(orgIds) {
  if (!orgIds.length) return {};
  const rows = await PlatformInvoice.aggregate([
    { $match: { organisationId: { $in: orgIds }, status: "paid", periodEnd: { $ne: null } } },
    { $sort: { periodEnd: -1 } },
    { $group: { _id: "$organisationId", start: { $first: "$periodStart" }, end: { $first: "$periodEnd" } } },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id), { start: r.start, end: r.end }]));
}

/** Tenant row + override + effective entitlements (+ recent activity for GET). */
async function tenantFull(org, { withActivity = false } = {}) {
  await org.populate("adminUserId", "name email");
  const [plan, periods, entitlements, audit, invoices, footprint] = await Promise.all([
    Plan.findOne({ code: org.plan }).select("code name price isActive").lean(),
    latestPaidPeriods([org._id]),
    getEffectiveEntitlements(org),
    withActivity ? PlatformAuditLog.find({ organisationId: org._id }).sort({ createdAt: -1 }).limit(20).lean() : null,
    withActivity ? PlatformInvoice.find({ organisationId: org._id }).sort({ createdAt: -1 }).limit(10).lean() : null,
    withActivity ? tenantFootprint(org._id) : null,
  ]);
  const out = {
    ...S.serializeTenant(org, { plan, period: periods[String(org._id)] }),
    override: S.serializeOverride(org),
    entitlements: { feature_flags: entitlements.features, limits: entitlements.limits },
  };
  if (withActivity) {
    out.recent_events = audit.map(S.serializeAudit);
    out.recent_invoices = invoices.map(S.serializeInvoice);
    out.usage = footprint.usage;
    out.stats = {
      users: footprint.stats.users,
      programs: footprint.stats.programs,
      events: footprint.stats.events,
      p2p_campaigns: footprint.stats.campaigns,
      volunteers: footprint.stats.volunteers,
      orders: footprint.stats.orders,
      donations_raised: footprint.stats.donationsRaised,
    };
  }
  return out;
}

/** GET /tenants?status=&plan_code=&search=&page=&limit= */
exports.list = async (req, res) => {
  const status = input.oneOf(req.query.status, "status", Object.keys(STATUS_FILTERS), { required: false });
  if (status.error) throw new ServiceError(400, "VALIDATION_ERROR", status.error, { field: "status" });
  const planCode = input.scalarFilter(req.query.plan_code, "plan_code");
  if (planCode.error) throw new ServiceError(400, "VALIDATION_ERROR", planCode.error, { field: "plan_code" });
  const { page, limit, skip } = input.paging(req.query, { defaultLimit: 100, maxLimit: 500 });

  // No status → every tenant that isn't soft-deleted (ask for deleted/all explicitly).
  const filter = { ...(status.value ? STATUS_FILTERS[status.value] : { deletedAt: null }) };
  if (planCode.value) filter.plan = planCode.value.toLowerCase();
  const rx = input.searchRegex(req.query.search);
  if (rx) filter.$or = [{ name: rx }, { slug: rx }];

  const [orgs, total] = await Promise.all([
    Organisation.find(filter)
      .select(LIST_PROJECTION)
      .populate("adminUserId", "name email")
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Organisation.countDocuments(filter),
  ]);

  const codes = [...new Set(orgs.map((o) => o.plan).filter(Boolean))];
  const [plans, periods] = await Promise.all([
    codes.length ? Plan.find({ code: { $in: codes } }).select("code name price isActive").lean() : [],
    latestPaidPeriods(orgs.map((o) => o._id)),
  ]);
  const planByCode = Object.fromEntries(plans.map((p) => [p.code, p]));

  ok(res, orgs.map((o) => S.serializeTenant(o, { plan: planByCode[o.plan], period: periods[String(o._id)] })), {
    meta: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

/** GET /tenants/:id */
exports.get = async (req, res) => {
  ok(res, await tenantFull(req.tenant, { withActivity: true }));
};

const CREATE_FIELDS = [
  "organization_name",
  "organisation_name",
  "slug",
  "email",
  "first_name",
  "last_name",
  "name",
  "password",
  "plan_code",
  "billing_cycle",
  "trial_days",
  "is_comp",
  "comp_reason",
  "is_muslim_charity",
  "send_welcome_email",
  "reason",
];

/** POST /tenants — provision an organisation + its owner (admin) user. */
exports.create = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, CREATE_FIELDS);

  const orgName = b.organization_name ?? b.organisation_name;
  const first = input.text(b.first_name, "first_name", { max: 100 });
  const last = input.text(b.last_name, "last_name", { max: 100 });
  const full = input.text(b.name, "name", { max: 200 });
  for (const [r, field] of [[first, "first_name"], [last, "last_name"], [full, "name"]]) {
    if (r.error) throw new ServiceError(400, "VALIDATION_ERROR", r.error, { field });
  }
  const adminName = full.value || `${first.value} ${last.value}`.trim();
  if (!adminName) throw new ServiceError(400, "VALIDATION_ERROR", "first_name (or name) is required", { field: "first_name" });

  if (b.password !== undefined && typeof b.password !== "string") {
    throw new ServiceError(400, "VALIDATION_ERROR", "password must be a string", { field: "password" });
  }
  const cycle = S.cycleIn(b.billing_cycle);
  if (cycle === null) throw new ServiceError(400, "VALIDATION_ERROR", "billing_cycle must be monthly or yearly", { field: "billing_cycle" });

  let trialEndsAt = null;
  if (b.trial_days !== undefined && b.trial_days !== null) {
    const days = input.number(b.trial_days, "trial_days", { min: 1, max: 365, integer: true });
    if (days.error) throw new ServiceError(400, "VALIDATION_ERROR", days.error, { field: "trial_days" });
    trialEndsAt = new Date(Date.now() + days.value * 24 * 3600 * 1000);
  }
  const isComp = requireBoolean(b.is_comp, "is_comp");
  const isMuslimCharity = requireBoolean(b.is_muslim_charity, "is_muslim_charity");
  const sendWelcome = requireBoolean(b.send_welcome_email, "send_welcome_email") !== false;
  const compReason = input.text(b.comp_reason, "comp_reason", { max: 500 });
  if (compReason.error) throw new ServiceError(400, "VALIDATION_ERROR", compReason.error, { field: "comp_reason" });
  const reason = reasonFrom(b);
  const passwordSupplied = typeof b.password === "string";

  const { organisation, adminUser, resetToken, generatedPassword } = await provisionOrganisation(
    {
      orgName: typeof orgName === "string" ? orgName : "",
      adminName,
      adminEmail: typeof b.email === "string" ? b.email : "",
      slug: b.slug,
      plan: b.plan_code || "essentials",
      billingCycle: cycle || "monthly",
      isMuslimCharity: !!isMuslimCharity,
    },
    {
      isComp: isComp !== false,
      compReason: compReason.value || `Provisioned via integration (${req.integration.keyName})`,
      trialEndsAt,
      credentials: passwordSupplied ? "password" : "generate",
      password: b.password,
      strictSlug: true,
      validatePlan: true,
    },
  );

  const setPasswordUrl = resetToken ? `${process.env.CLIENT_URL || "http://localhost:5173"}/reset-password/${resetToken}` : "";
  let welcomeEmail = "skipped";
  if (sendWelcome) {
    const origin = `${portalScheme()}://${portalHost(organisation)}`;
    const mail = await sendTemplateEmail("tenant.welcome", {
      to: adminUser.email,
      data: {
        recipient: { name: adminUser.name || "", email: adminUser.email },
        tenant: {
          name: organisation.name,
          portalUrl: origin,
          loginUrl: `${origin}/admin/login`,
          adminEmail: adminUser.email,
          plan: organisation.plan || "",
          billingCycle: S.cycleOut(organisation.billingCycle),
          // Never email a password. A generated one is handed to the caller
          // once; the owner gets a link to choose their own instead.
          password: "",
          setPasswordUrl,
        },
      },
      meta: { organisationId: String(organisation._id), slug: organisation.slug, via: "integration" },
    });
    welcomeEmail = mail?.success ? "sent" : "failed";
    if (!mail?.success) console.error(`[integration] welcome email to ${adminUser.email} failed:`, mail?.error?.message || mail?.message);
  }

  await writeAudit(req, "org.provisioned", {
    organisationId: organisation._id,
    targetType: "organisation",
    targetId: String(organisation._id),
    meta: {
      name: organisation.name,
      slug: organisation.slug,
      plan: organisation.plan,
      billingCycle: organisation.billingCycle,
      isComp: organisation.isComp,
      trialEndsAt: organisation.trialEndsAt,
      welcomeEmail,
      reason,
    },
  });
  emitToSuperAdmins("organisation:updated", { organisationId: String(organisation._id) });

  const warnings = [];
  if (!organisation.isComp) {
    warnings.push({ code: "NOT_BILLED", message: "This tenant is not comped and has no Stripe subscription — nothing will bill it automatically" });
  }
  if (welcomeEmail === "failed") warnings.push({ code: "WELCOME_EMAIL_FAILED", message: "The tenant was created but the welcome email could not be sent" });

  const data = await tenantFull(organisation);
  data.welcome_email = welcomeEmail;
  // Returned exactly once. Not stored anywhere retrievable.
  data.credentials = passwordSupplied ? null : { generated_password: generatedPassword, set_password_url: setPasswordUrl };
  ok(res, data, { status: 201, warnings });
};

/** PATCH /tenants/:id  { name?, status?, reason? } */
exports.update = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["name", "status", "reason"]);
  if (b.name === undefined && b.status === undefined) {
    throw new ServiceError(400, "VALIDATION_ERROR", "Send at least one of: name, status");
  }
  const status = input.oneOf(b.status, "status", ["active", "suspended", "deleted"], { required: false });
  if (status.error) throw new ServiceError(400, "VALIDATION_ERROR", status.error, { field: "status" });
  const reason = reasonFrom(b);
  const org = req.tenant;

  let changed = false;
  const warnings = [];
  const apply = (r) => {
    changed = changed || r.changed;
    warnings.push(...(r.warnings || []));
  };

  // Validate the name before any write, so a bad name can't land half a request.
  if (b.name !== undefined) {
    const n = input.text(b.name, "name", { max: 200, required: true, allowEmpty: false });
    if (n.error) throw new ServiceError(400, "VALIDATION_ERROR", n.error, { field: "name" });
  }
  if (status.value) {
    const current = lifecycle.tenantStatus(org);
    if (status.value === "active") apply(await lifecycle.reactivateTenant(org, req, { reason, to: "active" }));
    else if (status.value === "suspended") {
      apply(current === "deleted" ? await lifecycle.reactivateTenant(org, req, { reason, to: "suspended" }) : await lifecycle.suspendTenant(org, req, { reason }));
    } else if (current !== "deleted") apply(await lifecycle.softDeleteTenant(org, req, { reason }));
  }
  if (b.name !== undefined) apply(await lifecycle.renameTenant(org, b.name, req, { reason }));

  const data = await tenantFull(org);
  data.changed = changed;
  ok(res, data, { warnings });
};

/** DELETE /tenants/:id — soft delete (data kept, restorable). */
exports.remove = async (req, res) => {
  const reason = input.text(req.body?.reason ?? req.query.reason, "reason", { max: 500 });
  if (reason.error) throw new ServiceError(400, "VALIDATION_ERROR", reason.error, { field: "reason" });
  const result = await lifecycle.softDeleteTenant(req.tenant, req, { reason: reason.value });
  ok(res, await tenantFull(req.tenant), { warnings: result.warnings });
};

/** POST /tenants/:id/assign-plan  { plan_code, billing_cycle?, reason? } */
exports.assignPlan = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["plan_code", "billing_cycle", "reason"]);
  const cycle = S.cycleIn(b.billing_cycle);
  if (cycle === null) throw new ServiceError(400, "VALIDATION_ERROR", "billing_cycle must be monthly or yearly", { field: "billing_cycle" });
  if (b.plan_code === undefined || b.plan_code === null || b.plan_code === "") {
    throw new ServiceError(400, "VALIDATION_ERROR", "plan_code is required", { field: "plan_code" });
  }
  const result = await lifecycle.assignPlan(req.tenant, { planCode: b.plan_code, billingCycle: cycle }, req, { reason: reasonFrom(b) });
  const data = await tenantFull(req.tenant);
  data.changed = result.changed;
  data.billing_sync = result.billingSync;
  ok(res, data, { warnings: result.warnings });
};

/** PUT /tenants/:id/override  { limits?, feature_flags?, pricing?: { monthly, yearly }, reason } */
exports.setOverride = async (req, res) => {
  const b = req.body || {};
  if (b.effective_from !== undefined || b.effective_until !== undefined) {
    throw new ServiceError(400, "OVERRIDE_WINDOW_UNSUPPORTED", "Donexus overrides apply from the moment they are set until cleared; effective_from/effective_until are not supported");
  }
  assertKnownFields(b, ["limits", "feature_flags", "pricing", "reason"]);
  if (b.pricing !== undefined && b.pricing !== null) {
    assertKnownFields(b.pricing, ["monthly", "yearly", "currency"]);
    if (b.pricing.currency !== undefined && String(b.pricing.currency).toUpperCase() !== S.CURRENCY) {
      throw new ServiceError(400, "CURRENCY_MISMATCH", `Prices are in ${S.CURRENCY}`, { field: "pricing.currency" });
    }
  }
  await lifecycle.setOverride(
    req.tenant,
    {
      limits: b.limits,
      featureFlags: b.feature_flags,
      pricing: b.pricing ? { monthly: b.pricing.monthly, annual: b.pricing.yearly } : undefined,
      reason: b.reason,
    },
    req,
    { strict: true },
  );
  ok(res, await tenantFull(req.tenant));
};

/** DELETE /tenants/:id/override */
exports.clearOverride = async (req, res) => {
  const reason = input.text(req.body?.reason ?? req.query.reason, "reason", { max: 500 });
  if (reason.error) throw new ServiceError(400, "VALIDATION_ERROR", reason.error, { field: "reason" });
  const result = await lifecycle.clearOverride(req.tenant, req, { reason: reason.value });
  const data = await tenantFull(req.tenant);
  data.cleared = result.changed;
  ok(res, data);
};

/** POST /tenants/:id/comp  { is_comp, reason } — reason required when comping. */
exports.comp = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["is_comp", "reason"]);
  if (b.is_comp === undefined) throw new ServiceError(400, "VALIDATION_ERROR", "is_comp is required", { field: "is_comp" });
  const result = await lifecycle.setComp(req.tenant, { isComp: requireBoolean(b.is_comp, "is_comp"), reason: b.reason }, req);
  const data = await tenantFull(req.tenant);
  data.changed = result.changed;
  ok(res, data, { warnings: result.warnings });
};

const DAY_MS = 24 * 3600 * 1000;

/**
 * POST /tenants/:id/trial  { trial_ends_at } | { extend_days }, reason?
 * `extend_days` counts from the current trial end, or from now when there is
 * no trial or it has already passed. `trial_ends_at: null` clears the trial.
 */
exports.trial = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["trial_ends_at", "extend_days", "reason"]);
  const hasDate = b.trial_ends_at !== undefined;
  const hasDays = b.extend_days !== undefined;
  if (hasDate === hasDays) throw new ServiceError(400, "VALIDATION_ERROR", "Send exactly one of trial_ends_at or extend_days");

  let trialEndsAt = b.trial_ends_at;
  if (hasDays) {
    const days = input.number(b.extend_days, "extend_days", { min: 1, max: 365, integer: true });
    if (days.error) throw new ServiceError(400, "VALIDATION_ERROR", days.error, { field: "extend_days" });
    const current = req.tenant.trialEndsAt ? new Date(req.tenant.trialEndsAt).getTime() : 0;
    trialEndsAt = new Date(Math.max(Date.now(), current) + days.value * DAY_MS).toISOString();
  }
  await lifecycle.setTrial(req.tenant, { trialEndsAt, reason: reasonFrom(b) }, req);
  ok(res, await tenantFull(req.tenant));
};

/** GET /tenants/:id/invoices?status=&from=&to=&page=&limit= */
exports.invoices = async (req, res) => {
  const { data, meta } = await listInvoices(req.query, { organisationId: req.tenant._id });
  ok(res, data, { meta });
};

/** GET /tenants/:id/audit?action=&from=&to=&search=&page=&limit= — the tenant's operator history. */
exports.audit = async (req, res) => {
  const { data, meta } = await listAudit(req.query, { organisationId: req.tenant._id });
  ok(res, data, { meta });
};

/* ── tenant admins ─────────────────────────────────────────────────────── */

const adminOut = (u, tenant) => S.serializeTenantAdmin(u, tenantAdmins.tenantAdminState(u), { tenant });

/** GET /tenants/:id/admins — the tenant's admin accounts and their sign-in state. */
exports.listAdmins = async (req, res) => {
  const admins = await tenantAdmins.listTenantAdmins({ organisationId: req.tenant._id });
  ok(res, admins.map((u) => adminOut(u)), { meta: { total: admins.length } });
};

/** Load `:userId` as an admin OF THIS TENANT (another tenant's admin is a 404). */
async function loadAdmin(req) {
  return tenantAdmins.findTenantAdmin(req.params.userId, { organisationId: req.tenant._id });
}

/** GET /tenants/:id/admins/:userId */
exports.getAdmin = async (req, res) => {
  ok(res, adminOut(await loadAdmin(req), req.tenant));
};

/** PATCH /tenants/:id/admins/:userId  { status?, mfa_policy?, reason? } */
exports.updateAdmin = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["status", "mfa_policy", "reason"]);
  if (b.status === undefined && b.mfa_policy === undefined) throw new ServiceError(400, "VALIDATION_ERROR", "Send at least one of: status, mfa_policy");
  const reason = reasonFrom(b);
  const user = await loadAdmin(req);
  // Validate both before writing either, so a bad mfa_policy can't land half a request.
  if (b.status !== undefined && !["active", "suspended"].includes(b.status)) {
    throw new ServiceError(400, "VALIDATION_ERROR", "status must be one of: active, suspended", { field: "status" });
  }
  if (b.mfa_policy !== undefined && !["default", "required"].includes(b.mfa_policy)) {
    throw new ServiceError(400, "VALIDATION_ERROR", "mfa_policy must be one of: default, required", { field: "mfa_policy" });
  }
  const messages = [];
  if (b.status !== undefined) messages.push((await tenantAdmins.setStatus(user, b.status, req, { reason })).message);
  if (b.mfa_policy !== undefined) messages.push((await tenantAdmins.setMfaPolicy(user, b.mfa_policy, req, { reason })).message);
  const data = adminOut(user, req.tenant);
  data.message = messages.join(". ");
  ok(res, data);
};

/** POST /tenants/:id/admins/:userId/<action>  { reason? } */
const ADMIN_ACTIONS = {
  "force-logout": (user, req, reason) => tenantAdmins.forceLogout(user, req, { reason }),
  unlock: (user, req, reason) => tenantAdmins.unlock(user, req, { reason }),
  "reset-2fa": (user, req, reason) => tenantAdmins.resetMfa(user, req, { reason }),
  "password-reset": (user, req) => tenantAdmins.sendPasswordReset(user, req),
};

exports.adminAction = (action) => async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["reason"]);
  const reason = reasonFrom(b);
  const user = await loadAdmin(req);
  const { message } = await ADMIN_ACTIONS[action](user, req, reason);
  const data = adminOut(user, req.tenant);
  data.message = message;
  ok(res, data);
};

/** POST /tenants/:id/act-as — closed to API keys, like Stewardex. */
exports.actAs = async () => {
  throw new ServiceError(403, "IMPERSONATION_NOT_ALLOWED", "Signing in as a tenant needs a named person — use the Donexus console's Open as support");
};

exports.latestPaidPeriods = latestPaidPeriods;
