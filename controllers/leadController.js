const Lead = require("../models/lead");
const User = require("../models/user");
const { sendTemplateEmail } = require("../services/emailUtil");
const { emitToSuperAdmins } = require("../services/socket");
const writeAudit = require("../utils/writeAudit");
const leadConversion = require("../services/leadConversion");
const input = require("../utils/operatorInput");
const { listAssignableStaff } = require("../utils/platformStaff");
const { taskSummaryForLeads } = require("./crmTaskController");

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

const ACTIVE_STAGES = Lead.STAGES.filter((s) => s !== "won" && s !== "lost");
const LOST_REASONS = ["budget", "timing", "chose_competitor", "no_response", "not_a_fit", "spam", "other"];

/* ── shared field validation ─────────────────────────────────────────────── */

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

// Deliberately loose. The job here is to catch "priya@" and "priya.org" — the
// typos that make a Reply silently go nowhere — not to adjudicate RFC 5322.
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
 * The annualised value of a deal.
 *
 * Cleared reads as 0, never null: `dealValue` is summed into the pipeline
 * total, and a null in that sum turns the whole figure into null rather than
 * leaving one lead out of it. The cap is well above any real charity contract —
 * it is there to catch a slipped decimal point reporting a nine-figure
 * pipeline, not to limit ambition.
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

/** GET /api/superadmin/leads */
exports.list = async (req, res) => {
  try {
    const filter = {};
    const stage = input.filterValue(req.query.stage);
    if (stage && stage !== "all") filter.stage = stage;
    const assignee = input.filterValue(req.query.assignee);
    if (assignee === "unassigned") filter["assignee.userId"] = null;
    else if (assignee && input.isObjectId(assignee)) filter["assignee.userId"] = assignee;

    const priority = input.filterValue(req.query.priority);
    if (priority && priority !== "all") filter.priority = priority;
    const tag = input.filterValue(req.query.tag);
    if (tag && tag !== "all") filter.tags = tag;

    const rx = input.searchRegex(req.query.search);
    if (rx) filter.$or = [{ orgName: rx }, { contactName: rx }, { contactEmail: rx }, { tags: rx }];

    const { page, limit, skip } = input.paging(req.query, { defaultLimit: 25, maxLimit: 100 });
    const { sort, key: sortKey, dir: sortDir } = input.sorting(req.query, LEAD_SORTS, {
      defaultKey: "activity",
    });

    const [leads, total, newCount] = await Promise.all([
      Lead.find(filter)
        .select("-thread")
        .populate("assignee.userId", "name email profileImage")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      Lead.countDocuments(filter),
      Lead.countDocuments({ stage: "new", flaggedSpam: false }),
    ]);

    // "What is outstanding on this lead" answered for the whole page in one
    // grouped query rather than one per row. Without it the only honest way to
    // show a follow-up column would be 25 round trips per render.
    const taskSummary = await taskSummaryForLeads(leads.map((l) => l._id));
    leads.forEach((l) => {
      l.tasks = taskSummary[String(l._id)] || { open: 0, overdue: 0, nextDueAt: null };
    });

    res.json({
      leads,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
      // Echoed back so the screen can render the arrow from what the server
      // actually did, not from what it asked for.
      sort: { key: sortKey, dir: sortDir },
      newCount,
    });
  } catch (err) {
    console.error("List leads error:", err);
    res.status(500).json({ error: "Failed to fetch leads" });
  }
};

/** GET /api/superadmin/leads/new-count — sidebar badge driver */
exports.newCount = async (req, res) => {
  try {
    const count = await Lead.countDocuments({ stage: "new", flaggedSpam: false });
    res.json({ count });
  } catch (err) {
    console.error("Lead new-count error:", err);
    res.status(500).json({ error: "Failed to fetch count" });
  }
};

