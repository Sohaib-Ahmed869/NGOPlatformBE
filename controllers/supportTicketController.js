const crypto = require("crypto");
const SupportTicket = require("../models/supportTicket");
const Organisation = require("../models/organisation");
const { emitToOrg, emitToSuperAdmins } = require("../services/socket");
const { sendEmail } = require("../services/emailUtil");

const PUBLIC_FIELDS = "-triage -kanbanStatus -triagedBy -triagedAt -triageNotes";

function orgId(req) {
  return req.organisation?._id;
}

// Best-available display name for a signed-in user: `name`, then firstName +
// lastName, then the email local-part — so a ticket never shows "Unknown".
function userDisplayName(u) {
  if (!u) return "";
  const full = `${u.firstName || ""} ${u.lastName || ""}`.trim();
  return (u.name || full || (u.email || "").split("@")[0] || "").trim();
}

// Map an uploaded file (multer-s3) to a ticket attachment subdoc.
function fileToAttachment(file) {
  return { key: file.key, name: file.originalname, size: file.size, url: file.location };
}

// Classify who a ticket is from, for the platform operator console:
//   "admin"    → the tenant's own NGO staff (admin/superadmin)
//   "customer" → a donor / end-user (customer) of the tenant
//   "public"   → an anonymous public-form submission (no signed-in user)
// Derived from the requester's actual role so it's accurate regardless of which
// endpoint they happen to hit (e.g. a logged-in donor using the public form is
// still a "customer", not "public").
function reporterKind(user) {
  if (!user) return "public";
  return ["admin", "superadmin"].includes(user.role) ? "admin" : "customer";
}

// Minimal HTML escaping for user-supplied text dropped into an email body.
function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The tenant's own front-end origin (where the public feedback page lives). The
// admin resolving the ticket is on that origin, so its Origin header is the
// most reliable base; fall back to the org website / a configured URL.
function tenantBaseUrl(req) {
  return req.headers?.origin || req.organisation?.website || process.env.FRONTEND_URL || "";
}

