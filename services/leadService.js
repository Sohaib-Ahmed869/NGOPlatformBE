/**
 * services/leadService.js — the Leads CRM (sales pipeline): list, board, read,
 * create, edit, move stage, add a note/reply, assign, convert to a tenant, delete.
 *
 * Shared by the SuperAdmin console (controllers/leadController.js) and the
 * integration API (controllers/integration/leadController.js), so a lead edited
 * from Calcite Hyper is validated, recorded in its stage history and audited
 * exactly as one edited in the console. Input uses the model's camelCase field
 * names; failures throw ServiceError. Who did it comes from utils/actor.js.
 */
const Lead = require("../models/lead");
const User = require("../models/user");
const writeAudit = require("../utils/writeAudit");
const input = require("../utils/operatorInput");
const leadConversion = require("./leadConversion");
const { sendTemplateEmail } = require("./emailUtil");
const { emitToSuperAdmins } = require("./socket");
const { listAssignableStaff } = require("../utils/platformStaff");
const { actorOf } = require("../utils/actor");
const { ServiceError, isServiceError } = require("../utils/serviceError");
const { taskSummaryForLeads } = require("../controllers/crmTaskController");

/**
 * Columns the leads table may sort by, and the paths each one means.
 * "activity" is the default because the question this screen answers is
 * "who needs chasing", and that's ordered by when they last said something.
 */
const LEAD_SORTS = {
  org: "orgName",
  contact: ["contactName", "contactEmail"],
  stage: "stage",
  created: "createdAt",
  activity: ["lastMessageAt", "createdAt"],
  value: "dealValue",
  close: "expectedCloseAt",
};

const STAGES = Lead.STAGES;
const ACTIVE_STAGES = STAGES.filter((s) => s !== "won" && s !== "lost");
const LOST_REASONS = ["budget", "timing", "chose_competitor", "no_response", "not_a_fit", "spam", "other"];

// Enum fields whose schema allows "" as a real value meaning "not stated".
const VERTICALS = ["general", "muslim"];
const STAFF_SIZES = ["1-5", "6-20", "21-50", "51-200", "200+"];
const BUDGET_RANGES = ["under_50k", "50k_250k", "250k_1m", "1m_5m", "5m_plus"];
const DONOR_DB_SIZES = ["under_500", "500_2500", "2500_10000", "10000_plus", "unsure"];
const TIMELINES = ["immediately", "this_month", "this_quarter", "this_year", "just_researching"];
const DECISION_ROLES = ["decision_maker", "influencer", "researching_for_others"];
const BILLING_CYCLES = ["monthly", "annual"];
const LEAD_PRIORITIES = ["low", "normal", "high"];
const MANUAL_SOURCES = ["superadmin_manual", "referral", "contact_page", "other"];
const CONVERSION_MODES = ["activation_link", "manual_provision"];
const BILLING_MODES = ["comp", "charge_now", "send_link"];

const ASSIGNEE_FIELDS = "name email profileImage";

const invalid = (message, field) => new ServiceError(400, "VALIDATION_ERROR", message, field ? { field } : undefined);
const notFound = (id) => new ServiceError(404, "LEAD_NOT_FOUND", "Lead not found", { lead_id: String(id) });
const closed = () => new ServiceError(409, "LEAD_CLOSED", "This lead is already closed");

/**
 * An optional enum where blank is a legitimate answer.
 *
 * `input.oneOf(..., { required: false })` returns `undefined` for "", and
 * Mongoose strips undefined out of a `$set` — so clearing a field an operator
 * had previously set would silently do nothing. "" is what the schema stores
 * for "not stated", so that is what has to come back.
 */
function enumOrBlank(v, label, allowed) {
  if (v === undefined || v === null || v === "") return { value: "" };
  return input.oneOf(v, label, allowed);
}

