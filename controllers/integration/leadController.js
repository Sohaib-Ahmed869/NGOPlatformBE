/**
 * Integration API — the Leads CRM (Donexus's sales pipeline of charities that
 * asked about the platform). Reads and writes go through services/leadService.js,
 * shared with the SuperAdmin console, so stage history, emails and audit match.
 *
 * Wire names are snake_case; the service takes the model's camelCase names.
 */
const leadService = require("../../services/leadService");
const input = require("../../utils/operatorInput");
const { ServiceError } = require("../../utils/serviceError");
const { ok } = require("../../utils/integrationResponse");
const S = require("../../utils/integrationSerializers");
const { assertKnownFields, reasonFrom, requireBoolean } = require("./shared");

/** wire name → Lead field, for the intake fields create and PATCH share. */
const FIELD_MAP = {
  org_name: "orgName",
  org_website: "orgWebsite",
  vertical: "verticalType",
  country: "country",
  contact_name: "contactName",
  contact_email: "contactEmail",
  contact_phone: "contactPhone",
  contact_role: "contactRole",
  contacts: "contacts",
  message: "message",
  cause_areas: "causeAreas",
  staff_size: "staffSize",
  annual_budget_range: "annualBudgetRange",
  donor_database_size: "donorDatabaseSize",
  current_tools: "currentTools",
  current_tools_other: "currentToolsOther",
  challenges: "challenges",
  challenges_other: "challengesOther",
  interested_plan: "interestedPlan",
  interested_billing_cycle: "interestedBillingCycle",
  timeline: "timeline",
  decision_role: "decisionRole",
  priority: "priority",
  tags: "tags",
  deal_value: "dealValue",
  expected_close_at: "expectedCloseAt",
};
const CREATE_ONLY = { stage: "stage", source: "source", assignee_id: "assigneeUserId", consent_to_contact: "consentToContact" };

function toLeadInput(b, map) {
  const out = {};
  for (const [wire, field] of Object.entries(map)) {
    if (b[wire] === undefined) continue;
    let v = b[wire];
    // The contract says "yearly"; the Lead stores the internal "annual".
    if (wire === "interested_billing_cycle" && v) {
      const c = S.cycleIn(v);
      if (c === null) throw new ServiceError(400, "VALIDATION_ERROR", "interested_billing_cycle must be monthly or yearly", { field: wire });
      v = c;
    }
    if (wire === "consent_to_contact") v = requireBoolean(v, wire);
    out[field] = v;
  }
  return out;
}

/** The service reports camelCase field names; answer with the wire name the caller sent. */
const WIRE_NAME = Object.fromEntries(Object.entries({ ...FIELD_MAP, ...CREATE_ONLY }).map(([w, f]) => [f, w]));
async function mapFieldErrors(fn) {
  try {
    return await fn();
  } catch (err) {
    const field = err?.details?.field;
    if (field && WIRE_NAME[field]) err.details = { ...err.details, field: WIRE_NAME[field] };
    throw err;
  }
}

const detail = (lead) => S.serializeLead(lead.toObject ? lead.toObject() : lead, { detail: true });

/**
 * GET /leads?stage=&assignee_id=&priority=&tag=&search=&sort=&dir=&page=&limit=
 * `assignee_id` takes an operator id or `unassigned`.
 */