// Email the reporter a one-time "How did we do?" CSAT link, sent through the
// tenant's own email identity. Fire-and-forget — never blocks the response.
async function sendCsatEmail(ticket, link) {
  const name = ticket.reporter?.name || "there";
  const safeSummary = escapeHtml(ticket.summary);
  const html = `
    <p>Hi ${escapeHtml(name)},</p>
    <p>Your support request <strong>#${ticket.ticketNumber}</strong> — “${safeSummary}” — has been resolved.</p>
    <p>We'd love to know how we did. It only takes a few seconds:</p>
    <p style="margin:24px 0">
      <a href="${link}" style="background:#10b981;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Rate your support experience</a>
    </p>
    <p style="color:#888;font-size:12px">Or paste this link into your browser:<br>${link}</p>
  `;
  const text = `Hi ${name},\n\nYour support request #${ticket.ticketNumber} ("${ticket.summary}") has been resolved.\n\nWe'd love your feedback — rate your support experience here:\n${link}\n`;
  return sendEmail(ticket.reporter.email, html, `How did we do? [#${ticket.ticketNumber}] ${ticket.summary}`, [], {
    organisationId: ticket.organisationId,
    text,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Tenant admin (scoped to req.organisation)
// ──────────────────────────────────────────────────────────────────────────

exports.listTickets = async (req, res) => {
  try {
    if (!orgId(req)) return res.status(400).json({ error: "No organisation context" });
    const { status, priority, category, assignee, search } = req.query;
    const filter = { organisationId: orgId(req) };
    if (status && status !== "all") filter.status = status;
    if (priority && priority !== "all") filter.priority = priority;
    if (category && category !== "all") filter.category = category;
    if (assignee) filter["assignee.userId"] = assignee;
    if (search) {
      filter.$or = [
        { summary: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { "reporter.name": { $regex: search, $options: "i" } },
        { "reporter.email": { $regex: search, $options: "i" } },
      ];
    }
    const tickets = await SupportTicket.find(filter)
      .select(PUBLIC_FIELDS)
      .populate("assignee.userId", "name email")
      .sort({ createdAt: -1 })
      .limit(500);
    res.json({ tickets });
  } catch (err) {
    console.error("List tickets error:", err);
    res.status(500).json({ error: "Failed to fetch tickets" });
  }
};

exports.getStats = async (req, res) => {
  try {
    if (!orgId(req)) return res.status(400).json({ error: "No organisation context" });
    const rows = await SupportTicket.aggregate([
      { $match: { organisationId: orgId(req) } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const byStatus = {};
    rows.forEach((r) => (byStatus[r._id] = r.count));
    const total = rows.reduce((s, r) => s + r.count, 0);
    const open = (byStatus.new || 0) + (byStatus.in_progress || 0) + (byStatus.on_hold || 0);
    res.json({ total, open, byStatus });
  } catch (err) {
    console.error("Ticket stats error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
};

exports.getTicket = async (req, res) => {
  try {
    const ticket = await SupportTicket.findOne({ _id: req.params.id, organisationId: orgId(req) })
      .select(PUBLIC_FIELDS)
      .populate("assignee.userId", "name email")
      .populate("comments.createdBy", "name email");
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    res.json({ ticket });
  } catch (err) {
    console.error("Get ticket error:", err);
    res.status(500).json({ error: "Failed to fetch ticket" });
  }
};

exports.createTicket = async (req, res) => {
  try {
    if (!orgId(req)) return res.status(400).json({ error: "No organisation context" });
    const { summary, description, priority, category } = req.body;
    if (!summary) return res.status(400).json({ error: "Summary is required" });
    const count = await SupportTicket.countDocuments({ organisationId: orgId(req) });
    const ticket = await SupportTicket.create({
      organisationId: orgId(req),
      ticketNumber: count + 1,
      reporter: { userId: req.user._id, name: userDisplayName(req.user), email: req.user.email || "", isExternal: false, kind: reporterKind(req.user) },
      summary,
      description: description || "",
      priority: priority || "medium",
      category: category || "general",
      attachments: req.file ? [fileToAttachment(req.file)] : [],
    });
    emitToOrg(orgId(req), "ticket:new", { id: ticket._id });
    emitToSuperAdmins("ticket:new", { id: ticket._id, organisationId: orgId(req) });
    res.status(201).json({ ticket });
  } catch (err) {
    console.error("Create ticket error:", err);
    res.status(500).json({ error: "Failed to create ticket" });
  }
};

exports.updateTicket = async (req, res) => {
  try {
    const { summary, description, priority, category } = req.body;
    const update = {};
    if (summary !== undefined) update.summary = summary;
    if (description !== undefined) update.description = description;
    if (priority !== undefined) update.priority = priority;
    if (category !== undefined) update.category = category;
    const ticket = await SupportTicket.findOneAndUpdate(
      { _id: req.params.id, organisationId: orgId(req) },
      { $set: update },
      { new: true }
    ).select(PUBLIC_FIELDS);
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    emitToOrg(orgId(req), "ticket:update", { id: ticket._id });
    res.json({ ticket });
  } catch (err) {
    console.error("Update ticket error:", err);
    res.status(500).json({ error: "Failed to update ticket" });
  }
};

exports.assignTicket = async (req, res) => {
  try {
    const { userId } = req.body;
    const ticket = await SupportTicket.findOneAndUpdate(
      { _id: req.params.id, organisationId: orgId(req) },
      { $set: { "assignee.userId": userId || null, "assignee.assignedAt": userId ? new Date() : null } },
      { new: true }
    ).select(PUBLIC_FIELDS).populate("assignee.userId", "name email");
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    emitToOrg(orgId(req), "ticket:update", { id: ticket._id });
    res.json({ ticket });
  } catch (err) {
    console.error("Assign ticket error:", err);
    res.status(500).json({ error: "Failed to assign ticket" });
  }
};

exports.updateStatus = async (req, res) => {
  try {
    const { status, resolutionNotes } = req.body;
    const valid = ["new", "in_progress", "on_hold", "solved", "declined"];
    if (!valid.includes(status)) return res.status(400).json({ error: "Invalid status" });
    const ticket = await SupportTicket.findOne({ _id: req.params.id, organisationId: orgId(req) });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    ticket.status = status;
    let csatLink = null;
    if (status === "solved" || status === "declined") {
      ticket.resolution = {
        notes: resolutionNotes || ticket.resolution?.notes || "",
        resolvedBy: req.user._id,
        resolvedAt: new Date(),
      };
      // On first resolution, mint a one-time CSAT token and queue the "rate us"
      // email — but only once (requestedAt guard), only if we have a reporter
      // email and a usable front-end base, and only if they haven't already rated.
      const base = tenantBaseUrl(req);
      if (ticket.reporter?.email && base && !ticket.satisfactionRequestedAt && ticket.satisfactionRating == null) {
        ticket.satisfactionToken = crypto.randomBytes(24).toString("hex");
        ticket.satisfactionRequestedAt = new Date();
        csatLink = `${base.replace(/\/$/, "")}/support/feedback/${ticket._id}?token=${ticket.satisfactionToken}`;
      }
    }
    await ticket.save();
    emitToOrg(orgId(req), "ticket:update", { id: ticket._id });
    emitToSuperAdmins("ticket:update", { id: ticket._id, organisationId: orgId(req) });
    // Fire-and-forget: a failed CSAT email must never fail the status change.
    if (csatLink) {
      sendCsatEmail(ticket, csatLink).catch((e) => console.error("CSAT email error:", e?.message || e));
    }
    res.json({ ticket });
  } catch (err) {
    console.error("Update status error:", err);
    res.status(500).json({ error: "Failed to update status" });
  }
};

exports.addComment = async (req, res) => {
  try {
    const { message, isInternal } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required" });
    const ticket = await SupportTicket.findOne({ _id: req.params.id, organisationId: orgId(req) });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    const entry = { message, createdBy: req.user._id, authorName: userDisplayName(req.user), isInternal: !!isInternal };

    // A public reply (not an internal note) is emailed to the reporter using the
    // tenant's own email identity.
    if (!isInternal && ticket.reporter?.email) {
      const result = await sendEmail(
        ticket.reporter.email,
        message,
        `Re: [#${ticket.ticketNumber}] ${ticket.summary}`,
        [],
        { organisationId: ticket.organisationId },
      );
      entry.emailStatus = result?.success ? "sent" : "failed";
    }

    ticket.comments.push(entry);
    if (!ticket.firstResponseAt) ticket.firstResponseAt = new Date();
    if (ticket.status === "new") ticket.status = "in_progress";
    await ticket.save();
    emitToOrg(orgId(req), "ticket:update", { id: ticket._id });
    emitToSuperAdmins("ticket:update", { id: ticket._id, organisationId: orgId(req) });
    res.json({ ticket: await ticket.populate("comments.createdBy", "name email"), emailStatus: entry.emailStatus || "" });
  } catch (err) {
    console.error("Add comment error:", err);
    res.status(500).json({ error: "Failed to add comment" });
  }
};

exports.addAttachment = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const ticket = await SupportTicket.findOne({ _id: req.params.id, organisationId: orgId(req) });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    ticket.attachments.push({ key: req.file.key, name: req.file.originalname, size: req.file.size, url: req.file.location });
    await ticket.save();
    emitToOrg(orgId(req), "ticket:update", { id: ticket._id });
    res.json({ ticket });
  } catch (err) {
    console.error("Add attachment error:", err);
    res.status(500).json({ error: "Failed to attach file" });
  }
};

exports.deleteTicket = async (req, res) => {
  try {
    const ticket = await SupportTicket.findOneAndDelete({ _id: req.params.id, organisationId: orgId(req) });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    res.json({ message: "Ticket deleted" });
  } catch (err) {
    console.error("Delete ticket error:", err);
    res.status(500).json({ error: "Failed to delete ticket" });
  }
};

// ──────────────────────────────────────────────────────────────────────────
// Public (no auth; tenant resolved by middleware)
// ──────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────
// Tenant customer (logged-in donor/user) — their own tickets
// ──────────────────────────────────────────────────────────────────────────

// Customer-safe view: strip internal notes + platform-only triage fields.
function customerView(ticket) {
  const t = ticket.toObject ? ticket.toObject() : ticket;
  t.comments = (t.comments || []).filter((c) => !c.isInternal);
  ["triage", "kanbanStatus", "triagedBy", "triagedAt", "triageNotes"].forEach((k) => delete t[k]);
  return t;
}

// Match the signed-in customer's tickets by their user id OR their email — so a
// ticket raised on the PUBLIC form (no userId, email only) still shows up.
function myTicketMatch(req) {
  const email = (req.user.email || "").trim();
  const or = [{ "reporter.userId": req.user._id }];
  if (email) {
    const esc = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    or.push({ "reporter.email": new RegExp(`^${esc}$`, "i") }); // case-insensitive
  }
  return { organisationId: orgId(req), $or: or };
}

exports.listMyTickets = async (req, res) => {
  try {
    if (!orgId(req)) return res.status(400).json({ error: "No organisation context" });
    const tickets = await SupportTicket.find(myTicketMatch(req))
      .select("-comments -triage -kanbanStatus -triagedBy -triagedAt -triageNotes")
      .sort({ updatedAt: -1 })
      .limit(200);
    res.json({ tickets });
  } catch (err) {
    console.error("List my tickets error:", err);
    res.status(500).json({ error: "Failed to fetch tickets" });
  }
};

exports.createMyTicket = async (req, res) => {
  try {
    if (!orgId(req)) return res.status(400).json({ error: "No organisation context" });
    const { summary, description, category } = req.body;
    if (!summary) return res.status(400).json({ error: "A summary is required" });
    const count = await SupportTicket.countDocuments({ organisationId: orgId(req) });
    const attachments = req.file ? [fileToAttachment(req.file)] : [];
    const ticket = await SupportTicket.create({
      organisationId: orgId(req),
      ticketNumber: count + 1,
      reporter: { userId: req.user._id, name: userDisplayName(req.user), email: req.user.email || "", isExternal: false, kind: reporterKind(req.user) },
      summary,
      description: description || "",
      category: category || "general",
      status: "new",
      attachments,
    });
    emitToOrg(orgId(req), "ticket:new", { id: ticket._id });
    emitToSuperAdmins("ticket:new", { id: ticket._id, organisationId: orgId(req) });
    res.status(201).json({ ticket: customerView(ticket) });
  } catch (err) {
    console.error("Create my ticket error:", err);
    res.status(500).json({ error: "Failed to create ticket" });
  }
};

exports.getMyTicket = async (req, res) => {
  try {
    const ticket = await SupportTicket.findOne({ ...myTicketMatch(req), _id: req.params.id })
      .populate("comments.createdBy", "name");
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    res.json({ ticket: customerView(ticket) });
  } catch (err) {
    console.error("Get my ticket error:", err);
    res.status(500).json({ error: "Failed to fetch ticket" });
  }
};

exports.addMyMessage = async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required" });
    const ticket = await SupportTicket.findOne({ ...myTicketMatch(req), _id: req.params.id });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    // Claim the ticket to this account on first reply (public-form tickets have no userId yet).
    // Once claimed it's no longer anonymous — reclassify a "public" ticket by the
    // claiming account's role so the operator console reflects the real source.
    if (!ticket.reporter.userId) {
      ticket.reporter.userId = req.user._id;
      if (!ticket.reporter.kind || ticket.reporter.kind === "public") ticket.reporter.kind = reporterKind(req.user);
    }
    ticket.comments.push({ message, createdBy: req.user._id, authorName: userDisplayName(req.user), isInternal: false });
    if (["solved", "declined"].includes(ticket.status)) ticket.status = "in_progress"; // a reply re-opens it
    await ticket.save();
    emitToOrg(orgId(req), "ticket:update", { id: ticket._id });
    emitToSuperAdmins("ticket:update", { id: ticket._id, organisationId: orgId(req) });
    await ticket.populate("comments.createdBy", "name");
    res.json({ ticket: customerView(ticket) });
  } catch (err) {
    console.error("Add my message error:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
};

// Logged-in customer rates their own ticket (no token needed — ownership is
// proven by myTicketMatch). Powers the in-portal "Rate your support" prompt.
exports.mySatisfaction = async (req, res) => {
  try {
    const { rating, feedback } = req.body;
    const r = Number(rating);
    if (!(r >= 1 && r <= 5)) return res.status(400).json({ error: "Rating must be 1–5" });
    const ticket = await SupportTicket.findOne({ ...myTicketMatch(req), _id: req.params.id });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    if (ticket.satisfactionRating != null) {
      return res.json({ ticket: customerView(ticket), alreadyRated: true });
    }
    ticket.satisfactionRating = r;
    ticket.satisfactionFeedback = feedback || "";
    ticket.satisfactionRatedAt = new Date();
    await ticket.save();
    emitToOrg(orgId(req), "ticket:update", { id: ticket._id });
    emitToSuperAdmins("ticket:update", { id: ticket._id, organisationId: orgId(req) });
    res.json({ ticket: customerView(ticket) });
  } catch (err) {
    console.error("My satisfaction error:", err);
    res.status(500).json({ error: "Failed to submit feedback" });
  }
};

exports.getPublicOrg = async (req, res) => {
  try {
    const org = req.organisation;
    if (!org) return res.status(404).json({ error: "Organisation not found" });
    res.json({ name: org.name, slug: org.slug, logo: org.branding?.logoDark || org.branding?.logo || "" });
  } catch (err) {
    res.status(500).json({ error: "Failed to load" });
  }
};

exports.publicSubmit = async (req, res) => {
  try {
    if (!orgId(req)) return res.status(400).json({ error: "No organisation context" });
    const { name, email, summary, description, category } = req.body;
    if (!name || !email || !summary) {
      return res.status(400).json({ error: "Name, email and summary are required" });
    }
    if (!/\S+@\S+\.\S+/.test(email)) return res.status(400).json({ error: "Invalid email" });
    const count = await SupportTicket.countDocuments({ organisationId: orgId(req) });
    const attachments = req.file
      ? [{ key: req.file.key, name: req.file.originalname, size: req.file.size, url: req.file.location }]
      : [];
    const ticket = await SupportTicket.create({
      organisationId: orgId(req),
      ticketNumber: count + 1,
      // `optionalAuth` sets req.user when the submitter is logged in → link their
      // account so it appears in their portal; otherwise it's a true external submit.
      // A logged-in submitter is classified by their role (donor → "customer",
      // staff → "admin"); a logged-out one is "public".
      reporter: { userId: req.user?._id || null, name, email: String(email).toLowerCase().trim(), isExternal: !req.user, kind: reporterKind(req.user) },
      summary,
      description: description || "",
      category: category || "general",
      status: "new",
      attachments,
    });
    emitToOrg(orgId(req), "ticket:new", { id: ticket._id });
    emitToSuperAdmins("ticket:new", { id: ticket._id, organisationId: orgId(req) });
    res.status(201).json({ message: "Ticket submitted", ticketNumber: ticket.ticketNumber, id: ticket._id });
  } catch (err) {
    console.error("Public submit error:", err);
    res.status(500).json({ error: "Failed to submit ticket" });
  }
};

// Public CSAT page bootstrap — validates the one-time token and returns just
// enough to render the "How did we do?" page (and whether it's already rated).
exports.getPublicSatisfaction = async (req, res) => {
  try {
    const { token } = req.query;
    const ticket = await SupportTicket.findOne({ _id: req.params.id, organisationId: orgId(req) })
      .select("ticketNumber summary satisfactionRating satisfactionToken");
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    if (!ticket.satisfactionToken || !token || token !== ticket.satisfactionToken) {
      return res.status(403).json({ error: "This feedback link is invalid or has expired." });
    }
    res.json({
      ticketNumber: ticket.ticketNumber,
      summary: ticket.summary,
      alreadyRated: ticket.satisfactionRating != null,
      rating: ticket.satisfactionRating || 0,
    });
  } catch (err) {
    console.error("Get satisfaction error:", err);
    res.status(500).json({ error: "Failed to load" });
  }
};

// Public CSAT submit — gated by the one-time token from the "rate us" email so
// only the real recipient can rate, and the score can't be spoofed/overwritten.
exports.publicSatisfaction = async (req, res) => {
  try {
    const { rating, feedback, token } = req.body;
    const r = Number(rating);
    if (!(r >= 1 && r <= 5)) return res.status(400).json({ error: "Rating must be 1–5" });
    const ticket = await SupportTicket.findOne({ _id: req.params.id, organisationId: orgId(req) });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    if (!ticket.satisfactionToken || !token || token !== ticket.satisfactionToken) {
      return res.status(403).json({ error: "This feedback link is invalid or has expired." });
    }
    // One rating only — a re-submit must not overwrite an existing score.
    if (ticket.satisfactionRating != null) {
      return res.json({ message: "You've already rated this — thank you!", alreadyRated: true });
    }
    ticket.satisfactionRating = r;
    ticket.satisfactionFeedback = feedback || "";
    ticket.satisfactionRatedAt = new Date();
    await ticket.save();
    emitToOrg(ticket.organisationId, "ticket:update", { id: ticket._id });
    emitToSuperAdmins("ticket:update", { id: ticket._id, organisationId: ticket.organisationId });
    res.json({ message: "Thank you for your feedback" });
  } catch (err) {
    console.error("Satisfaction error:", err);
    res.status(500).json({ error: "Failed to submit feedback" });
  }
};

// ──────────────────────────────────────────────────────────────────────────
// Platform operator (super admin) — cross-tenant triage + kanban
// ──────────────────────────────────────────────────────────────────────────

exports.listAllTickets = async (req, res) => {
  try {
    const { tenant, triage, status, priority, kanban, source, search, limit = 200 } = req.query;
    const filter = {};
    if (tenant) filter.organisationId = tenant;
    if (triage && triage !== "all") filter.triage = triage;
    if (status && status !== "all") filter.status = status;
    if (priority && priority !== "all") filter.priority = priority;
    if (kanban && kanban !== "all") filter.kanbanStatus = kanban;
    if (source && source !== "all") filter["reporter.kind"] = source; // tenant (admin) | customer | public
    if (search) filter.summary = { $regex: search, $options: "i" };

    const tickets = await SupportTicket.find(filter)
      .populate("organisationId", "name slug")
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 200, 1000));
    res.json({ tickets });
  } catch (err) {
    console.error("List all tickets error:", err);
    res.status(500).json({ error: "Failed to fetch tickets" });
  }
};

exports.board = async (req, res) => {
  try {
    const tickets = await SupportTicket.find({ triage: { $in: ["bug", "feature"] } })
      .populate("organisationId", "name slug")
      .populate("assignee.userId", "name email profileImage")
      .sort({ updatedAt: -1 })
      .limit(1000);
    const empty = () => ({ todo: [], in_progress: [], done: [] });
    const board = { bug: empty(), feature: empty() };
    tickets.forEach((t) => {
      const lane = board[t.triage];
      if (lane && lane[t.kanbanStatus]) lane[t.kanbanStatus].push(t);
    });
    res.json({ board });
  } catch (err) {
    console.error("Board error:", err);
    res.status(500).json({ error: "Failed to fetch board" });
  }
};

// Single ticket (cross-tenant) for the operator detail page — full doc with the
// org, assignee and comment authors populated.
exports.getOne = async (req, res) => {
  try {
    const ticket = await SupportTicket.findById(req.params.id)
      .populate("organisationId", "name slug")
      .populate("assignee.userId", "name email profileImage")
      .populate("reporter.userId", "name email profileImage")
      .populate("comments.createdBy", "name email");
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    res.json({ ticket });
  } catch (err) {
    console.error("Get ticket (superadmin) error:", err);
    res.status(500).json({ error: "Failed to fetch ticket" });
  }
};

exports.triage = async (req, res) => {
  try {
    const { triage, kanbanStatus, triageNotes } = req.body;
    const update = { triagedBy: req.user._id, triagedAt: new Date() };
    if (triage !== undefined) update.triage = triage;
    if (kanbanStatus !== undefined) update.kanbanStatus = kanbanStatus;
    if (triageNotes !== undefined) update.triageNotes = triageNotes;
    const ticket = await SupportTicket.findByIdAndUpdate(req.params.id, { $set: update }, { new: true })
      .populate("organisationId", "name slug");
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    emitToSuperAdmins("ticket:update", { id: ticket._id, organisationId: ticket.organisationId?._id });
    res.json({ ticket });
  } catch (err) {
    console.error("Triage error:", err);
    res.status(500).json({ error: "Failed to triage ticket" });
  }
};

// Operator reply / internal note from the platform console (cross-tenant).
// Defaults to an INTERNAL note (visible to the tenant's team + operators, hidden
// from the external reporter); pass isInternal:false to reply to the reporter.
exports.addCommentSuper = async (req, res) => {
  try {
    const { message, isInternal } = req.body;
    if (!message || !String(message).trim()) return res.status(400).json({ error: "Message is required" });
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    const internal = isInternal !== false;
    ticket.comments.push({
      message: String(message).trim(),
      createdBy: req.user._id,
      authorName: req.user.name || "Platform Support",
      isInternal: internal,
    });
    if (!internal && !ticket.firstResponseAt) ticket.firstResponseAt = new Date();
    await ticket.save();
    emitToOrg(ticket.organisationId, "ticket:update", { id: ticket._id });
    emitToSuperAdmins("ticket:update", { id: ticket._id, organisationId: ticket.organisationId });
    const populated = await SupportTicket.findById(ticket._id)
      .populate("organisationId", "name slug")
      .populate("assignee.userId", "name email")
      .populate("comments.createdBy", "name email");
    res.json({ ticket: populated });
  } catch (err) {
    console.error("Operator comment error:", err);
    res.status(500).json({ error: "Failed to add comment" });
  }
};