// Deliberately loose. The job is to catch "priya@" and "priya.org" — the typos
// that make a Reply silently go nowhere — not to adjudicate RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailField(v, label, { required = false } = {}) {
  const parsed = input.text(v, label, { max: 250, required });
  if (parsed.error) return parsed;
  const value = (parsed.value || "").toLowerCase();
  if (!value) return { value: "" };
  if (!EMAIL_RE.test(value)) return { error: `${label} doesn't look like an email address` };
  return { value };
}

/**
 * The annualised value of a deal. Cleared reads as 0, never null: `dealValue` is
 * summed into the pipeline total, and a null turns the whole sum into null.
 */
function dealValueField(v) {
  if (v === undefined || v === null || v === "") return { value: 0 };
  return input.number(v, "Deal value", { min: 0, max: 100000000, decimals: 2 });
}

/** The extra people at a prospect org — see additionalContactSchema on the model. */
function parseContacts(raw, label = "Contacts") {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: `${label} must be a list` };
  if (raw.length > 20) return { error: `${label} is limited to 20 entries` };
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== "object" || Array.isArray(c)) return { error: "A contact entry is not valid" };
    const fields = input.collect({
      name: input.text(c.name, "Contact name", { max: 150, required: true, allowEmpty: false }),
      email: emailField(c.email, "Contact email"),
      phone: input.text(c.phone, "Contact phone", { max: 50 }),
      role: input.text(c.role, "Contact role", { max: 100 }),
      note: input.text(c.note, "Contact note", { max: 1000 }),
    });
    if (fields.error) return { error: fields.error };
    out.push(fields.values);
  }
  return { value: out };
}

/** Throws a 400 for a malformed id instead of letting Mongo answer 500. */
function assertLeadId(id) {
  if (!input.isObjectId(String(id || ""))) throw invalid("That lead id is not valid", "lead_id");
}

async function loadLead(id) {
  assertLeadId(id);
  const lead = await Lead.findById(id);
  if (!lead) throw notFound(id);
  return lead;
}

/** A lead as the detail views show it: assignee, thread authors and the converted org resolved. */
async function populatedLead(id) {
  return Lead.findById(id)
    .populate("assignee.userId", ASSIGNEE_FIELDS)
    .populate("thread.author", "name email")
    .populate("convertedOrgId", "name slug isActive");
}

/** Only platform operators can own a lead. @returns {Promise<object>} assignee subdocument */
async function resolveAssignee(userId) {
  if (!userId) return { userId: null, name: "", assignedAt: null };
  if (!input.isObjectId(String(userId))) throw new ServiceError(400, "INVALID_ASSIGNEE", "Invalid assignee", { field: "assignee_id" });
  const u = await User.findById(userId).select("name email role");
  if (!u || u.role !== "superadmin") {
    throw new ServiceError(400, "INVALID_ASSIGNEE", "The assignee must be a platform operator — see the lead staff list", { field: "assignee_id" });
  }
  return { userId: u._id, name: u.name || u.email, assignedAt: new Date() };
}

const stageEntry = (req, from, to, note) => {
  const actor = actorOf(req);
  return { from, to, changedBy: actor.id, changedByName: actor.name, note, at: new Date() };
};

/**
 * One page of leads (no thread), each with its open-task summary.
 * @param {object} query  stage, assignee ("unassigned" | user id), priority, tag, search, page, limit, sort, dir
 */
