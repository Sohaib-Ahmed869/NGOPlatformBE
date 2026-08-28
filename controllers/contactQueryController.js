const ContactQuery = require("../models/contactQuery");
const User = require("../models/user");
const { sendTemplateEmail } = require("../services/emailUtil");
const { emitToSuperAdmins } = require("../services/socket");
const input = require("../utils/operatorInput");
const { listAssignableStaff } = require("../utils/platformStaff");

const isUnread = (q) => !q.readAt || new Date(q.lastMessageAt) > new Date(q.readAt);

/** GET /api/superadmin/contact-queries */
exports.list = async (req, res) => {
  try {
    const filter = {};
    const status = input.filterValue(req.query.status);
    if (status && status !== "all") filter.status = status;
    // The term was interpolated into $regex raw: "(" threw inside Mongo and came
    // back as a 500, and ".*" matched every query in the inbox.
    const rx = input.searchRegex(req.query.search);
    if (rx) filter.$or = [{ name: rx }, { email: rx }, { subject: rx }];
    const docs = await ContactQuery.find(filter)
      .populate("assignee.userId", "name email profileImage")
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .limit(500)
      .lean();

    const queries = docs.map((q) => ({
      _id: q._id,
      name: q.name,
      email: q.email,
      subject: q.subject,
      status: q.status,
      assignee: q.assignee,
      lastMessageAt: q.lastMessageAt,
      createdAt: q.createdAt,
      unread: isUnread(q),
      replyCount: (q.thread || []).filter((t) => t.kind === "reply").length,
      noteCount: (q.thread || []).filter((t) => t.kind === "note").length,
    }));
    res.json({ queries, unreadTotal: queries.filter((q) => q.unread).length });
  } catch (err) {
    console.error("List contact queries error:", err);
    res.status(500).json({ error: "Failed to fetch contact queries" });
  }
};

/** GET /api/superadmin/contact-queries/unread-count — sidebar badge driver */
exports.unreadCount = async (req, res) => {
  try {
    const count = await ContactQuery.countDocuments({
      $or: [{ readAt: null }, { $expr: { $gt: ["$lastMessageAt", "$readAt"] } }],
    });
    res.json({ count });
  } catch (err) {
    console.error("Unread count error:", err);
    res.status(500).json({ error: "Failed to fetch unread count" });
  }
};

/** GET /api/superadmin/contact-queries/staff — assignable operators */
exports.getStaff = async (req, res) => {
  try {
    const staff = await listAssignableStaff("support");
    res.json({ staff });
  } catch (err) {
    console.error("Get staff error:", err);
    res.status(500).json({ error: "Failed to fetch staff" });
  }
};

/** GET /api/superadmin/contact-queries/:id — full thread (marks read on open) */
exports.get = async (req, res) => {
  try {
    const query = await ContactQuery.findById(req.params.id)
      .populate("assignee.userId", "name email profileImage")
      .populate("thread.author", "name email");
    if (!query) return res.status(404).json({ error: "Query not found" });

    if (isUnread(query)) {
      await ContactQuery.updateOne({ _id: query._id }, { $set: { readAt: new Date() } });
      query.readAt = new Date();
    }
    res.json({ query });
  } catch (err) {
    console.error("Get contact query error:", err);
    res.status(500).json({ error: "Failed to fetch query" });
  }
};

/**
 * POST /api/superadmin/contact-queries/:id/messages  { kind, body }
 * kind: "note" (internal) | "reply" (emailed to the submitter via the platform).
 */
