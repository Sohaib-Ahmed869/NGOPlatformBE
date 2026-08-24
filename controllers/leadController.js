const Lead = require("../models/lead");
const User = require("../models/user");
const { sendEmail } = require("../services/emailUtil");
const { emitToSuperAdmins } = require("../services/socket");
const writeAudit = require("../utils/writeAudit");
const leadConversion = require("../services/leadConversion");
const input = require("../utils/operatorInput");
const { listAssignableStaff } = require("../utils/platformStaff");

const ACTIVE_STAGES = Lead.STAGES.filter((s) => s !== "won" && s !== "lost");
const LOST_REASONS = ["budget", "timing", "chose_competitor", "no_response", "not_a_fit", "spam", "other"];

/** GET /api/superadmin/leads */
exports.list = async (req, res) => {
  try {
    const filter = {};
    const stage = input.filterValue(req.query.stage);
    if (stage && stage !== "all") filter.stage = stage;
    const assignee = input.filterValue(req.query.assignee);
    if (assignee === "unassigned") filter["assignee.userId"] = null;
    else if (assignee && input.isObjectId(assignee)) filter["assignee.userId"] = assignee;

    const rx = input.searchRegex(req.query.search);
    if (rx) filter.$or = [{ orgName: rx }, { contactName: rx }, { contactEmail: rx }];

    const { page, limit, skip } = input.paging(req.query, { defaultLimit: 25, maxLimit: 100 });

    const [leads, total, newCount] = await Promise.all([
      Lead.find(filter)
        .select("-thread")
        .populate("assignee.userId", "name email profileImage")
        .sort({ lastMessageAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Lead.countDocuments(filter),
      Lead.countDocuments({ stage: "new", flaggedSpam: false }),
    ]);

    res.json({ leads, pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 }, newCount });
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

    const board = {};
    Lead.STAGES.forEach((s) => (board[s] = []));
    leads.forEach((l) => {
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
      contactEmail: () => input.text(b.contactEmail, "Contact email", { max: 250, required: true }),
      contactPhone: () => input.text(b.contactPhone, "Contact phone", { max: 50 }),
      contactRole: () => input.text(b.contactRole, "Contact role", { max: 100 }),
      country: () => input.text(b.country, "Country", { max: 100 }),
      message: () => input.text(b.message, "Message", { max: 3000 }),
      interestedPlan: () => input.text(b.interestedPlan, "Interested plan", { max: 60 }),
      causeAreas: () => input.stringList(b.causeAreas, "Cause areas", { max: 30 }),
      currentTools: () => input.stringList(b.currentTools, "Current tools", { max: 30 }),
      challenges: () => input.stringList(b.challenges, "Challenges", { max: 30 }),
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
      const result = await sendEmail(lead.contactEmail, entry.body, `Re: ${lead.orgName}`);
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
      const { link } = await leadConversion.createActivationLink(lead, req.body, req);
      await writeAudit(req, "lead.activation_link_sent", { targetType: "lead", targetId: String(lead._id) });
      emitToSuperAdmins("lead:updated", { id: String(lead._id) });
      return res.json({ message: "Activation link sent", lead, link });
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
      const { link, organisation } = await leadConversion.sendPaymentLink(lead, req.body, req);
      await writeAudit(req, "lead.payment_link_sent", {
        organisationId: organisation._id,
        targetType: "lead",
        targetId: String(lead._id),
        meta: { billingMode },
      });
      emitToSuperAdmins("lead:updated", { id: String(lead._id) });
      return res.json({ message: "Payment link sent", lead, organisation, link });
    }

    const { organisation } = await leadConversion.manualProvision(lead, req.body, req);
    await writeAudit(req, "lead.converted", {
      organisationId: organisation._id,
      targetType: "lead",
      targetId: String(lead._id),
      meta: { mode: "manual_provision", billingMode: "comp" },
    });
    emitToSuperAdmins("lead:converted", { id: String(lead._id), organisationId: String(organisation._id) });
    emitToSuperAdmins("organisation:updated", { organisationId: String(organisation._id) });
    res.json({ message: "Organisation created", lead, organisation });
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