async function listLeads(query = {}, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const filter = {};
  const stage = input.filterValue(query.stage);
  if (stage && stage !== "all") filter.stage = stage;
  const assignee = input.filterValue(query.assignee);
  if (assignee === "unassigned") filter["assignee.userId"] = null;
  else if (assignee && input.isObjectId(assignee)) filter["assignee.userId"] = assignee;
  const priority = input.filterValue(query.priority);
  if (priority && priority !== "all") filter.priority = priority;
  const tag = input.filterValue(query.tag);
  if (tag && tag !== "all") filter.tags = tag;
  const rx = input.searchRegex(query.search);
  if (rx) filter.$or = [{ orgName: rx }, { contactName: rx }, { contactEmail: rx }, { tags: rx }];

  const { page, limit, skip } = input.paging(query, { defaultLimit, maxLimit });
  const { sort, key, dir } = input.sorting(query, LEAD_SORTS, { defaultKey: "activity" });

  const [leads, total, newCount] = await Promise.all([
    Lead.find(filter).select("-thread").populate("assignee.userId", ASSIGNEE_FIELDS).sort(sort).skip(skip).limit(limit).lean(),
    Lead.countDocuments(filter),
    countNewLeads(),
  ]);

  // "What is outstanding on this lead" for the whole page in one grouped query,
  // not one per row.
  const taskSummary = await taskSummaryForLeads(leads.map((l) => l._id));
  leads.forEach((l) => {
    l.tasks = taskSummary[String(l._id)] || { open: 0, overdue: 0, nextDueAt: null };
  });

  return { leads, total, page, limit, pages: Math.ceil(total / limit) || 1, sort: { key, dir }, newCount };
}

/** Unworked, non-spam leads — the sidebar badge. */
const countNewLeads = () => Lead.countDocuments({ stage: "new", flaggedSpam: false });

/** Every lead grouped by stage, for the kanban view. Capped at 1000 rows. */
async function leadBoard() {
  const leads = await Lead.find({}).select("-thread").populate("assignee.userId", ASSIGNEE_FIELDS).sort({ updatedAt: -1 }).limit(1000).lean();
  const taskSummary = await taskSummaryForLeads(leads.map((l) => l._id));
  const board = {};
  STAGES.forEach((s) => (board[s] = []));
  leads.forEach((l) => {
    l.tasks = taskSummary[String(l._id)] || { open: 0, overdue: 0, nextDueAt: null };
    (board[l.stage] || board.new).push(l);
  });
  return board;
}

/**
 * A light list for "which lead is this about?" pickers — every open lead, three
 * fields each. Closed leads appear only when searched for by name.
 */
async function leadOptions(query = {}) {
  const filter = {};
  if (!input.filterValue(query.search)) filter.stage = { $nin: ["won", "lost"] };
  const rx = input.searchRegex(query.search);
  if (rx) filter.$or = [{ orgName: rx }, { contactName: rx }, { contactEmail: rx }];
  return Lead.find(filter).select("orgName contactName contactEmail stage tags").sort({ lastMessageAt: -1 }).limit(200).lean();
}

/** Operators a lead can be assigned to. */
async function listStaff() {
  return listAssignableStaff("tenants");
}

async function getLead(id) {
  assertLeadId(id);
  const lead = await populatedLead(id);
  if (!lead) throw notFound(id);
  return lead;
}

/**
 * An operator adding a lead by hand. Everything the public intake collects is
 * accepted, so a manually-added lead is not a second-class record.
 */
