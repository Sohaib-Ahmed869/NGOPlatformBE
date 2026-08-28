const crypto = require("crypto");
const SupportTicket = require("../models/supportTicket");
const Organisation = require("../models/organisation");
const { emitToOrg, emitToSuperAdmins } = require("../services/socket");
const { sendTemplateEmail } = require("../services/emailUtil");
const operatorInput = require("../utils/operatorInput");

const PUBLIC_FIELDS = "-triage -kanbanStatus -triagedBy -triagedAt -triageNotes";

// Mirrors the enums on models/supportTicket.js. The kanban board groups tickets
// by exactly these values, so anything outside them is unreachable in the UI.
const TRIAGE_VALUES = ["unclassified", "bug", "feature", "invalid", "duplicate"];
const KANBAN_VALUES = ["todo", "in_progress", "done"];

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


// The tenant's own front-end origin (where the public feedback page lives). The
// admin resolving the ticket is on that origin, so its Origin header is the
// most reliable base; fall back to the org website / a configured URL.
function tenantBaseUrl(req) {
  return req.headers?.origin || req.organisation?.website || process.env.FRONTEND_URL || "";
}

// Email the reporter a one-time "How did we do?" CSAT link, sent through the
// tenant's own email identity. Fire-and-forget — never blocks the response.
// Wording lives in config/emailCatalog.js ("support.satisfactionSurvey").
async function sendCsatEmail(ticket, link) {
  return sendTemplateEmail("support.satisfactionSurvey", {
    to: ticket.reporter.email,
    organisationId: ticket.organisationId,
    data: {
      recipient: { name: ticket.reporter?.name || "", email: ticket.reporter.email },
      ticket: { number: ticket.ticketNumber, summary: ticket.summary || "" },
      survey: { url: link },
    },
    meta: { ticketId: String(ticket._id), ticketNumber: ticket.ticketNumber },
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
      const result = await sendTemplateEmail("support.ticketReply", {
        to: ticket.reporter.email,
        organisationId: ticket.organisationId,
        data: {
          recipient: { name: ticket.reporter?.name || "", email: ticket.reporter.email },
          ticket: {
            number: ticket.ticketNumber,
            summary: ticket.summary || "",
            url: `${tenantBaseUrl(req)}/admin/support/${ticket._id}`,
          },
          // Plain text from a textarea. The template escapes it via | nl2br —
          // it used to be interpolated straight into the HTML body unescaped.
          message: { body: message },
          staff: { name: userDisplayName(req.user) },
        },
        meta: { ticketId: String(ticket._id), ticketNumber: ticket.ticketNumber },
      });
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

// User-typed search terms are matched literally — an unescaped "(" made the
// regex throw a 500, and ".*" matched every ticket.
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

exports.listAllTickets = async (req, res) => {
  try {
    const { tenant, triage, status, priority, kanban, source, search } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
    const filter = {};
    if (tenant) filter.organisationId = tenant;
    if (triage && triage !== "all") filter.triage = triage;
    if (status && status !== "all") filter.status = status;
    if (priority && priority !== "all") filter.priority = priority;
    if (kanban && kanban !== "all") filter.kanbanStatus = kanban;
    if (source && source !== "all") filter["reporter.kind"] = source; // tenant (admin) | customer | public
    if (search) filter.summary = { $regex: escapeRegex(String(search).trim()), $options: "i" };

    const [tickets, total, statsAgg] = await Promise.all([
      // `comments` is an embedded array that can run to dozens of messages per
      // ticket and dominated the payload — the list only ever renders its
      // LENGTH, so send that instead of the whole thread.
      SupportTicket.aggregate([
        { $match: filter },
        { $sort: { createdAt: -1 } },
        { $limit: limit },
        { $addFields: { commentCount: { $size: { $ifNull: ["$comments", []] } } } },
        { $project: { comments: 0 } },
        {
          $lookup: {
            from: "organisations",
            localField: "organisationId",
            foreignField: "_id",
            as: "_org",
            pipeline: [{ $project: { name: 1, slug: 1 } }],
          },
        },
        { $addFields: { organisationId: { $arrayElemAt: ["$_org", 0] } } },
        { $project: { _org: 0 } },
      ]),
      SupportTicket.countDocuments(filter),
      // Headline figures come from the WHOLE collection, not the capped page of
      // rows above — otherwise every tile silently under-reports once the
      // platform passes the row limit.
      SupportTicket.aggregate([
        {
          $facet: {
            byStatus: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
            total: [{ $count: "n" }],
            unassigned: [
              { $match: { status: { $in: ["new", "in_progress", "on_hold"] }, "assignee.userId": { $in: [null, undefined] } } },
              { $count: "n" },
            ],
            untriaged: [
              { $match: { $or: [{ triage: { $in: [null, "unclassified"] } }, { triage: { $exists: false } }] } },
              { $count: "n" },
            ],
            csat: [
              { $match: { satisfactionRating: { $gt: 0 } } },
              { $group: { _id: null, avg: { $avg: "$satisfactionRating" }, count: { $sum: 1 } } },
            ],
          },
        },
      ]),
    ]);

    const f = statsAgg[0] || {};
    const byStatus = {};
    (f.byStatus || []).forEach((r) => { byStatus[r._id] = r.count; });
    const grandTotal = f.total?.[0]?.n || 0;

    res.json({
      tickets,
      // `total` counts everything matching the FILTER; `stats` is platform-wide
      // so the tiles and status pills stay honest whatever is being viewed.
      total,
      truncated: total > tickets.length,
      stats: {
        total: grandTotal,
        byStatus,
        open: (byStatus.new || 0) + (byStatus.in_progress || 0) + (byStatus.on_hold || 0),
        unassigned: f.unassigned?.[0]?.n || 0,
        untriaged: f.untriaged?.[0]?.n || 0,
        csat: f.csat?.[0]?.avg || 0,
        csatCount: f.csat?.[0]?.count || 0,
      },
    });
  } catch (err) {
    console.error("List all tickets error:", err);
    res.status(500).json({ error: "Failed to fetch tickets" });
  }
};

exports.board = async (req, res) => {
  try {
    // Cards show a comment COUNT, never the thread — keep the array off the wire.
    const tickets = await SupportTicket.find({ triage: { $in: ["bug", "feature"] } })
      .populate("organisationId", "name slug")
      .populate("assignee.userId", "name email profileImage")
      .sort({ updatedAt: -1 })
      .limit(1000)
      .lean()
      .then((rows) =>
        rows.map(({ comments, ...t }) => ({ ...t, commentCount: comments?.length || 0 })),
      );
    const empty = () => ({ todo: [], in_progress: [], done: [] });
    const board = { bug: empty(), feature: empty() };
    // A ticket whose kanbanStatus isn't one of the three lanes used to be
    // dropped here — present in the list, invisible on the board, and with no
    // way to drag it back. Writes are now enum-checked, but any row that
    // predates that lands in "todo" rather than disappearing.
    let recovered = 0;
    tickets.forEach((t) => {
      const lane = board[t.triage];
      if (!lane) return; // triage category genuinely not on this board
      if (lane[t.kanbanStatus]) {
        lane[t.kanbanStatus].push(t);
      } else {
        recovered++;
        lane.todo.push({ ...t, kanbanStatus: "todo", laneRecovered: true });
      }
    });
    if (recovered) console.warn(`Kanban board: ${recovered} ticket(s) had an unknown lane and were shown in "todo"`);
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
    // findByIdAndUpdate does NOT run schema validators by default, so an
    // off-enum lane was written straight through — and the board groups by
    // exactly these three keys, so the ticket disappeared from the kanban
    // screen entirely with no way to get it back from the UI.
    const update = { triagedBy: req.user._id, triagedAt: new Date() };
    if (triage !== undefined) {
      const v = operatorInput.oneOf(triage, "Triage category", TRIAGE_VALUES);
      if (v.error) return res.status(400).json({ error: v.error });
      update.triage = v.value;
    }
    if (kanbanStatus !== undefined) {
      const v = operatorInput.oneOf(kanbanStatus, "Board column", KANBAN_VALUES);
      if (v.error) return res.status(400).json({ error: v.error });
      update.kanbanStatus = v.value;
    }
    if (triageNotes !== undefined) {
      const v = operatorInput.text(triageNotes, "Triage notes", { max: 5000 });
      if (v.error) return res.status(400).json({ error: v.error });
      update.triageNotes = v.value;
    }
    const ticket = await SupportTicket.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: true }
    ).populate("organisationId", "name slug");
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