/** GET /api/superadmin/leads/board — grouped by pipeline stage, for the kanban view */
exports.board = async (req, res) => {
  try {
    const leads = await Lead.find({})
      .select("-thread")
      .populate("assignee.userId", "name email profileImage")
      .sort({ updatedAt: -1 })
      .limit(1000)
      .lean();

    const taskSummary = await taskSummaryForLeads(leads.map((l) => l._id));

    const board = {};
    Lead.STAGES.forEach((s) => (board[s] = []));
    leads.forEach((l) => {
      l.tasks = taskSummary[String(l._id)] || { open: 0, overdue: 0, nextDueAt: null };
      (board[l.stage] || board.new).push(l);
    });
    res.json({ board });
  } catch (err) {
    console.error("Lead board error:", err);
    res.status(500).json({ error: "Failed to fetch pipeline board" });
  }
};

/** GET /api/superadmin/leads/staff — assignable operators */
exports.getStaff = async (req, res) => {
  try {
    const staff = await listAssignableStaff("tenants");
    res.json({ staff });
  } catch (err) {
    console.error("Get lead staff error:", err);
    res.status(500).json({ error: "Failed to fetch staff" });
  }
};

/** GET /api/superadmin/leads/:id */
exports.get = async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id)
      .populate("assignee.userId", "name email profileImage")
      .populate("thread.author", "name email")
      .populate("convertedOrgId", "name slug isActive");
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    res.json({ lead });
  } catch (err) {
    console.error("Get lead error:", err);
    res.status(500).json({ error: "Failed to fetch lead" });
  }
};

/**
 * GET /api/superadmin/leads/options — a light list for "which lead is this
 * about?" pickers.
 *
 * Separate from `list` rather than a `limit=500` call to it because the two
 * answer different questions: the table wants a page of fully-populated rows,
 * a picker wants every open lead and three fields each. Reusing the table's
 * endpoint would mean either shipping the whole document set or a picker that
 * silently cannot find the lead on page two.
 */
exports.options = async (req, res) => {
  try {
    const filter = {};
    // Closed leads still appear when searched for by name — a task about a
    // won deal (onboarding, a check-in call) is ordinary work — but they stay
    // out of the default list so the picker opens on live pipeline.
    if (!input.filterValue(req.query.search)) filter.stage = { $nin: ["won", "lost"] };
    const rx = input.searchRegex(req.query.search);
    if (rx) filter.$or = [{ orgName: rx }, { contactName: rx }, { contactEmail: rx }];

    const leads = await Lead.find(filter)
      // `tags` rides along so the lead editor can offer the vocabulary already
      // in use without a second request — one array of short strings per row.
      .select("orgName contactName contactEmail stage tags")
      .sort({ lastMessageAt: -1 })
      .limit(200)
      .lean();
    res.json({ leads });
  } catch (err) {
    console.error("Lead options error:", err);
    res.status(500).json({ error: "Failed to fetch leads" });
  }
};

/**
 * POST /api/superadmin/leads — an operator adding a lead by hand.
 *
 * Until now a lead could only exist by someone filling in the public form,
 * which meant the deal that started as a conversation at a conference had
 * nowhere to live. Everything the public intake collects is accepted here too,
 * so a manually-added lead is not a second-class record.
 */