async function createLead(b = {}, req) {
  const v = input.collect({
    orgName: input.text(b.orgName, "Organisation name", { max: 200, required: true, allowEmpty: false }),
    orgWebsite: input.text(b.orgWebsite, "Website", { max: 300 }),
    contactName: input.text(b.contactName, "Contact name", { max: 150, required: true, allowEmpty: false }),
    contactEmail: emailField(b.contactEmail, "Contact email", { required: true }),
    contactPhone: input.text(b.contactPhone, "Contact phone", { max: 50 }),
    contactRole: input.text(b.contactRole, "Contact role", { max: 100 }),
    country: input.text(b.country, "Country", { max: 100 }),
    message: input.text(b.message, "Notes", { max: 3000 }),
    interestedPlan: input.text(b.interestedPlan, "Interested plan", { max: 60 }),
    currentToolsOther: input.text(b.currentToolsOther, "Other tools", { max: 500 }),
    challengesOther: input.text(b.challengesOther, "Other challenges", { max: 500 }),
    causeAreas: input.stringList(b.causeAreas, "Cause areas", { max: 30 }),
    currentTools: input.stringList(b.currentTools, "Current tools", { max: 30 }),
    challenges: input.stringList(b.challenges, "Challenges", { max: 30 }),
    tags: input.stringList(b.tags, "Tags", { max: 20, maxLength: 40 }),
    verticalType: enumOrBlank(b.verticalType, "Organisation type", VERTICALS),
    staffSize: enumOrBlank(b.staffSize, "Staff size", STAFF_SIZES),
    annualBudgetRange: enumOrBlank(b.annualBudgetRange, "Annual budget", BUDGET_RANGES),
    donorDatabaseSize: enumOrBlank(b.donorDatabaseSize, "Donor database size", DONOR_DB_SIZES),
    timeline: enumOrBlank(b.timeline, "Timeline", TIMELINES),
    decisionRole: enumOrBlank(b.decisionRole, "Decision role", DECISION_ROLES),
    interestedBillingCycle: enumOrBlank(b.interestedBillingCycle, "Billing cycle", BILLING_CYCLES),
    priority: enumOrBlank(b.priority, "Priority", LEAD_PRIORITIES),
    source: enumOrBlank(b.source, "Source", MANUAL_SOURCES),
    dealValue: dealValueField(b.dealValue),
    expectedCloseAt: input.date(b.expectedCloseAt, "Expected close date"),
    contacts: parseContacts(b.contacts),
    stage: enumOrBlank(b.stage, "Stage", ACTIVE_STAGES),
  });
  if (v.error) throw invalid(v.error, v.field);

  const assignee = await resolveAssignee(b.assigneeUserId);
  const stage = v.values.stage || "new";
  const consent = b.consentToContact === true || b.consentToContact === "true";
  const lead = await Lead.create({
    ...v.values,
    verticalType: v.values.verticalType || "general",
    priority: v.values.priority || "normal",
    source: v.values.source || "superadmin_manual",
    stage,
    assignee,
    // An operator typing the record IS the first contact, so the consent flag
    // records who vouched for it — that field gates whether we may email them.
    consentToContact: consent,
    consentAt: consent ? new Date() : null,
    lastMessageAt: new Date(),
    stageHistory: [stageEntry(req, "", stage, "Added by an operator")],
  });

  await writeAudit(req, "lead.created", { targetType: "lead", targetId: String(lead._id) });
  emitToSuperAdmins("lead:new", { id: String(lead._id) });
  return lead;
}

/**
 * Whitelisted intake-field edits. Only fields PRESENT in the body are validated
 * and written — an absent field stays untouched rather than being overwritten
 * with the "" a not-required text input defaults to.
 */