exports.addMessage = async (req, res) => {
  try {
    const { kind } = req.body;
    // `body.trim()` threw a TypeError — surfacing as a 500 — for anything that
    // wasn't a string, including a number or an object from a malformed client.
    const parsed = input.text(req.body?.body, "Message", { max: 20000, required: true, allowEmpty: false });
    if (parsed.error) return res.status(400).json({ error: "Message is required" });
    const body = parsed.value;

    const query = await ContactQuery.findById(req.params.id);
    if (!query) return res.status(404).json({ error: "Query not found" });

    const entry = {
      kind: kind === "reply" ? "reply" : "note",
      body,
      author: req.user._id,
      authorName: req.user.name || req.user.email || "",
      mentions: Array.isArray(req.body.mentions) ? req.body.mentions.filter(Boolean) : [],
    };

    if (entry.kind === "reply") {
      // `body` is already sanitized rich-text HTML from the editor.
      // The typed reply is framed by the "contactQuery.reply" template — see
      // config/emailCatalog.js. `body` is already sanitized rich-text HTML.
      const result = await sendTemplateEmail("contactQuery.reply", {
        to: query.email,
        data: {
          recipient: { name: query.name || "", email: query.email },
          message: { body: entry.body, originalSubject: query.subject || "" },
          staff: { name: req.user?.name || req.user?.email || "" },
        },
        meta: { queryId: String(query._id) },
      });
      entry.emailedTo = query.email;
      entry.emailStatus = result?.success ? "sent" : "failed";
      if (query.status !== "closed") query.status = "replied";
    } else if (query.status === "new") {
      query.status = "in_progress";
    }

    query.thread.push(entry);
    query.lastMessageAt = new Date();
    query.readAt = new Date();
    await query.save();

    const populated = await ContactQuery.findById(query._id)
      .populate("assignee.userId", "name email profileImage")
      .populate("thread.author", "name email");
    emitToSuperAdmins("contactQuery:message", { id: String(query._id), status: query.status, actorSocketId: req.headers["x-socket-id"] || null });

    const last = populated.thread[populated.thread.length - 1];
    res.json({
      query: populated,
      emailStatus: last?.emailStatus || "",
    });
  } catch (err) {
    console.error("Add message error:", err);
    res.status(500).json({ error: "Failed to add message" });
  }
};

/** PATCH /api/superadmin/contact-queries/:id/status  { status } */
exports.updateStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ["new", "read", "in_progress", "replied", "closed"];
    if (!valid.includes(status)) return res.status(400).json({ error: "Invalid status" });
    const query = await ContactQuery.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true }
    ).populate("assignee.userId", "name email profileImage");
    if (!query) return res.status(404).json({ error: "Query not found" });
    emitToSuperAdmins("contactQuery:updated", { id: String(query._id), status, actorSocketId: req.headers["x-socket-id"] || null });
    res.json({ query });
  } catch (err) {
    console.error("Update status error:", err);
    res.status(500).json({ error: "Failed to update status" });
  }
};

/** PATCH /api/superadmin/contact-queries/:id/assign  { userId } */
exports.assign = async (req, res) => {
  try {
    const { userId } = req.body;
    // A malformed id reached User.findById and came back as a 500 rather than
    // "Invalid assignee".
    if (userId && !input.isObjectId(String(userId))) {
      return res.status(400).json({ error: "Invalid assignee" });
    }
    const query = await ContactQuery.findById(req.params.id);
    if (!query) return res.status(404).json({ error: "Query not found" });

    if (userId) {
      const u = await User.findById(userId).select("name email role");
      if (!u || u.role !== "superadmin") return res.status(400).json({ error: "Invalid assignee" });
      query.assignee = { userId: u._id, name: u.name || u.email, assignedAt: new Date() };
    } else {
      query.assignee = { userId: null, name: "", assignedAt: null };
    }
    await query.save();
    const populated = await ContactQuery.findById(query._id).populate("assignee.userId", "name email profileImage");
    // Carry the (populated) assignee: one row changed, and shipping the new
    // value means every other console can patch it in place instead of
    // refetching the inbox to discover a name it could have been told.
    emitToSuperAdmins("contactQuery:assigned", {
      id: String(query._id),
      assignee: populated.assignee || null,
      actorSocketId: req.headers["x-socket-id"] || null,
    });
    res.json({ query: populated });
  } catch (err) {
    console.error("Assign error:", err);
    res.status(500).json({ error: "Failed to assign" });
  }
};

/** POST /api/superadmin/contact-queries/:id/read */
exports.markRead = async (req, res) => {
  try {
    // This used to answer { ok: true } even when it matched nothing, so the
    // badge could stay stuck while the console believed it had cleared it.
    const r = await ContactQuery.updateOne({ _id: req.params.id }, { $set: { readAt: new Date() } });
    if (!r.matchedCount) return res.status(404).json({ error: "Query not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to mark read" });
  }
};

/** DELETE /api/superadmin/contact-queries/:id */
exports.remove = async (req, res) => {
  try {
    const q = await ContactQuery.findByIdAndDelete(req.params.id);
    if (!q) return res.status(404).json({ error: "Query not found" });
    emitToSuperAdmins("contactQuery:deleted", { id: String(req.params.id), actorSocketId: req.headers["x-socket-id"] || null });
    res.json({ message: "Deleted" });
  } catch (err) {
    console.error("Delete contact query error:", err);
    res.status(500).json({ error: "Failed to delete" });
  }
};
