const mongoose = require("mongoose");
const Join = require("../models/join");
const Event = require("../models/event");
const EventRegistration = require("../models/eventRegistration");
const User = require("../models/user");
const Organisation = require("../models/organisation");
const { sendEmail } = require("../services/emailUtil");
const { emitToOrg } = require("../services/socket");

const QUESTION_TYPES = ["text", "textarea", "select", "checkbox", "number", "email", "phone"];

// Slug a question label into a stable, storage-safe key.
const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

// Validate + whitelist submitted answers against the org's questions. Returns
// `{ answers }` or `{ error }` when a required question is missing.
function cleanAnswers(questions, raw) {
  const out = {};
  const src = raw && typeof raw === "object" ? raw : {};
  for (const q of questions || []) {
    let val = src[q.key];
    if (q.type === "checkbox") {
      val = Array.isArray(val) ? val.filter((x) => x != null && x !== "") : val ? [val] : [];
      if (q.required && val.length === 0) return { error: `"${q.label}" is required` };
      if (val.length) out[q.key] = val;
    } else {
      val = val == null ? "" : String(val).trim();
      if (q.required && !val) return { error: `"${q.label}" is required` };
      if (val) out[q.key] = val;
    }
  }
  return { answers: out };
}

/* ── helpers ─────────────────────────────────────────────────────────── */

const STATUSES = ["pending", "reviewed", "shortlisted", "approved", "rejected"];
// Statuses we'll proactively email the volunteer about (when notify is set).
const EMAILABLE = ["shortlisted", "approved", "rejected"];

const fullName = (v) => `${v.firstName || ""} ${v.lastName || ""}`.trim() || "there";

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// Tenant-branded email shell so volunteer mail matches the contact-reply look.
function emailShell(orgName, inner) {
  return `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6">
      ${inner}
      <hr style="border:none;border-top:1px solid #eee;margin:18px 0"/>
      <p style="color:#888;font-size:12px">Sent by ${esc(orgName)}.</p>
    </div>`;
}

// Subject + body for each volunteer-facing email. Returns null when a status
// has no template (so we simply don't email).
function volunteerEmail(kind, { orgName, volunteer }) {
  const name = esc(volunteer.firstName || "there");
  switch (kind) {
    case "confirmation":
      return {
        subject: `We received your volunteer application — ${orgName}`,
        html: emailShell(
          orgName,
          `<p>Hi ${name},</p>
           <p>Thank you for offering to volunteer with <strong>${esc(orgName)}</strong>. We've received your
           application and our team will review it shortly. We'll be in touch with the next steps.</p>
           <p>With gratitude,<br/>The ${esc(orgName)} team</p>`
        ),
      };
    case "shortlisted":
      return {
        subject: `You've been shortlisted — ${orgName}`,
        html: emailShell(
          orgName,
          `<p>Hi ${name},</p>
           <p>Good news — you've been <strong>shortlisted</strong> to volunteer with ${esc(orgName)}.
           A member of our team will reach out soon with what happens next.</p>`
        ),
      };
    case "approved":
      return {
        subject: `Welcome aboard — your volunteer application was approved`,
        html: emailShell(
          orgName,
          `<p>Hi ${name},</p>
           <p>We're delighted to let you know your application to volunteer with
           <strong>${esc(orgName)}</strong> has been <strong>approved</strong>. Welcome to the team!
           We'll follow up with details about upcoming opportunities.</p>`
        ),
      };
    case "rejected":
      return {
        subject: `An update on your volunteer application`,
        html: emailShell(
          orgName,
          `<p>Hi ${name},</p>
           <p>Thank you for your interest in volunteering with ${esc(orgName)} and for the time you put
           into your application. After careful review we're unable to move forward at this time, but we'd
           love for you to apply again in the future.</p>`
        ),
      };
    default:
      return null;
  }
}