async function updateLead(id, b = {}, req) {
  assertLeadId(id);
  const fieldValidators = {
    orgName: () => input.text(b.orgName, "Organisation name", { max: 200, required: true, allowEmpty: false }),
    orgWebsite: () => input.text(b.orgWebsite, "Website", { max: 300 }),
    contactName: () => input.text(b.contactName, "Contact name", { max: 150, required: true, allowEmpty: false }),
    contactEmail: () => emailField(b.contactEmail, "Contact email", { required: true }),
    contactPhone: () => input.text(b.contactPhone, "Contact phone", { max: 50 }),
    contactRole: () => input.text(b.contactRole, "Contact role", { max: 100 }),
    country: () => input.text(b.country, "Country", { max: 100 }),
    message: () => input.text(b.message, "Message", { max: 3000 }),
    interestedPlan: () => input.text(b.interestedPlan, "Interested plan", { max: 60 }),
    causeAreas: () => input.stringList(b.causeAreas, "Cause areas", { max: 30 }),
    currentTools: () => input.stringList(b.currentTools, "Current tools", { max: 30 }),
    challenges: () => input.stringList(b.challenges, "Challenges", { max: 30 }),
    currentToolsOther: () => input.text(b.currentToolsOther, "Other tools", { max: 500 }),
    challengesOther: () => input.text(b.challengesOther, "Other challenges", { max: 500 }),
    // enumOrBlank, not oneOf — create() accepts "", so an update that refused it
    // would make a lead saved with the field blank impossible to edit at all.
    verticalType: () => enumOrBlank(b.verticalType, "Organisation type", VERTICALS),
    staffSize: () => enumOrBlank(b.staffSize, "Staff size", STAFF_SIZES),
    annualBudgetRange: () => enumOrBlank(b.annualBudgetRange, "Annual budget", BUDGET_RANGES),
    donorDatabaseSize: () => enumOrBlank(b.donorDatabaseSize, "Donor database size", DONOR_DB_SIZES),
    timeline: () => enumOrBlank(b.timeline, "Timeline", TIMELINES),
    decisionRole: () => enumOrBlank(b.decisionRole, "Decision role", DECISION_ROLES),
    interestedBillingCycle: () => enumOrBlank(b.interestedBillingCycle, "Billing cycle", BILLING_CYCLES),
    dealValue: () => dealValueField(b.dealValue),
    expectedCloseAt: () => input.date(b.expectedCloseAt, "Expected close date"),
    priority: () => enumOrBlank(b.priority, "Priority", LEAD_PRIORITIES),
    tags: () => input.stringList(b.tags, "Tags", { max: 20, maxLength: 40 }),
    contacts: () => parseContacts(b.contacts),
  };

  const patch = {};
  for (const [key, validate] of Object.entries(fieldValidators)) {
    if (!(key in b)) continue;
    const result = validate();
    if (result.error) throw invalid(result.error, key);
    patch[key] = result.value;
  }
  if (!Object.keys(patch).length) throw invalid("No fields to update");

  const lead = await Lead.findByIdAndUpdate(id, { $set: patch }, { new: true }).populate("assignee.userId", ASSIGNEE_FIELDS);
  if (!lead) throw notFound(id);

  await writeAudit(req, "lead.updated", { targetType: "lead", targetId: String(lead._id), meta: { fields: Object.keys(patch) } });
  emitToSuperAdmins("lead:updated", { id: String(lead._id) });
  return lead;
}

/**
 * Move an open lead along the pipeline, or close it as lost (with a reason).
 * "won" is only ever set by conversion, so a lead can never read Won without a
 * real organisation behind it.
 */
async function changeStage(id, { stage, lostReason, lostReasonNote, note } = {}, req) {
  if (stage === "won") throw new ServiceError(409, "LEAD_WON_REQUIRES_CONVERT", "Use Convert to mark a lead Won", { field: "stage" });
  const stageResult = input.oneOf(stage, "Stage", ACTIVE_STAGES.concat("lost"));
  if (stageResult.error) throw invalid(stageResult.error, "stage");
  const nextStage = stageResult.value;

  let reason;
  if (nextStage === "lost") {
    const r = input.oneOf(lostReason, "Lost reason", LOST_REASONS);
    if (r.error) throw invalid(r.error, "lost_reason");
    reason = r.value;
  }
  const reasonNote = input.text(lostReasonNote, "Lost reason note", { max: 1000 });
  if (reasonNote.error) throw invalid(reasonNote.error, "lost_reason_note");
  const noteText = input.text(note, "Note", { max: 1000 });
  if (noteText.error) throw invalid(noteText.error, "note");

  const lead = await loadLead(id);
  if (["won", "lost"].includes(lead.stage)) throw closed();

  const from = lead.stage;
  lead.stage = nextStage;
  if (nextStage === "lost") {
    lead.lostReason = reason;
    lead.lostReasonNote = reasonNote.value;
    lead.lostAt = new Date();
  }
  lead.stageHistory.push(stageEntry(req, from, nextStage, noteText.value));
  await lead.save();

  await writeAudit(req, "lead.stage_changed", { targetType: "lead", targetId: String(lead._id), meta: { from, to: nextStage, lostReason: reason || undefined } });
  emitToSuperAdmins("lead:updated", { id: String(lead._id), stage: lead.stage });
  return lead;
}

