const ContactQuery = require("../models/contactQuery");
const User = require("../models/user");
const { sendEmail } = require("../services/emailUtil");
const { emitToSuperAdmins } = require("../services/socket");

const isUnread = (q) => !q.readAt || new Date(q.lastMessageAt) > new Date(q.readAt);

/** GET /api/superadmin/contact-queries */
exports.list = async (req, res) => {
  try {
    const { status, search } = req.query;
    const filter = {};
    if (status && status !== "all") filter.status = status;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { subject: { $regex: search, $options: "i" } },
      ];
    }
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
    const staff = await User.find({ role: "superadmin" }).select("name email").sort({ name: 1 });
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
    const { kind, body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: "Message is required" });
    const query = await ContactQuery.findById(req.params.id);
    if (!query) return res.status(404).json({ error: "Query not found" });

    const entry = {
      kind: kind === "reply" ? "reply" : "note",
      body: body.trim(),
      author: req.user._id,
      authorName: req.user.name || req.user.email || "",
      mentions: Array.isArray(req.body.mentions) ? req.body.mentions.filter(Boolean) : [],
    };

    if (entry.kind === "reply") {
      // `body` is already sanitized rich-text HTML from the editor.
      const result = await sendEmail(query.email, entry.body, `Re: ${query.subject}`);
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
    emitToSuperAdmins("contactQuery:message", { id: String(query._id), status: query.status });

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
    emitToSuperAdmins("contactQuery:updated", { id: String(query._id), status });
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
    emitToSuperAdmins("contactQuery:assigned", { id: String(query._id) });
    res.json({ query: populated });
  } catch (err) {
    console.error("Assign error:", err);
    res.status(500).json({ error: "Failed to assign" });
  }
};

/** POST /api/superadmin/contact-queries/:id/read */
exports.markRead = async (req, res) => {
  try {
    await ContactQuery.updateOne({ _id: req.params.id }, { $set: { readAt: new Date() } });
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
    emitToSuperAdmins("contactQuery:deleted", { id: String(req.params.id) });
    res.json({ message: "Deleted" });
  } catch (err) {
    console.error("Delete contact query error:", err);
    res.status(500).json({ error: "Failed to delete" });
  }
};