exports.create = async (req, res) => {
  try {
    const b = req.body || {};
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
    if (v.error) return res.status(400).json({ error: v.error });

    let assignee = { userId: null, name: "", assignedAt: null };
    if (b.assigneeUserId) {
      if (!input.isObjectId(String(b.assigneeUserId))) return res.status(400).json({ error: "Invalid assignee" });
      const u = await User.findById(b.assigneeUserId).select("name email role");
      if (!u || u.role !== "superadmin") return res.status(400).json({ error: "Invalid assignee" });
      assignee = { userId: u._id, name: u.name || u.email, assignedAt: new Date() };
    }

    const stage = v.values.stage || "new";
    const lead = await Lead.create({
      ...v.values,
      verticalType: v.values.verticalType || "general",
      priority: v.values.priority || "normal",
      source: v.values.source || "superadmin_manual",
      stage,
      assignee,
      // An operator typing the record IS the first contact, so the consent flag
      // records who vouched for it rather than being left implicitly false —
      // that field gates whether we may email them at all.
      consentToContact: b.consentToContact === true || b.consentToContact === "true",
      consentAt: b.consentToContact ? new Date() : null,
      lastMessageAt: new Date(),
      stageHistory: [
        {
          from: "",
          to: stage,
          changedBy: req.user._id,
          changedByName: req.user.name || req.user.email || "",
          note: "Added by an operator",
          at: new Date(),
        },
      ],
    });

    await writeAudit(req, "lead.created", { targetType: "lead", targetId: String(lead._id) });
    emitToSuperAdmins("lead:new", { id: String(lead._id) });
    res.status(201).json({ lead });
  } catch (err) {
    console.error("Create lead error:", err);
    res.status(500).json({ error: "Failed to create lead" });
  }
};

/** PATCH /api/superadmin/leads/:id — whitelisted intake-field edits */
exports.update = async (req, res) => {
  try {
    const b = req.body || {};
    // Only fields actually present in the body are validated/written — unlike
    // `collect()`, an absent field must stay untouched, not get overwritten
    // with the "" a not-required input.text() would otherwise default to.
    const fieldValidators = {
      orgName: () => input.text(b.orgName, "Organisation name", { max: 200, required: true }),
      orgWebsite: () => input.text(b.orgWebsite, "Website", { max: 300 }),
      contactName: () => input.text(b.contactName, "Contact name", { max: 150, required: true }),
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
      // enumOrBlank, not oneOf — create() accepts "" for both of these, so an
      // update that refused it would make a lead saved with the field blank
      // impossible to edit at all. See enumOrBlank above.
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
      if (result.error) return res.status(400).json({ error: result.error });
      patch[key] = result.value;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: "No fields to update" });

    const lead = await Lead.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true }).populate(
      "assignee.userId",
      "name email profileImage"
    );
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    await writeAudit(req, "lead.updated", { targetType: "lead", targetId: String(lead._id) });
    emitToSuperAdmins("lead:updated", { id: String(lead._id) });
    res.json({ lead });
  } catch (err) {
    console.error("Update lead error:", err);
    res.status(500).json({ error: "Failed to update lead" });
  }
};

/** PATCH /api/superadmin/leads/:id/stage  { stage, lostReason?, lostReasonNote?, note? } */
exports.changeStage = async (req, res) => {
  try {
    const requested = req.body?.stage;
    if (requested === "won") {
      return res.status(400).json({ error: "Use Convert to mark a lead Won" });
    }
    const stageResult = input.oneOf(requested, "Stage", ACTIVE_STAGES.concat("lost"));
    if (stageResult.error) return res.status(400).json({ error: stageResult.error });
    const nextStage = stageResult.value;

    let lostReason;
    if (nextStage === "lost") {
      const r = input.oneOf(req.body?.lostReason, "Lost reason", LOST_REASONS);
      if (r.error) return res.status(400).json({ error: r.error });
      lostReason = r.value;
    }
    const lostReasonNote = input.text(req.body?.lostReasonNote, "Lost reason note", { max: 1000 });
    if (lostReasonNote.error) return res.status(400).json({ error: lostReasonNote.error });
    const note = input.text(req.body?.note, "Note", { max: 1000 });
    if (note.error) return res.status(400).json({ error: note.error });

    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (["won", "lost"].includes(lead.stage)) {
      return res.status(400).json({ error: "This lead is already closed" });
    }

    const from = lead.stage;
    lead.stage = nextStage;
    if (nextStage === "lost") {
      lead.lostReason = lostReason;
      lead.lostReasonNote = lostReasonNote.value;
      lead.lostAt = new Date();
    }
    lead.stageHistory.push({
      from,
      to: nextStage,
      changedBy: req.user._id,
      changedByName: req.user.name || req.user.email || "",
      note: note.value,
      at: new Date(),
    });
    await lead.save();

    await writeAudit(req, "lead.stage_changed", {
      targetType: "lead",
      targetId: String(lead._id),
      meta: { from, to: nextStage, lostReason: lostReason || undefined },
    });
    emitToSuperAdmins("lead:updated", { id: String(lead._id), stage: lead.stage });
    res.json({ lead });
  } catch (err) {
    console.error("Change lead stage error:", err);
    res.status(500).json({ error: "Failed to change stage" });
  }
};