/**
 * Add an internal note, or a reply that is EMAILED to the lead's contact.
 * Either moves a "new" lead to "contacted".
 * @param {object} msg
 * @param {"note"|"reply"} [msg.kind="note"]
 * @param {string} msg.body
 * @param {string[]} [msg.mentions]  operator user ids
 * @param {string} [msg.authorName]  name shown on the thread and signed on the email (defaults to the actor)
 * @returns {Promise<{lead:object, emailStatus:""|"sent"|"failed"}>}
 */
async function addMessage(id, { kind, body, mentions, authorName } = {}, req) {
  if (kind !== undefined && !["note", "reply"].includes(kind)) throw invalid("kind must be note or reply", "kind");
  const parsed = input.text(body, "Message", { max: 20000, required: true, allowEmpty: false });
  if (parsed.error) throw invalid("Message is required", "body");
  const name = input.text(authorName, "Author name", { max: 150 });
  if (name.error) throw invalid(name.error, "author_name");

  const lead = await loadLead(id);
  const actor = actorOf(req);
  const entry = {
    kind: kind === "reply" ? "reply" : "note",
    body: parsed.value,
    author: actor.id,
    authorName: name.value || actor.name,
    mentions: Array.isArray(mentions) ? mentions.filter((m) => input.isObjectId(String(m))) : [],
  };

  const from = lead.stage;
  if (entry.kind === "reply") {
    const result = await sendTemplateEmail("lead.reply", {
      to: lead.contactEmail,
      data: {
        recipient: { name: lead.contactName || "", email: lead.contactEmail },
        lead: { orgName: lead.orgName || "" },
        message: { body: entry.body },
        // The customer reads this — an integration label is no signature.
        staff: { name: name.value || req?.user?.name || req?.user?.email || "" },
      },
      meta: { leadId: String(lead._id) },
    });
    entry.emailedTo = lead.contactEmail;
    entry.emailStatus = result?.success ? "sent" : "failed";
  }
  if (lead.stage === "new") {
    lead.stage = "contacted";
    lead.stageHistory.push(stageEntry(req, from, lead.stage, entry.kind === "reply" ? "Replied" : "Note added"));
  }

  lead.thread.push(entry);
  lead.lastMessageAt = new Date();
  await lead.save();

  await writeAudit(req, "lead.message_added", { targetType: "lead", targetId: String(lead._id), meta: { kind: entry.kind } });
  emitToSuperAdmins("lead:message", { id: String(lead._id), stage: lead.stage });

  const populated = await populatedLead(lead._id);
  const last = populated.thread[populated.thread.length - 1];
  return { lead: populated, emailStatus: last?.emailStatus || "" };
}

/** Assign to an operator, or unassign with a falsy userId. */
async function assignLead(id, userId, req) {
  const assignee = await resolveAssignee(userId);
  const lead = await loadLead(id);
  lead.assignee = assignee;
  await lead.save();

  await writeAudit(req, "lead.assigned", { targetType: "lead", targetId: String(lead._id), meta: { userId: assignee.userId ? String(assignee.userId) : null } });
  emitToSuperAdmins("lead:updated", { id: String(lead._id) });
  return Lead.findById(lead._id).populate("assignee.userId", ASSIGNEE_FIELDS);
}

/**
 * Turn a lead into a tenant — see services/leadConversion.js for each path.
 *   mode "activation_link"                         email a pre-filled self-serve signup link
 *   mode "manual_provision", billingMode "comp"    create the tenant now, comped (default)
 *   mode "manual_provision", billingMode "send_link"   create it pending + email a payment link
 *   mode "manual_provision", billingMode "charge_now"  console only: card entered in the browser
 *
 * @param {object} [opts]
 * @param {boolean} [opts.allowChargeNow=true]  false for server-to-server callers, which can't collect a card
 * @returns {Promise<{outcome:string, lead:object, organisation?:object, link?:string, emailStatus?:string, clientSecret?:string}>}
 */
