// controllers/contactController.js
const mongoose = require("mongoose");
const ContactRequest = require("../models/contact");
const ContactMessage = require("../models/contactMessage");
const ContactRead = require("../models/contactRead");
const User = require("../models/user");
const { sendEmail } = require("../services/emailUtil");
const { emitToOrg } = require("../services/socket");

/* ── helpers ─────────────────────────────────────────────────────────── */

// Build a Map<contactId, lastReadAt> for one user across an org.
async function readMapFor(userId, orgId) {
  const filter = { user: userId };
  if (orgId) filter.organisationId = orgId;
  const reads = await ContactRead.find(filter).select("contactId lastReadAt").lean();
  return new Map(reads.map((r) => [String(r.contactId), new Date(r.lastReadAt).getTime()]));
}

const lastActivity = (c) =>
  new Date(c.lastMessageAt || c.updatedAt || c.createdAt || 0).getTime();

// Mark a contact as read "now" for a user (used when they open or post).
async function touchRead(contactId, userId, orgId) {
  await ContactRead.findOneAndUpdate(
    { contactId, user: userId },
    { $set: { lastReadAt: new Date(), organisationId: orgId || null } },
    { upsert: true, new: true }
  );
}

/* ── public: website contact form submission ─────────────────────────── */

exports.createContact = async (req, res) => {
  try {
    const contact = await ContactRequest.create({
      ...req.body,
      organisationId: req.organisation?._id || null,
      lastMessageAt: new Date(),
    });
    // Let any connected admins surface the new request immediately.
    emitToOrg(contact.organisationId, "contact:new", { contact });
    res.status(201).json(contact);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

/* ── admin: list (enriched with assignee + unread for this admin) ─────── */

exports.getAlContact = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    const filter = {};
    if (orgId) filter.organisationId = orgId;

    const contacts = await ContactRequest.find(filter)
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .populate("assignedTo", "name email profileImage")
      .lean();

    const reads = await readMapFor(req.user._id, orgId);
    const enriched = contacts.map((c) => {
      const read = reads.get(String(c._id)) || 0;
      return { ...c, unread: lastActivity(c) > read };
    });

    res.status(200).json(enriched);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

// Number of contacts with activity this admin hasn't seen — drives the badge.
exports.getUnreadCount = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    const filter = {};
    if (orgId) filter.organisationId = orgId;

    const contacts = await ContactRequest.find(filter)
      .select("lastMessageAt updatedAt createdAt")
      .lean();
    const reads = await readMapFor(req.user._id, orgId);

    let count = 0;
    for (const c of contacts) {
      const read = reads.get(String(c._id)) || 0;
      if (lastActivity(c) > read) count++;
    }
    res.status(200).json({ count });
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

// Team members (for the assignment dropdown + @mention autocomplete).
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

/* ── admin: thread messages ──────────────────────────────────────────── */

exports.getMessages = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    const filter = { _id: req.params.id };
    if (orgId) filter.organisationId = orgId;
    const contact = await ContactRequest.findOne(filter).select("_id").lean();
    if (!contact) return res.status(404).json({ error: "Contact request not found" });

    const messages = await ContactMessage.find({ contactId: req.params.id })
      .sort({ createdAt: 1 })
      .populate("author", "name email profileImage")
      .populate("mentions", "name email")
      .lean();
    res.status(200).json(messages);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

// Add a message to the thread. kind="note" → internal only; kind="reply" → also
// emailed to the submitter and moves the request to "responded".
exports.addMessage = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    const { kind = "note", body } = req.body;
    let { mentions = [] } = req.body;

    // Body is rich-text HTML — require some actual visible text, not just tags.
    const plainBody = String(body || "")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .trim();
    if (!plainBody) {
      return res.status(400).json({ error: "Message body is required" });
    }
    if (!["note", "reply"].includes(kind)) {
      return res.status(400).json({ error: "Invalid message kind" });
    }

    const filter = { _id: req.params.id };
    if (orgId) filter.organisationId = orgId;
    const contact = await ContactRequest.findOne(filter);
    if (!contact) return res.status(404).json({ error: "Contact request not found" });

    mentions = (Array.isArray(mentions) ? mentions : [])
      .filter((id) => mongoose.Types.ObjectId.isValid(id));

    const message = await ContactMessage.create({
      organisationId: orgId,
      contactId: contact._id,
      kind,
      body: String(body).trim(),
      author: req.user._id,
      mentions,
    });

    // A reply is emailed to the submitter; record the outcome on the message.
    if (kind === "reply") {
      const orgName = req.organisation?.name || "our team";
      const subject = `Re: your message to ${orgName}`;
      // `body` is already a sanitised rich-text HTML subset from the editor.
      const html = `
        <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6">
          ${body}
          <hr style="border:none;border-top:1px solid #eee;margin:18px 0"/>
          <p style="color:#888;font-size:12px">
            This is a reply from ${orgName}${contact.purpose ? ` regarding "${contact.purpose}"` : ""}.
          </p>
        </div>`;
      // Per-tenant sender identity: tenant name as the from-name and the org's
      // own contact email as reply-to, so the submitter replies to the tenant
      // (not the shared platform mailbox).
      const result = await sendEmail(contact.email, html, subject, [], {
        org: req.organisation,
        fromName: req.organisation?.name,
        replyTo: req.organisation?.contactEmail || undefined,
      });
      message.emailedTo = contact.email;
      message.emailStatus = result?.success ? "sent" : "failed";
      await message.save();
      // Replying advances the workflow.
      if (contact.status !== "responded") contact.status = "responded";
    }

    contact.lastMessageAt = new Date();
    await contact.save();

    // The author has, by definition, seen everything up to their own message.
    await touchRead(contact._id, req.user._id, orgId);

    const populated = await ContactMessage.findById(message._id)
      .populate("author", "name email profileImage")
      .populate("mentions", "name email")
      .lean();

    emitToOrg(orgId, "contact:message", {
      contactId: String(contact._id),
      message: populated,
      status: contact.status,
      lastMessageAt: contact.lastMessageAt,
    });

    res.status(201).json(populated);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

/* ── admin: assignment ───────────────────────────────────────────────── */

exports.assignContact = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    const { assignedTo } = req.body; // user id or null/"" to unassign

    let assigneeId = null;
    if (assignedTo) {
      if (!mongoose.Types.ObjectId.isValid(assignedTo)) {
        return res.status(400).json({ error: "Invalid assignee" });
      }
      const memberFilter = { _id: assignedTo, role: { $in: ["admin", "superadmin"] } };
      if (orgId) memberFilter.organisationId = orgId;
      const member = await User.findOne(memberFilter).select("_id");
      if (!member) return res.status(400).json({ error: "Assignee is not a team member" });
      assigneeId = member._id;
    }

    const filter = { _id: req.params.id };
    if (orgId) filter.organisationId = orgId;
    const contact = await ContactRequest.findOneAndUpdate(
      filter,
      { assignedTo: assigneeId },
      { new: true }
    ).populate("assignedTo", "name email profileImage");
    if (!contact) return res.status(404).json({ error: "Contact request not found" });

    emitToOrg(orgId, "contact:assigned", {
      contactId: String(contact._id),
      assignedTo: contact.assignedTo || null,
    });

    res.status(200).json(contact);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

/* ── admin: mark a thread read for the current admin ─────────────────── */

exports.markRead = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    // Only let an admin mark read a contact that belongs to their org.
    const exists = await ContactRequest.exists({
      _id: req.params.id,
      ...(orgId ? { organisationId: orgId } : {}),
    });
    if (!exists) return res.status(404).json({ error: "Contact request not found" });
    await touchRead(req.params.id, req.user._id, orgId);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

/* ── admin: workflow status ──────────────────────────────────────────── */

exports.updateContactStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!["pending", "reviewed", "responded"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const orgId = req.organisation?._id || null;
    const filter = { _id: req.params.id };
    if (orgId) filter.organisationId = orgId;
    const contact = await ContactRequest.findOneAndUpdate(filter, { status }, { new: true });
    if (!contact) return res.status(404).json({ error: "Contact request not found" });

    emitToOrg(orgId, "contact:updated", { contactId: String(contact._id), status });
    res.status(200).json(contact);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

/* ── admin: delete (with thread + read cleanup) ──────────────────────── */

exports.deleteContact = async (req, res) => {
  try {
    const orgId = req.organisation?._id || null;
    const filter = { _id: req.params.id };
    if (orgId) filter.organisationId = orgId;
    const contact = await ContactRequest.findOneAndDelete(filter);
    if (!contact) return res.status(404).json({ error: "Contact request not found" });

    await ContactMessage.deleteMany({ contactId: contact._id });
    await ContactRead.deleteMany({ contactId: contact._id });

    emitToOrg(orgId, "contact:deleted", { contactId: String(contact._id) });
    res.status(200).json({ message: "Contact request deleted", id: req.params.id });
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};