// Fire-and-log: never let an email failure break the request flow.
async function tryEmail(to, tmpl, organisation) {
  if (!to || !tmpl) return { success: false };
  try {
    return await sendEmail(to, tmpl.html, tmpl.subject, [], {
      org: organisation,
      fromName: organisation?.name,
      replyTo: organisation?.contactEmail || undefined,
    });
  } catch (err) {
    console.error("Volunteer email failed:", err.message);
    return { success: false };
  }
}

function buildStats(rows) {
  const stats = { total: rows.length, pending: 0, reviewed: 0, shortlisted: 0, approved: 0, rejected: 0 };
  for (const r of rows) stats[r.status || "pending"] = (stats[r.status || "pending"] || 0) + 1;
  return stats;
}

/* ── public: website volunteer form submission ───────────────────────── */

exports.createJoin = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    // Validate any custom-question answers against the org's current form.
    const questions = orgId
      ? (await Organisation.findById(orgId).select("volunteerQuestions").lean())?.volunteerQuestions || []
      : [];
    const { answers, error } = cleanAnswers(questions, req.body.answers);
    if (error) return res.status(400).json({ error });

    const join = await Join.create({
      ...req.body,
      answers,
      organisationId: orgId,
      status: "pending",
      source: req.body.source || "website",
    });

    // Surface the new application to any connected admins immediately.
    emitToOrg(join.organisationId, "volunteer:new", { volunteer: join });

    // Best-effort confirmation email to the applicant.
    tryEmail(
      join.email,
      volunteerEmail("confirmation", {
        orgName: req.organisation?.name || "our team",
        volunteer: join,
      }),
      req.organisation
    );

    res.status(201).json(join);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

/* ── admin: list (server-side search/filter/sort/paginate + stats) ───── */

exports.getAllJoin = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    const base = {};
    if (orgId) base.organisationId = orgId;

    const {
      q = "",
      status = "all",
      gender = "all",
      assignedTo = "all",
      from,
      to,
      sortBy = "createdAt",
      sortOrder = "desc",
      page = 1,
      limit = 12,
    } = req.query;

    const filter = { ...base };
    if (status !== "all" && STATUSES.includes(status)) filter.status = status;
    if (gender !== "all") filter.gender = gender;
    if (assignedTo === "unassigned") filter.assignedTo = null;
    else if (assignedTo !== "all" && mongoose.Types.ObjectId.isValid(assignedTo))
      filter.assignedTo = assignedTo;

    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    const term = String(q).trim();
    if (term) {
      const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { firstName: rx },
        { lastName: rx },
        { email: rx },
        { phoneNumber: rx },
        { skills: rx },
      ];
    }

    const sortableFields = ["createdAt", "firstName", "lastName", "status", "age"];
    const sortField = sortableFields.includes(sortBy) ? sortBy : "createdAt";
    const sort = { [sortField]: sortOrder === "asc" ? 1 : -1 };

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(limit, 10) || 12));

    const [items, total, allForStats] = await Promise.all([
      Join.find(filter)
        .sort(sort)
        .skip((pageNum - 1) * perPage)
        .limit(perPage)
        .populate("assignedTo", "name email profileImage")
        .populate("notes.author", "name email profileImage")
        .populate("assignments.event", "title date status")
        .lean(),
      Join.countDocuments(filter),
      // Stat cards reflect the whole org, not the current filter.
      Join.find(base).select("status").lean(),
    ]);

    res.status(200).json({
      items,
      total,
      page: pageNum,
      pages: Math.ceil(total / perPage) || 1,
      limit: perPage,
      stats: buildStats(allForStats),
    });
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

// Status breakdown for the whole org — drives stat cards + the sidebar badge.
exports.getStats = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    const base = {};
    if (orgId) base.organisationId = orgId;
    const rows = await Join.find(base).select("status").lean();
    res.status(200).json(buildStats(rows));
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