async function convertLead(id, body = {}, req, { allowChargeNow = true } = {}) {
  const mode = body?.mode;
  if (!CONVERSION_MODES.includes(mode)) throw invalid(`mode must be one of: ${CONVERSION_MODES.join(", ")}`, "mode");
  // "comp" is the default so existing callers keep working unchanged.
  const billingMode = mode === "manual_provision" ? body?.billingMode || "comp" : null;
  if (billingMode && !BILLING_MODES.includes(billingMode)) throw invalid(`billing_mode must be one of: ${BILLING_MODES.join(", ")}`, "billing_mode");
  if (billingMode === "charge_now" && !allowChargeNow) {
    throw new ServiceError(400, "CHARGE_NOW_UNSUPPORTED", "charge_now needs a card entered in the browser — use send_link to email a payment link instead", { field: "billing_mode" });
  }

  const lead = await loadLead(id);
  if (["won", "lost"].includes(lead.stage)) throw closed();

  const leadId = String(lead._id);
  try {
    if (mode === "activation_link") {
      const { link, emailStatus } = await leadConversion.createActivationLink(lead, body, req);
      await writeAudit(req, "lead.activation_link_sent", { targetType: "lead", targetId: leadId, meta: { emailStatus } });
      emitToSuperAdmins("lead:updated", { id: leadId });
      return { outcome: "activation_link_sent", lead, link, emailStatus };
    }

    if (billingMode === "charge_now") {
      const { organisation, clientSecret } = await leadConversion.beginChargeNow(lead, body, req);
      await writeAudit(req, "lead.payment_started", { organisationId: organisation._id, targetType: "lead", targetId: leadId, meta: { billingMode } });
      emitToSuperAdmins("lead:updated", { id: leadId });
      return { outcome: "payment_started", lead, organisation, clientSecret };
    }

    if (billingMode === "send_link") {
      const { link, organisation, emailStatus } = await leadConversion.sendPaymentLink(lead, body, req);
      await writeAudit(req, "lead.payment_link_sent", { organisationId: organisation._id, targetType: "lead", targetId: leadId, meta: { billingMode, emailStatus } });
      emitToSuperAdmins("lead:updated", { id: leadId });
      return { outcome: "payment_link_sent", lead, organisation, link, emailStatus };
    }

    const { organisation, emailStatus } = await leadConversion.manualProvision(lead, body, req);
    await writeAudit(req, "lead.converted", { organisationId: organisation._id, targetType: "lead", targetId: leadId, meta: { mode: "manual_provision", billingMode: "comp", emailStatus } });
    emitToSuperAdmins("lead:converted", { id: leadId, organisationId: String(organisation._id) });
    emitToSuperAdmins("organisation:updated", { organisationId: String(organisation._id) });
    return { outcome: "converted", lead, organisation, emailStatus };
  } catch (err) {
    if (isServiceError(err)) throw err;
    // leadConversion reports expected failures as { statusCode, publicMessage }.
    if (err && err.statusCode && err.publicMessage) {
      throw new ServiceError(err.statusCode, err.statusCode === 400 ? "VALIDATION_ERROR" : "CONVERSION_FAILED", err.publicMessage);
    }
    throw err;
  }
}

async function deleteLead(id, req) {
  assertLeadId(id);
  const lead = await Lead.findByIdAndDelete(id);
  if (!lead) throw notFound(id);
  await writeAudit(req, "lead.deleted", { targetType: "lead", targetId: String(id), meta: { orgName: lead.orgName, contactEmail: lead.contactEmail } });
  emitToSuperAdmins("lead:deleted", { id: String(id) });
  return lead;
}

module.exports = {
  STAGES,
  ACTIVE_STAGES,
  LOST_REASONS,
  VERTICALS,
  STAFF_SIZES,
  BUDGET_RANGES,
  DONOR_DB_SIZES,
  TIMELINES,
  DECISION_ROLES,
  LEAD_PRIORITIES,
  MANUAL_SOURCES,
  LEAD_SORT_KEYS: Object.keys(LEAD_SORTS),
  listLeads,
  countNewLeads,
  leadBoard,
  leadOptions,
  listStaff,
  getLead,
  createLead,
  updateLead,
  changeStage,
  addMessage,
  assignLead,
  convertLead,
  deleteLead,
};