/** POST /api/superadmin/leads/:id/messages  { kind, body, mentions } */
exports.addMessage = async (req, res) => {
  try {
    const { kind } = req.body;
    const parsed = input.text(req.body?.body, "Message", { max: 20000, required: true, allowEmpty: false });
    if (parsed.error) return res.status(400).json({ error: "Message is required" });
    const body = parsed.value;

    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    const entry = {
      kind: kind === "reply" ? "reply" : "note",
      body,
      author: req.user._id,
      authorName: req.user.name || req.user.email || "",
      mentions: Array.isArray(req.body.mentions) ? req.body.mentions.filter(Boolean) : [],
    };

    const from = lead.stage;
    if (entry.kind === "reply") {
      const result = await sendTemplateEmail("lead.reply", {
        to: lead.contactEmail,
        data: {
          recipient: { name: lead.contactName || "", email: lead.contactEmail },
          lead: { orgName: lead.orgName || "" },
          message: { body: entry.body },
          staff: { name: req.user?.name || req.user?.email || "" },
        },
        meta: { leadId: String(lead._id) },
      });
      entry.emailedTo = lead.contactEmail;
      entry.emailStatus = result?.success ? "sent" : "failed";
      if (lead.stage === "new") lead.stage = "contacted";
    } else if (lead.stage === "new") {
      lead.stage = "contacted";
    }
    if (lead.stage !== from) {
      lead.stageHistory.push({
        from,
        to: lead.stage,
        changedBy: req.user._id,
        changedByName: req.user.name || req.user.email || "",
        note: entry.kind === "reply" ? "Replied" : "Note added",
        at: new Date(),
      });
    }

    lead.thread.push(entry);
    lead.lastMessageAt = new Date();
    await lead.save();

    const populated = await Lead.findById(lead._id)
      .populate("assignee.userId", "name email profileImage")
      .populate("thread.author", "name email");

    await writeAudit(req, "lead.message_added", { targetType: "lead", targetId: String(lead._id), meta: { kind: entry.kind } });
    emitToSuperAdmins("lead:message", { id: String(lead._id), stage: lead.stage });

    const last = populated.thread[populated.thread.length - 1];
    res.json({ lead: populated, emailStatus: last?.emailStatus || "" });
  } catch (err) {
    console.error("Add lead message error:", err);
    res.status(500).json({ error: "Failed to add message" });
  }
};

/** PATCH /api/superadmin/leads/:id/assign  { userId } */
exports.assign = async (req, res) => {
  try {
    const { userId } = req.body;
    if (userId && !input.isObjectId(String(userId))) {
      return res.status(400).json({ error: "Invalid assignee" });
    }
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    if (userId) {
      const u = await User.findById(userId).select("name email role");
      if (!u || u.role !== "superadmin") return res.status(400).json({ error: "Invalid assignee" });
      lead.assignee = { userId: u._id, name: u.name || u.email, assignedAt: new Date() };
    } else {
      lead.assignee = { userId: null, name: "", assignedAt: null };
    }
    await lead.save();

    const populated = await Lead.findById(lead._id).populate("assignee.userId", "name email profileImage");
    await writeAudit(req, "lead.assigned", { targetType: "lead", targetId: String(lead._id), meta: { userId: userId || null } });
    emitToSuperAdmins("lead:updated", { id: String(lead._id) });
    res.json({ lead: populated });
  } catch (err) {
    console.error("Assign lead error:", err);
    res.status(500).json({ error: "Failed to assign lead" });
  }
};