// Full filtered set (no pagination) for CSV export.
exports.exportJoins = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    const filter = {};
    if (orgId) filter.organisationId = orgId;
    if (req.query.status && req.query.status !== "all" && STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    const rows = await Join.find(filter)
      .sort({ createdAt: -1 })
      .populate("assignedTo", "name email")
      .lean();
    res.status(200).json(rows);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

// Team members for the assignment dropdown.
exports.getTeam = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    const filter = { role: { $in: ["admin", "superadmin"] } };
    if (orgId) filter.organisationId = orgId;
    const team = await User.find(filter)
      .select("name email profileImage role")
      .sort({ name: 1 })
      .lean();
    res.status(200).json(team);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

// Single volunteer, fully populated (drives the profile page).
exports.getJoinById = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    const filter = { _id: req.params.id };
    if (orgId) filter.organisationId = orgId;
    const join = await Join.findOne(filter)
      .populate("assignedTo", "name email profileImage")
      .populate("notes.author", "name email profileImage")
      .populate("assignments.event", "title date status location")
      .lean();
    if (!join) return res.status(404).json({ error: "Application not found" });
    res.status(200).json(join);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

/* ── custom application form (per-tenant questions) ──────────────────── */

// Public: the questions the website volunteer form should render.
exports.getForm = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    if (!orgId) return res.status(200).json({ questions: [] });
    const org = await Organisation.findById(orgId).select("volunteerQuestions").lean();
    res.status(200).json({ questions: org?.volunteerQuestions || [] });
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

// Admin: replace the org's volunteer questions (keys derived from labels).
exports.saveForm = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    if (!orgId) return res.status(400).json({ error: "No organisation context" });

    const incoming = Array.isArray(req.body.questions) ? req.body.questions : [];
    const used = new Set();
    const cleaned = [];
    for (const q of incoming) {
      const label = String(q.label || "").trim();
      if (!label) continue;
      const type = QUESTION_TYPES.includes(q.type) ? q.type : "text";
      let key = slugify(label) || "q";
      const base = key;
      let n = 2;
      while (used.has(key)) key = `${base}_${n++}`;
      used.add(key);
      const options =
        type === "select" || type === "checkbox"
          ? (Array.isArray(q.options) ? q.options : []).map((o) => String(o).trim()).filter(Boolean)
          : [];
      cleaned.push({ key, label, type, required: !!q.required, options, help: String(q.help || "").trim() });
    }

    const org = await Organisation.findByIdAndUpdate(
      orgId,
      { volunteerQuestions: cleaned },
      { new: true }
    )
      .select("volunteerQuestions")
      .lean();
    res.status(200).json({ questions: org?.volunteerQuestions || [] });
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

/* ── helper: load + populate one volunteer scoped to the org ─────────── */

async function findScoped(id, orgId) {
  const filter = { _id: id };
  if (orgId) filter.organisationId = orgId;
  return Join.findOne(filter);
}
async function populated(id) {
  return Join.findById(id)
    .populate("assignedTo", "name email profileImage")
    .populate("notes.author", "name email profileImage")
    .populate("assignments.event", "title date status")
    .lean();
}

/* ── admin: status workflow (with optional applicant email) ──────────── */

exports.updateJoinStatus = async (req, res) => {
  try {
    const { status, notify } = req.body;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status" });

    const orgId = req.organisation?._id || null;
    const join = await findScoped(req.params.id, orgId);
    if (!join) return res.status(404).json({ error: "Application not found" });

    const changed = join.status !== status;
    join.status = status;
    if (changed) join.statusHistory.push({ status, at: new Date(), by: req.user?._id });
    await join.save();

    // Notify the applicant when asked and the status has a template.
    let emailed = false;
    if (notify && EMAILABLE.includes(status)) {
      const result = await tryEmail(
        join.email,
        volunteerEmail(status, { orgName: req.organisation?.name || "our team", volunteer: join }),
        req.organisation
      );
      emailed = !!result?.success;
    }

    const out = await populated(join._id);
    emitToOrg(orgId, "volunteer:updated", { volunteer: out });
    res.status(200).json({ ...out, emailed });
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

/* ── admin: assignment ───────────────────────────────────────────────── */

exports.assignJoin = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    const { assignedTo } = req.body; // user id, or null/"" to unassign

    let assigneeId = null;
    if (assignedTo) {
      if (!mongoose.Types.ObjectId.isValid(assignedTo))
        return res.status(400).json({ error: "Invalid assignee" });
      const mf = { _id: assignedTo, role: { $in: ["admin", "superadmin"] } };
      if (orgId) mf.organisationId = orgId;
      const member = await User.findOne(mf).select("_id");
      if (!member) return res.status(400).json({ error: "Assignee is not a team member" });
      assigneeId = member._id;
    }

    const join = await findScoped(req.params.id, orgId);
    if (!join) return res.status(404).json({ error: "Application not found" });
    join.assignedTo = assigneeId;
    await join.save();

    const out = await populated(join._id);
    emitToOrg(orgId, "volunteer:updated", { volunteer: out });
    res.status(200).json(out);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

/* ── admin: internal notes ───────────────────────────────────────────── */

exports.addNote = async (req, res) => {
  try {
    const body = String(req.body.body || "").trim();
    if (!body) return res.status(400).json({ error: "Note body is required" });

    const orgId = req.organisation?._id || null;
    const join = await findScoped(req.params.id, orgId);
    if (!join) return res.status(404).json({ error: "Application not found" });

    join.notes.push({ body, author: req.user?._id, createdAt: new Date() });
    await join.save();

    const out = await populated(join._id);
    emitToOrg(orgId, "volunteer:updated", { volunteer: out });
    res.status(201).json(out);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

exports.deleteNote = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    const join = await findScoped(req.params.id, orgId);
    if (!join) return res.status(404).json({ error: "Application not found" });

    const note = join.notes.id(req.params.noteId);
    if (!note) return res.status(404).json({ error: "Note not found" });
    note.deleteOne();
    await join.save();

    const out = await populated(join._id);
    emitToOrg(orgId, "volunteer:updated", { volunteer: out });
    res.status(200).json(out);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

/* ── admin: event assignments (volunteer ↔ events) ───────────────────── */

exports.linkEvent = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    const { eventId, role = "", status = "assigned", hours = 0 } = req.body;
    if (!mongoose.Types.ObjectId.isValid(eventId))
      return res.status(400).json({ error: "Invalid event" });

    const ef = { _id: eventId };
    if (orgId) ef.organisationId = orgId;
    const event = await Event.findOne(ef).select("_id organisationId");
    if (!event) return res.status(400).json({ error: "Event not found" });

    const join = await findScoped(req.params.id, orgId);
    if (!join) return res.status(404).json({ error: "Application not found" });

    if (join.assignments.some((a) => String(a.event) === String(eventId)))
      return res.status(409).json({ error: "Volunteer is already linked to this event" });

    const safeStatus = ["assigned", "confirmed", "attended", "no-show"].includes(status) ? status : "assigned";
    const attended = safeStatus === "attended";
    const email = String(join.email || "").toLowerCase().trim();

    // Canonical EventRegistration (Option A). Reuse one if the volunteer has
    // already RSVP'd publicly for this event (the (eventId,email) index is unique).
    let reg = email ? await EventRegistration.findOne({ eventId: event._id, email }) : null;
    if (reg) {
      let dirty = false;
      if (!reg.volunteerId) {
        reg.volunteerId = join._id;
        dirty = true;
      }
      if (attended && !reg.attended) {
        reg.attended = true;
        reg.attendanceMarkedAt = new Date();
        dirty = true;
      }
      if (dirty) await reg.save();
    } else {
      reg = await EventRegistration.create({
        organisationId: event.organisationId || orgId,
        eventId: event._id,
        name: fullName(join),
        email: join.email,
        phone: join.phoneNumber || "",
        rsvpStatus: "registered",
        source: "volunteer",
        volunteerId: join._id,
        attended,
        attendanceMarkedAt: attended ? new Date() : null,
      });
      await Event.updateOne({ _id: event._id }, { $inc: { registrationCount: 1 } });
    }

    join.assignments.push({
      event: event._id,
      registrationId: reg._id,
      role,
      status: safeStatus,
      hours: Math.max(0, Number(hours) || 0),
      addedBy: req.user?._id,
      addedAt: new Date(),
    });
    await join.save();

    const out = await populated(join._id);
    emitToOrg(orgId, "volunteer:updated", { volunteer: out });
    res.status(201).json(out);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

exports.updateAssignment = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    const join = await findScoped(req.params.id, orgId);
    if (!join) return res.status(404).json({ error: "Application not found" });

    const a = join.assignments.id(req.params.assignmentId);
    if (!a) return res.status(404).json({ error: "Assignment not found" });

    const { status, hours, role } = req.body;
    let statusChanged = false;
    if (status && ["assigned", "confirmed", "attended", "no-show"].includes(status)) {
      statusChanged = a.status !== status;
      a.status = status;
    }
    if (hours !== undefined) a.hours = Math.max(0, Number(hours) || 0);
    if (role !== undefined) a.role = String(role);
    await join.save();

    // Mirror attendance onto the canonical registration so the event view agrees.
    if (statusChanged && a.registrationId) {
      const attended = a.status === "attended";
      await EventRegistration.updateOne(
        { _id: a.registrationId },
        attended
          ? { $set: { attended: true, attendanceMarkedAt: new Date() } }
          : { $set: { attended: false, attendanceMarkedAt: null } }
      );
    }

    const out = await populated(join._id);
    emitToOrg(orgId, "volunteer:updated", { volunteer: out });
    res.status(200).json(out);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

exports.unlinkEvent = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    const join = await findScoped(req.params.id, orgId);
    if (!join) return res.status(404).json({ error: "Application not found" });

    const a = join.assignments.id(req.params.assignmentId);
    if (!a) return res.status(404).json({ error: "Assignment not found" });
    const regId = a.registrationId;
    const eventId = a.event;
    a.deleteOne();
    await join.save();

    // Clean up the canonical registration we created; if it pre-existed as a
    // public/admin RSVP, just drop the volunteer tag instead of deleting it.
    if (regId) {
      const reg = await EventRegistration.findById(regId);
      if (reg) {
        if (reg.source === "volunteer") {
          const wasActive = reg.rsvpStatus !== "cancelled";
          await EventRegistration.deleteOne({ _id: reg._id });
          if (wasActive) {
            await Event.updateOne(
              { _id: eventId, registrationCount: { $gt: 0 } },
              { $inc: { registrationCount: -1 } }
            );
          }
        } else if (String(reg.volunteerId) === String(join._id)) {
          reg.volunteerId = null;
          await reg.save();
        }
      }
    }

    const out = await populated(join._id);
    emitToOrg(orgId, "volunteer:updated", { volunteer: out });
    res.status(200).json(out);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

/* ── admin: bulk actions ─────────────────────────────────────────────── */

exports.bulkUpdate = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    const { action, status } = req.body;
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).filter((id) =>
      mongoose.Types.ObjectId.isValid(id)
    );
    if (!ids.length) return res.status(400).json({ error: "No valid ids provided" });

    const filter = { _id: { $in: ids } };
    if (orgId) filter.organisationId = orgId;

    if (action === "status") {
      if (!STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status" });
      await Join.updateMany(filter, {
        $set: { status },
        $push: { statusHistory: { status, at: new Date(), by: req.user?._id } },
      });
      emitToOrg(orgId, "volunteer:bulk", { action: "status", ids, status });
      return res.status(200).json({ ok: true, modified: ids.length, status });
    }

    if (action === "delete") {
      const result = await Join.deleteMany(filter);
      emitToOrg(orgId, "volunteer:bulk", { action: "delete", ids });
      return res.status(200).json({ ok: true, deleted: result.deletedCount });
    }

    return res.status(400).json({ error: "Invalid action" });
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

/* ── admin: delete ───────────────────────────────────────────────────── */

exports.deleteJoin = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    const filter = { _id: req.params.id };
    if (orgId) filter.organisationId = orgId;
    const join = await Join.findOneAndDelete(filter);
    if (!join) return res.status(404).json({ error: "Application not found" });

    emitToOrg(orgId, "volunteer:deleted", { id: req.params.id });
    res.status(200).json({ message: "Application deleted", id: req.params.id });
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};