exports.list = async (req, res) => {
  const q = req.query;
  if (q.stage !== undefined && q.stage !== "" && q.stage !== "all" && !leadService.STAGES.includes(q.stage)) {
    throw new ServiceError(400, "VALIDATION_ERROR", `stage must be one of: ${leadService.STAGES.join(", ")}`, { field: "stage" });
  }
  if (q.priority !== undefined && q.priority !== "" && !leadService.LEAD_PRIORITIES.includes(q.priority)) {
    throw new ServiceError(400, "VALIDATION_ERROR", `priority must be one of: ${leadService.LEAD_PRIORITIES.join(", ")}`, { field: "priority" });
  }
  const assignee = input.filterValue(q.assignee_id);
  if (assignee && assignee !== "unassigned" && !input.isObjectId(assignee)) {
    throw new ServiceError(400, "VALIDATION_ERROR", "assignee_id must be an operator id or unassigned", { field: "assignee_id" });
  }
  if (q.sort !== undefined && q.sort !== "" && !leadService.LEAD_SORT_KEYS.includes(q.sort)) {
    throw new ServiceError(400, "VALIDATION_ERROR", `sort must be one of: ${leadService.LEAD_SORT_KEYS.join(", ")}`, { field: "sort" });
  }
  const result = await leadService.listLeads({ ...q, assignee }, { defaultLimit: 50, maxLimit: 200 });
  ok(res, result.leads.map((l) => S.serializeLead(l)), {
    meta: { page: result.page, limit: result.limit, total: result.total, pages: result.pages, sort: result.sort, new_count: result.newCount },
  });
};

/** GET /leads/board — every lead grouped by stage (max 1000), for a kanban view. */
exports.board = async (req, res) => {
  const board = await leadService.leadBoard();
  const data = {};
  for (const [stage, leads] of Object.entries(board)) data[stage] = leads.map((l) => S.serializeLead(l));
  ok(res, { stages: leadService.STAGES, columns: data });
};

/** GET /leads/staff — operators a lead can be assigned to. */
exports.staff = async (req, res) => {
  const staff = await leadService.listStaff();
  ok(res, staff.map((u) => ({ id: String(u._id), name: u.name || "", email: u.email || "" })));
};

/** GET /leads/:leadId — with thread, stage history, contacts and conversion. */
exports.get = async (req, res) => {
  ok(res, detail(await leadService.getLead(req.params.leadId)));
};

/** POST /leads */
exports.create = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, [...Object.keys(FIELD_MAP), ...Object.keys(CREATE_ONLY), "reason"]);
  reasonFrom(b);
  const lead = await mapFieldErrors(() => leadService.createLead(toLeadInput(b, { ...FIELD_MAP, ...CREATE_ONLY }), req));
  ok(res, detail(await leadService.getLead(lead._id)), { status: 201 });
};

/**
 * PATCH /leads/:leadId — edit intake/deal fields. Only fields you send change.
 * Stage, assignment and conversion have their own endpoints.
 */
exports.update = async (req, res) => {
  const b = req.body || {};
  const moved = ["stage", "assignee_id"].filter((k) => b[k] !== undefined);
  if (moved.length) {
    throw new ServiceError(400, "UNKNOWN_FIELD", `${moved.join(", ")} can't be changed here — use PATCH /leads/:leadId/stage or POST /leads/:leadId/assign`, {
      unknown: moved,
    });
  }
  assertKnownFields(b, [...Object.keys(FIELD_MAP), "reason"]);
  reasonFrom(b);
  await mapFieldErrors(() => leadService.updateLead(req.params.leadId, toLeadInput(b, FIELD_MAP), req));
  ok(res, detail(await leadService.getLead(req.params.leadId)));
};

/** PATCH /leads/:leadId/stage  { stage, lost_reason?, lost_reason_note?, note? } */
exports.changeStage = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["stage", "lost_reason", "lost_reason_note", "note"]);
  await leadService.changeStage(req.params.leadId, { stage: b.stage, lostReason: b.lost_reason, lostReasonNote: b.lost_reason_note, note: b.note }, req);
  ok(res, detail(await leadService.getLead(req.params.leadId)));
};

/**
 * POST /leads/:leadId/messages  { kind?: "note"|"reply", body, author_name? }
 * A reply is EMAILED to the lead's contact, signed with author_name.
 */
