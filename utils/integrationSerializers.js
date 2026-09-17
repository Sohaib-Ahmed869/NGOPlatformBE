/**
 * Wire shapes for the integration API. Internal models stay camelCase and keep
 * their own vocabulary; everything that crosses /api/integration goes through
 * here, so the contract lives in one file.
 *
 * Conventions (see postman/README.md):
 *   - snake_case field names; keys INSIDE `limits` / `feature_flags` are feature
 *     catalogue keys and are passed through verbatim (e.g. "eventsQuota")
 *   - ISO-8601 UTC dates, null when unset
 *   - money as numbers in whole currency units, with a sibling `currency`
 *   - billing cycle "monthly" | "yearly" (stored internally as "annual")
 */
const planPricing = require("../config/planPricing");
const { tenantStatus, hasLiveStripeSubscription, hasOverride } = require("../services/tenantLifecycle");
const { portalOrigin } = require("./tenantUrls");

const CURRENCY = String(planPricing.currency || "aud").toUpperCase();

const iso = (d) => (d ? new Date(d).toISOString() : null);
const id = (v) => (v ? String(v._id || v) : null);
const plain = (v) =>
  !v ? {} : typeof v.toObject === "function" ? v.toObject() : v instanceof Map ? Object.fromEntries(v) : { ...v };
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

/* ── billing cycle ─────────────────────────────────────────────────────── */
const cycleOut = (c) => (c === "annual" ? "yearly" : "monthly");
/** "monthly" | "yearly" (or the internal "annual") → internal value; undefined when absent; null when invalid. */
function cycleIn(v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (v === "monthly") return "monthly";
  if (v === "yearly" || v === "annual") return "annual";
  return null;
}

/* ── ticket category (wire names match the Stewardex contract) ──────────── */
const CATEGORY_OUT = { technical: "technical_error", access: "access_issue", data: "data_issue" };
const CATEGORY_IN = { technical_error: "technical", access_issue: "access", data_issue: "data" };
const TICKET_CATEGORIES = ["technical_error", "bug_report", "feature_request", "access_issue", "data_issue", "general", "other", "billing", "account", "feedback"];
const categoryOut = (c) => CATEGORY_OUT[c] || c || "general";
/** Wire (or internal) category → internal value, or null when unknown. */
function categoryIn(v) {
  if (CATEGORY_IN[v]) return CATEGORY_IN[v];
  const internal = ["technical", "bug_report", "feature_request", "access", "data", "billing", "account", "general", "feedback", "other"];
  return internal.includes(v) ? v : null;
}

/* ── plans ─────────────────────────────────────────────────────────────── */
function stripeSynced(p) {
  if (!p.stripeProductId) return false;
  return ["monthly", "annual"].every((c) => !(Number(p.price?.[c]) > 0) || !!p.stripePriceIds?.[c]);
}

function serializePlan(p, { subscribers } = {}) {
  const out = {
    code: p.code,
    name: p.name,
    description: p.description || "",
    status: p.isActive === false ? "archived" : "active",
    archived_at: iso(p.archivedAt),
    is_public: p.isPublic !== false,
    is_popular: !!p.isPopular,
    sort_order: p.sortOrder || 0,
    color: p.color || null,
    pricing: {
      currency: String(p.currency || CURRENCY).toUpperCase(),
      monthly: num(p.price?.monthly) ?? 0,
      yearly: num(p.price?.annual) ?? 0,
      onboarding_fee: num(p.onboardingFee) ?? 0,
    },
    limits: plain(p.limits),
    feature_flags: plain(p.featureFlags),
    marketing_features: [...(p.features || [])],
    stripe_synced: stripeSynced(p),
    created_at: iso(p.createdAt),
    updated_at: iso(p.updatedAt),
  };
  if (subscribers) out.subscribers = { total: subscribers.total || 0, active: subscribers.active || 0 };
  return out;
}

function serializePriceHistory(p) {
  return (p.priceHistory || [])
    .map((h) => ({ monthly: num(h.monthly), yearly: num(h.annual), replaced_at: iso(h.replacedAt) }))
    .reverse();
}

/* ── tenants ───────────────────────────────────────────────────────────── */
function billingSource(org) {
  if (org.isComp) return "comp";
  if (hasLiveStripeSubscription(org)) return "stripe";
  return "none";
}

/** The price this tenant is quoted for its current cycle: override → plan list price. */
function effectivePrice(org, planDoc) {
  const cycle = org.billingCycle === "annual" ? "annual" : "monthly";
  const ov = org.override?.pricing?.[cycle];
  if (ov !== null && ov !== undefined) return { currency: CURRENCY, amount: Number(ov), source: "override" };
  if (planDoc && planDoc.price) return { currency: CURRENCY, amount: Number(planDoc.price[cycle]) || 0, source: "plan" };
  return { currency: CURRENCY, amount: null, source: "none" };
}