/** POST /api/superadmin/leads/:id/convert  { mode: "activation_link"|"manual_provision", ... } */
exports.convert = async (req, res) => {
  try {
    const mode = req.body?.mode;
    if (!["activation_link", "manual_provision"].includes(mode)) {
      return res.status(400).json({ error: "Invalid conversion mode" });
    }
    // manual_provision has three billing sub-modes; "comp" is the default so
    // existing callers (and the old comped-only modal) keep working unchanged.
    const billingMode = mode === "manual_provision" ? req.body?.billingMode || "comp" : null;
    if (billingMode && !["comp", "charge_now", "send_link"].includes(billingMode)) {
      return res.status(400).json({ error: "Invalid billing mode" });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (["won", "lost"].includes(lead.stage)) {
      return res.status(400).json({ error: "This lead is already closed" });
    }

    if (mode === "activation_link") {
      const { link, emailStatus } = await leadConversion.createActivationLink(lead, req.body, req);
      await writeAudit(req, "lead.activation_link_sent", { targetType: "lead", targetId: String(lead._id), meta: { emailStatus } });
      emitToSuperAdmins("lead:updated", { id: String(lead._id) });
      return res.json({ message: "Activation link sent", lead, link, emailStatus });
    }

    if (billingMode === "charge_now") {
      const { organisation, clientSecret } = await leadConversion.beginChargeNow(lead, req.body, req);
      await writeAudit(req, "lead.payment_started", {
        organisationId: organisation._id,
        targetType: "lead",
        targetId: String(lead._id),
        meta: { billingMode },
      });
      emitToSuperAdmins("lead:updated", { id: String(lead._id) });
      return res.json({ message: "Enter the card to finish this deal", lead, organisation, clientSecret });
    }

    if (billingMode === "send_link") {
      const { link, organisation, emailStatus } = await leadConversion.sendPaymentLink(lead, req.body, req);
      await writeAudit(req, "lead.payment_link_sent", {
        organisationId: organisation._id,
        targetType: "lead",
        targetId: String(lead._id),
        meta: { billingMode, emailStatus },
      });
      emitToSuperAdmins("lead:updated", { id: String(lead._id) });
      return res.json({ message: "Payment link sent", lead, organisation, link, emailStatus });
    }

    const { organisation, emailStatus } = await leadConversion.manualProvision(lead, req.body, req);
    await writeAudit(req, "lead.converted", {
      organisationId: organisation._id,
      targetType: "lead",
      targetId: String(lead._id),
      meta: { mode: "manual_provision", billingMode: "comp", emailStatus },
    });
    emitToSuperAdmins("lead:converted", { id: String(lead._id), organisationId: String(organisation._id) });
    emitToSuperAdmins("organisation:updated", { organisationId: String(organisation._id) });
    res.json({ message: "Organisation created", lead, organisation, emailStatus });
  } catch (err) {
    console.error("Convert lead error:", err);
    res.status(err.statusCode || 500).json({ error: err.publicMessage || "Failed to convert lead" });
  }
};

/** DELETE /api/superadmin/leads/:id */
exports.remove = async (req, res) => {
  try {
    const lead = await Lead.findByIdAndDelete(req.params.id);
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    await writeAudit(req, "lead.deleted", { targetType: "lead", targetId: String(req.params.id) });
    emitToSuperAdmins("lead:deleted", { id: String(req.params.id) });
    res.json({ message: "Deleted" });
  } catch (err) {
    console.error("Delete lead error:", err);
    res.status(500).json({ error: "Failed to delete lead" });
  }
};