exports.addMessage = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["kind", "body", "author_name"]);
  if (b.kind === "reply" && !(typeof b.author_name === "string" && b.author_name.trim())) {
    throw new ServiceError(400, "VALIDATION_ERROR", "author_name is required for a reply — it signs the email the customer receives", { field: "author_name" });
  }
  const { lead, emailStatus } = await leadService.addMessage(req.params.leadId, { kind: b.kind, body: b.body, authorName: b.author_name }, req);
  const data = detail(lead);
  data.email_status = emailStatus || null;
  const warnings = emailStatus === "failed" ? [{ code: "EMAIL_SEND_FAILED", message: "The reply was saved but the email to the contact could not be sent" }] : [];
  ok(res, data, { warnings });
};

/** POST /leads/:leadId/assign  { assignee_id | null } — assignee from GET /leads/staff. */
exports.assign = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["assignee_id", "reason"]);
  if (b.assignee_id === undefined) throw new ServiceError(400, "VALIDATION_ERROR", "assignee_id is required (null to unassign)", { field: "assignee_id" });
  await leadService.assignLead(req.params.leadId, b.assignee_id, req);
  ok(res, detail(await leadService.getLead(req.params.leadId)));
};

const CONVERT_FIELDS = [
  "mode",
  "billing_mode",
  "org_name",
  "admin_name",
  "admin_email",
  "plan_code",
  "billing_cycle",
  "slug",
  "is_muslim_charity",
  "is_comp",
  "comp_reason",
  "trial_ends_at",
  "coupon_code",
  "reason",
];

/**
 * POST /leads/:leadId/convert — turn the lead into a tenant.
 *   { mode: "activation_link" }                                  email a pre-filled self-serve signup link
 *   { mode: "manual_provision" } (billing_mode "comp", default)  create the tenant now, comped
 *   { mode: "manual_provision", billing_mode: "send_link" }      create it pending + email a payment link
 * Fields you omit fall back to the lead's own answers.
 */
exports.convert = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, CONVERT_FIELDS);
  reasonFrom(b);
  const cycle = S.cycleIn(b.billing_cycle);
  if (cycle === null) throw new ServiceError(400, "VALIDATION_ERROR", "billing_cycle must be monthly or yearly", { field: "billing_cycle" });
  for (const f of ["org_name", "admin_name", "admin_email", "plan_code", "slug", "comp_reason", "coupon_code"]) {
    if (b[f] !== undefined && typeof b[f] !== "string") throw new ServiceError(400, "VALIDATION_ERROR", `${f} must be a string`, { field: f });
  }
  if (b.trial_ends_at !== undefined && b.trial_ends_at !== null) {
    const d = input.date(b.trial_ends_at, "trial_ends_at", { future: true });
    if (d.error) throw new ServiceError(400, "VALIDATION_ERROR", d.error, { field: "trial_ends_at" });
  }

  const body = {
    mode: b.mode,
    billingMode: b.billing_mode,
    orgName: b.org_name,
    adminName: b.admin_name,
    adminEmail: b.admin_email,
    plan: b.plan_code,
    billingCycle: cycle,
    slug: b.slug,
    isMuslimCharity: requireBoolean(b.is_muslim_charity, "is_muslim_charity"),
    isComp: requireBoolean(b.is_comp, "is_comp"),
    compReason: b.comp_reason,
    trialEndsAt: b.trial_ends_at || null,
    couponCode: b.coupon_code,
  };
  const result = await leadService.convertLead(req.params.leadId, body, req, { allowChargeNow: false });

  const data = {
    outcome: result.outcome,
    lead: detail(await leadService.getLead(req.params.leadId)),
    tenant: result.organisation ? { id: String(result.organisation._id), name: result.organisation.name, slug: result.organisation.slug } : null,
    link: result.link || null,
    email_status: result.emailStatus || null,
  };
  const warnings = result.emailStatus === "failed" ? [{ code: "EMAIL_SEND_FAILED", message: "The conversion went through but its email could not be sent — share `link` another way" }] : [];
  ok(res, data, { status: result.outcome === "converted" ? 201 : 200, warnings });
};

/** DELETE /leads/:leadId — permanent. */
exports.remove = async (req, res) => {
  const lead = await leadService.deleteLead(req.params.leadId, req);
  ok(res, { id: String(lead._id), deleted: true });
};