function serializeOverride(org) {
  if (!hasOverride(org)) return null;
  const o = org.override;
  return {
    limits: plain(o.limits),
    feature_flags: plain(o.featureFlags),
    pricing: { currency: CURRENCY, monthly: num(o.pricing?.monthly), yearly: num(o.pricing?.annual) },
    reason: o.reason || "",
    set_by: o.setByLabel || (o.setBy ? id(o.setBy) : null),
    set_at: iso(o.setAt),
  };
}

/**
 * One tenant row: everything the portal's tenant table needs, so the list
 * endpoint never forces a detail call per row.
 * @param {object} org    Organisation (doc or lean), adminUserId populated when available
 * @param {object} ctx
 * @param {object} [ctx.plan]    the Plan doc for org.plan
 * @param {object} [ctx.period]  { start, end } of the latest paid platform invoice
 */
function serializeTenant(org, { plan, period } = {}) {
  const owner = org.adminUserId && typeof org.adminUserId === "object" && org.adminUserId.email !== undefined ? org.adminUserId : null;
  const now = Date.now();
  const currentPeriod =
    period && period.end && new Date(period.end).getTime() >= now ? { start: iso(period.start), end: iso(period.end) } : null;
  return {
    id: String(org._id),
    name: org.name,
    slug: org.slug,
    status: tenantStatus(org),
    portal_url: portalOrigin(org) || null,
    contact_email: org.contactEmail || null,
    is_muslim_charity: !!org.isMuslimCharity,
    owner: owner
      ? { id: String(owner._id), name: owner.name || "", email: owner.email || "" }
      : org.adminUserId
        ? { id: id(org.adminUserId), name: null, email: null }
        : null,
    has_override: hasOverride(org),
    subscription: {
      plan_code: org.plan || null,
      plan_name: plan?.name || null,
      plan_status: plan ? (plan.isActive === false ? "archived" : "active") : null,
      billing_cycle: cycleOut(org.billingCycle),
      status: org.subscriptionStatus,
      billing: billingSource(org),
      is_comp: !!org.isComp,
      comp_reason: org.isComp ? org.compReason || "" : null,
      trial_ends_at: iso(org.trialEndsAt),
      current_period: currentPeriod,
      last_paid_period: period ? { start: iso(period.start), end: iso(period.end) } : null,
      price: effectivePrice(org, plan),
    },
    created_at: iso(org.createdAt),
    updated_at: iso(org.updatedAt),
    deleted_at: iso(org.deletedAt),
  };
}

/** A tenant reference from a populated organisationId (or null when it wasn't populated / was deleted). */
function tenantRef(v) {
  if (!v || typeof v !== "object" || v.slug === undefined) return null;
  return { id: String(v._id), name: v.name, slug: v.slug };
}

function serializeAudit(a) {
  return {
    id: String(a._id),
    action: a.action,
    actor: a.actorEmail || null,
    actor_id: a.actorId ? id(a.actorId) : null,
    tenant_id: a.organisationId ? id(a.organisationId) : null,
    tenant: tenantRef(a.organisationId),
    target_type: a.targetType || null,
    target_id: a.targetId || null,
    at: iso(a.createdAt),
    meta: a.meta || {},
  };
}

function serializeInvoice(inv) {
  return {
    id: String(inv._id),
    number: inv.number || null,
    status: inv.status,
    tenant_id: inv.organisationId ? id(inv.organisationId) : null,
    tenant: tenantRef(inv.organisationId),
    currency: String(inv.currency || "").toUpperCase(),
    amount_due: num(inv.amountDue),
    amount_paid: num(inv.amountPaid),
    period_start: iso(inv.periodStart),
    period_end: iso(inv.periodEnd),
    paid_at: iso(inv.paidAt),
    hosted_invoice_url: inv.hostedInvoiceUrl || null,
    invoice_pdf_url: inv.invoicePdf || null,
    stripe_invoice_id: inv.stripeInvoiceId || null,
    stripe_subscription_id: inv.stripeSubscriptionId || null,
    created_at: iso(inv.createdAt),
  };
}

/* ── billing: coupons ──────────────────────────────────────────────────── */
function serializeCoupon(c) {
  return {
    code: c.code,
    description: c.description || "",
    type: c.type,
    // percent: 1–100; amount: whole currency units in `currency`
    value: num(c.value),
    currency: String(c.currency || "").toUpperCase(),
    duration: c.duration,
    duration_in_months: c.durationInMonths ?? null,
    plan_codes: [...(c.planCodes || [])],
    max_redemptions: c.maxRedemptions ?? null,
    times_redeemed: c.timesRedeemed || 0,
    redeem_by: iso(c.redeemBy),
    status: c.archivedAt || c.isActive === false ? "archived" : "active",
    archived_at: iso(c.archivedAt),
    stripe_synced: !!(c.stripeCouponId && c.stripePromotionCodeId),
    created_at: iso(c.createdAt),
    updated_at: iso(c.updatedAt),
  };
}

/* ── tenant admins ─────────────────────────────────────────────────────── */
/**
 * @param {object} u      User (doc or lean)
 * @param {object} state  services/tenantAdminService.tenantAdminState(u)
 * @param {object} [ctx]
 * @param {object} [ctx.tenant]  the Organisation, when organisationId isn't populated
 */
function serializeTenantAdmin(u, state, { tenant } = {}) {
  return {
    id: String(u._id),
    name: u.name || "",
    email: u.email,
    tenant_id: u.organisationId ? id(u.organisationId) : null,
    tenant: tenantRef(tenant || u.organisationId),
    status: state.status,
    two_factor_enabled: state.twoFactorEnabled,
    mfa_policy: state.mfaPolicy,
    mfa_required: !!state.mfaRequired,
    locked_until: iso(state.lockedUntil),
    last_login_at: iso(state.lastLogin),
    created_at: iso(u.createdAt),
  };
}

/* ── leads (CRM) ───────────────────────────────────────────────────────── */
const blankToNull = (v) => (v === "" || v === undefined ? null : v);
const userRef = (v, fallbackName) =>
  v ? { id: id(v), name: (typeof v === "object" && v.name) || fallbackName || null, email: (typeof v === "object" && v.email) || null } : null;

/**
 * @param {object} l  Lead (doc or lean). List rows have no thread and carry `tasks`.
 * @param {object} [opts]
 * @param {boolean} [opts.detail=false]  include thread, stage history, contacts, source tracking and conversion
 */
function serializeLead(l, { detail = false } = {}) {
  const a = l.assignee || {};
  const converted = l.convertedOrgId;
  const out = {
    id: String(l._id),
    org_name: l.orgName,
    org_website: l.orgWebsite || null,
    vertical: l.verticalType || "general",
    country: l.country || null,
    contact: { name: l.contactName, email: l.contactEmail, phone: l.contactPhone || null, role: l.contactRole || null },
    stage: l.stage,
    priority: l.priority || "normal",
    tags: [...(l.tags || [])],
    deal: {
      value: num(l.dealValue) ?? 0,
      currency: String(l.currency || CURRENCY).toUpperCase(),
      expected_close_at: iso(l.expectedCloseAt),
    },
    interested_plan: blankToNull(l.interestedPlan),
    interested_billing_cycle: l.interestedBillingCycle ? cycleOut(l.interestedBillingCycle) : null,
    source: l.source,
    assignee: a.userId ? { id: id(a.userId), name: (typeof a.userId === "object" && a.userId.name) || a.name || null, email: (typeof a.userId === "object" && a.userId.email) || null, assigned_at: iso(a.assignedAt) } : null,
    lost: l.stage === "lost" ? { reason: blankToNull(l.lostReason), note: l.lostReasonNote || "", lost_at: iso(l.lostAt) } : null,
    converted_tenant_id: converted ? id(converted) : null,
    flagged_spam: !!l.flaggedSpam,
    consent_to_contact: !!l.consentToContact,
    last_activity_at: iso(l.lastMessageAt),
    created_at: iso(l.createdAt),
    updated_at: iso(l.updatedAt),
  };
  if (l.tasks) out.tasks = { open: l.tasks.open || 0, overdue: l.tasks.overdue || 0, next_due_at: iso(l.tasks.nextDueAt) };
  if (!detail) return out;

  return {
    ...out,
    message: l.message || "",
    cause_areas: [...(l.causeAreas || [])],
    staff_size: blankToNull(l.staffSize),
    annual_budget_range: blankToNull(l.annualBudgetRange),
    donor_database_size: blankToNull(l.donorDatabaseSize),
    current_tools: [...(l.currentTools || [])],
    current_tools_other: l.currentToolsOther || "",
    challenges: [...(l.challenges || [])],
    challenges_other: l.challengesOther || "",
    timeline: blankToNull(l.timeline),
    decision_role: blankToNull(l.decisionRole),
    contacts: (l.contacts || []).map((c) => ({ id: id(c._id), name: c.name, email: c.email || null, phone: c.phone || null, role: c.role || null, note: c.note || "" })),
    tracking: {
      utm: plain(l.utm),
      referrer_url: l.referrerUrl || null,
      landing_page: l.landingPage || null,
    },
    converted_tenant: tenantRef(converted),
    conversion_mode: blankToNull(l.conversionMode),
    converted_at: iso(l.convertedAt),
    activation: l.activation?.sentAt
      ? { sent_at: iso(l.activation.sentAt), expires_at: iso(l.activation.tokenExpiresAt), opened_at: iso(l.activation.openedAt) }
      : null,
    stage_history: (l.stageHistory || []).map((h) => ({ from: blankToNull(h.from), to: h.to, by: h.changedByName || null, note: h.note || "", at: iso(h.at) })),
    thread: (l.thread || []).map((t) => ({
      id: id(t._id),
      kind: t.kind,
      body: t.body,
      author: userRef(t.author, t.authorName) || (t.authorName ? { id: null, name: t.authorName, email: null } : null),
      emailed_to: t.emailedTo || null,
      email_status: blankToNull(t.emailStatus),
      created_at: iso(t.createdAt),
    })),
  };
}

/* ── tickets ───────────────────────────────────────────────────────────── */
function commentVisibility(c) {
  if (c.platformOnly) return "platform";
  if (c.isInternal) return "tenant";
  return "public";
}

function serializeComment(c) {
  return {
    id: String(c._id),
    message: c.message,
    author_name: c.authorName || "",
    author_id: c.createdBy ? id(c.createdBy) : null,
    visibility: commentVisibility(c),
    is_internal: !!c.isInternal,
    email_status: c.emailStatus || null,
    created_at: iso(c.createdAt),
  };
}

/**
 * @param {object} t  SupportTicket (doc or lean)
 * @param {object} ctx
 * @param {object} [ctx.tenant]     { _id, name, slug } for the ticket's org
 * @param {object} [ctx.assignee]   User { _id, name, email } when resolved separately
 * @param {boolean} [ctx.withComments=false]
 */
function serializeTicket(t, { tenant, assignee, withComments = false } = {}) {
  const orgRef = tenant || (t.organisationId && typeof t.organisationId === "object" && t.organisationId.slug !== undefined ? t.organisationId : null);
  const assigneeUser =
    assignee || (t.assignee?.userId && typeof t.assignee.userId === "object" && t.assignee.userId.email !== undefined ? t.assignee.userId : null);
  const comments = t.comments || [];
  const out = {
    id: String(t._id),
    number: t.ticketNumber ?? null,
    tenant_id: orgRef ? String(orgRef._id) : id(t.organisationId),
    tenant: orgRef ? { id: String(orgRef._id), name: orgRef.name, slug: orgRef.slug } : null,
    summary: t.summary,
    description: t.description || "",
    status: t.status,
    priority: t.priority,
    category: categoryOut(t.category),
    reporter: {
      user_id: t.reporter?.userId ? id(t.reporter.userId) : null,
      name: t.reporter?.name || "",
      email: t.reporter?.email || "",
      kind: t.reporter?.kind || (t.reporter?.isExternal ? "public" : null),
    },
    assignee: t.assignee?.userId
      ? {
          id: id(t.assignee.userId),
          name: assigneeUser?.name ?? null,
          email: assigneeUser?.email ?? null,
          assigned_at: iso(t.assignee.assignedAt),
        }
      : null,
    resolution: t.resolution?.resolvedAt ? { notes: t.resolution.notes || "", resolved_at: iso(t.resolution.resolvedAt) } : null,
    first_response_at: iso(t.firstResponseAt),
    satisfaction: t.satisfactionRating ? { rating: t.satisfactionRating, feedback: t.satisfactionFeedback || "", rated_at: iso(t.satisfactionRatedAt) } : null,
    triage: { category: t.triage || "unclassified", board_status: t.kanbanStatus || "todo", notes: t.triageNotes || "" },
    attachments: (t.attachments || []).map((a) => ({ name: a.name, size: a.size ?? null, url: a.url })),
    comment_count: t.commentCount ?? comments.length,
    created_at: iso(t.createdAt),
    updated_at: iso(t.updatedAt),
  };
  if (withComments) out.comments = comments.map(serializeComment);
  return out;
}

module.exports = {
  CURRENCY,
  TICKET_CATEGORIES,
  cycleIn,
  cycleOut,
  categoryIn,
  categoryOut,
  serializePlan,
  serializePriceHistory,
  serializeTenant,
  serializeOverride,
  serializeAudit,
  serializeInvoice,
  serializeCoupon,
  serializeTenantAdmin,
  serializeLead,
  tenantRef,
  serializeTicket,
  serializeComment,
};
