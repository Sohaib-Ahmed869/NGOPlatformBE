/**
 * Integration API — support tickets (Donexus: tenant → platform helpdesk).
 *
 * All tickets live in one database, so the cross-tenant queue never partially
 * fails; `meta.failed_tenants` is always [] and is returned for contract parity.
 *
 * Comment visibility:
 *   public   — the reporter, the tenant's admins and platform staff; EMAILED to the reporter
 *   tenant   — the tenant's admins and platform staff (Donexus's console "internal note")
 *   platform — platform staff only; hidden from the reporter AND the tenant's admins
 * `is_internal: true` means "platform". It is the default, so a note is never
 * emailed or shown to the customer by omission.
 */
const crypto = require("crypto");
const mongoose = require("mongoose");
const SupportTicket = require("../../models/supportTicket");
const User = require("../../models/user");
const writeAudit = require("../../utils/writeAudit");
const input = require("../../utils/operatorInput");
const { emitToOrg, emitToSuperAdmins } = require("../../services/socket");
const { sendTemplateEmail } = require("../../services/emailUtil");
const { portalOrigin } = require("../../utils/tenantUrls");
const { ServiceError } = require("../../utils/serviceError");
const { ok } = require("../../utils/integrationResponse");
const S = require("../../utils/integrationSerializers");
const { assertKnownFields, reasonFrom, requireBoolean, isObjectId } = require("./shared");

const STATUSES = ["new", "in_progress", "on_hold", "solved", "declined"];
const PRIORITIES = ["low", "medium", "high", "critical"];
const VISIBILITIES = ["public", "tenant", "platform"];

const bad = (message, field) => new ServiceError(400, "VALIDATION_ERROR", message, field ? { field } : undefined);
const notFound = (ticketId) => new ServiceError(404, "TICKET_NOT_FOUND", "No ticket with that id for this tenant", { ticket_id: ticketId });

function enumFilter(value, field, allowed) {
  const r = input.oneOf(value, field, allowed, { required: false });
  if (r.error) throw bad(r.error, field);
  return r.value;
}

/** Shared list filter from query params (status, priority, category, search). */
function listFilter(q) {
  const filter = {};
  const status = enumFilter(q.status, "status", STATUSES);
  const priority = enumFilter(q.priority, "priority", PRIORITIES);
  if (status) filter.status = status;
  if (priority) filter.priority = priority;
  if (q.category !== undefined && q.category !== "") {
    const c = S.categoryIn(input.filterValue(q.category));
    if (!c) throw bad(`category must be one of: ${S.TICKET_CATEGORIES.join(", ")}`, "category");
    filter.category = c;
  }
  if (q.assignee !== undefined && q.assignee !== "") {
    const a = input.filterValue(q.assignee);
    if (!isObjectId(a)) throw bad("assignee is not a valid user id", "assignee");
    filter["assignee.userId"] = new mongoose.Types.ObjectId(a);
  }
  const rx = input.searchRegex(q.search);
  if (rx) filter.$or = [{ summary: rx }, { "reporter.email": rx }, { "reporter.name": rx }];
  return filter;
}

/** Resolve assignee users for a page of tickets in one query. */
async function assigneesFor(tickets) {
  const ids = [...new Set(tickets.map((t) => t.assignee?.userId && String(t.assignee.userId)).filter(Boolean))];
  if (!ids.length) return {};
  const users = await User.find({ _id: { $in: ids } }).select("name email").lean();
  return Object.fromEntries(users.map((u) => [String(u._id), u]));
}

/**
 * Newest-first page of tickets. Comments are dropped server-side (the list
 * shows a count); tickets of soft-deleted tenants are left out.
 */
async function pageOfTickets(match, { page, limit, skip, includeDeletedTenants = false }) {
  const [facet] = await SupportTicket.aggregate([
    { $match: match },
    {
      $lookup: {
        from: "organisations",
        localField: "organisationId",
        foreignField: "_id",
        as: "_org",
        pipeline: [{ $project: { name: 1, slug: 1, deletedAt: 1 } }],
      },
    },
    { $match: includeDeletedTenants ? { "_org.0": { $exists: true } } : { "_org.0": { $exists: true }, "_org.deletedAt": null } },
    {
      $facet: {
        rows: [
          { $sort: { createdAt: -1, _id: -1 } },
          { $skip: skip },
          { $limit: limit },
          { $addFields: { commentCount: { $size: { $ifNull: ["$comments", []] } }, _tenant: { $arrayElemAt: ["$_org", 0] } } },
          { $project: { comments: 0, _org: 0, satisfactionToken: 0 } },
        ],
        total: [{ $count: "n" }],
      },
    },
  ]);
  const rows = facet?.rows || [];
  const total = facet?.total?.[0]?.n || 0;
  const users = await assigneesFor(rows);
  return {
    data: rows.map((t) => S.serializeTicket(t, { tenant: t._tenant, assignee: users[String(t.assignee?.userId)] })),
    meta: { page, limit, total, pages: Math.ceil(total / limit), failed_tenants: [] },
  };
}

/** GET /tickets?status=&priority=&category=&assignee=&tenant_id=&search=&page=&limit= */
exports.listAll = async (req, res) => {
  const match = listFilter(req.query);
  if (req.query.tenant_id !== undefined && req.query.tenant_id !== "") {
    const tid = input.filterValue(req.query.tenant_id);
    if (!isObjectId(tid)) throw bad("tenant_id is not a valid id", "tenant_id");
    match.organisationId = new mongoose.Types.ObjectId(tid);
  }
  const paging = input.paging(req.query, { defaultLimit: 50, maxLimit: 200 });
  const { data, meta } = await pageOfTickets(match, paging);
  ok(res, data, { meta });
};

/** GET /tenants/:id/tickets */
exports.listForTenant = async (req, res) => {
  const match = { ...listFilter(req.query), organisationId: req.tenant._id };
  const paging = input.paging(req.query, { defaultLimit: 50, maxLimit: 200 });
  const { data, meta } = await pageOfTickets(match, { ...paging, includeDeletedTenants: true });
  ok(res, data, { meta });
};

/** GET /tenants/:id/tickets/stats */
exports.stats = async (req, res) => {
  const [facet] = await SupportTicket.aggregate([
    { $match: { organisationId: req.tenant._id } },
    {
      $facet: {
        byStatus: [{ $group: { _id: "$status", n: { $sum: 1 } } }],
        byPriority: [{ $group: { _id: "$priority", n: { $sum: 1 } } }],
        unassignedOpen: [
          { $match: { status: { $in: ["new", "in_progress", "on_hold"] }, "assignee.userId": null } },
          { $count: "n" },
        ],
      },
    },
  ]);
  const by_status = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  (facet?.byStatus || []).forEach((r) => (by_status[r._id] = r.n));
  const by_priority = Object.fromEntries(PRIORITIES.map((p) => [p, 0]));
  (facet?.byPriority || []).forEach((r) => (by_priority[r._id] = r.n));
  const total = Object.values(by_status).reduce((a, b) => a + b, 0);
  ok(res, {
    tenant_id: String(req.tenant._id),
    total,
    open: by_status.new + by_status.in_progress + by_status.on_hold,
    unassigned_open: facet?.unassignedOpen?.[0]?.n || 0,
    by_status,
    by_priority,
  });
};

async function loadTicket(req) {
  const ticketId = req.params.ticketId;
  if (!isObjectId(ticketId)) throw notFound(ticketId);
  const ticket = await SupportTicket.findOne({ _id: ticketId, organisationId: req.tenant._id });
  if (!ticket) throw notFound(ticketId);
  return ticket;
}

async function ticketOut(ticket, tenant) {
  await ticket.populate("assignee.userId", "name email");
  return S.serializeTicket(ticket, { tenant, withComments: true });
}

const announce = (ticket, event = "ticket:update") => {
  emitToOrg(ticket.organisationId, event, { id: ticket._id });
  emitToSuperAdmins(event, { id: ticket._id, organisationId: ticket.organisationId });
};

/** GET /tenants/:id/tickets/:ticketId */
exports.get = async (req, res) => {
  ok(res, await ticketOut(await loadTicket(req), req.tenant));
};

function parseTicketFields(b, { creating }) {
  const out = {};
  if (creating || b.summary !== undefined) {
    const s = input.text(b.summary, "summary", { max: 300, required: creating, allowEmpty: false });
    if (s.error) throw bad(s.error, "summary");
    out.summary = s.value;
  }
  if (b.description !== undefined) {
    const d = input.text(b.description, "description", { max: 20000 });
    if (d.error) throw bad(d.error, "description");
    out.description = d.value;
  }
  if (b.priority !== undefined) out.priority = enumFilter(b.priority, "priority", PRIORITIES);
  if (b.category !== undefined) {
    const c = S.categoryIn(b.category);
    if (!c) throw bad(`category must be one of: ${S.TICKET_CATEGORIES.join(", ")}`, "category");
    out.category = c;
  }
  return out;
}

/** POST /tenants/:id/tickets  { summary, description?, priority?, category?, reporter_name?, reporter_email? } */
exports.create = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["summary", "description", "priority", "category", "reporter_name", "reporter_email", "reason"]);
  const fields = parseTicketFields(b, { creating: true });
  const org = req.tenant;

  // Reporter: the named person if given, else the tenant's owner account.
  let reporter;
  if (b.reporter_email !== undefined) {
    const email = input.text(b.reporter_email, "reporter_email", { max: 254, required: true, allowEmpty: false });
    if (email.error || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) throw bad("reporter_email must be an email address", "reporter_email");
    const name = input.text(b.reporter_name, "reporter_name", { max: 200 });
    if (name.error) throw bad(name.error, "reporter_name");
    const addr = email.value.toLowerCase();
    const user = await User.findOne({ email: addr, organisationId: org._id }).select("name email role").lean();
    reporter = {
      userId: user?._id || null,
      name: name.value || user?.name || addr.split("@")[0],
      email: addr,
      isExternal: !user,
      kind: user ? (["admin", "superadmin"].includes(user.role) ? "admin" : "customer") : "public",
    };
  } else {
    const owner = org.adminUserId ? await User.findById(org.adminUserId).select("name email").lean() : null;
    if (!owner) throw new ServiceError(409, "TENANT_HAS_NO_OWNER", "This tenant has no owner account; pass reporter_email");
    reporter = { userId: owner._id, name: owner.name || "", email: owner.email || "", isExternal: false, kind: "admin" };
  }

  const count = await SupportTicket.countDocuments({ organisationId: org._id });
  const ticket = await SupportTicket.create({
    organisationId: org._id,
    ticketNumber: count + 1,
    reporter,
    summary: fields.summary,
    description: fields.description || "",
    priority: fields.priority || "medium",
    category: fields.category || "general",
    status: "new",
  });
  await writeAudit(req, "ticket.created", {
    organisationId: org._id,
    targetType: "ticket",
    targetId: String(ticket._id),
    meta: { number: ticket.ticketNumber, summary: ticket.summary, reason: reasonFrom(b) },
  });
  announce(ticket, "ticket:new");
  ok(res, await ticketOut(ticket, org), { status: 201 });
};

/** PUT /tenants/:id/tickets/:ticketId  { summary?, description?, priority?, category? } */
exports.update = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["summary", "description", "priority", "category", "reason"]);
  const fields = parseTicketFields(b, { creating: false });
  if (!Object.keys(fields).length) throw bad("Send at least one of: summary, description, priority, category");
  const ticket = await loadTicket(req);
  const changes = {};
  for (const [k, v] of Object.entries(fields)) {
    if (ticket[k] !== v) changes[k] = { from: ticket[k], to: v };
    ticket[k] = v;
  }
  await ticket.save();
  if (Object.keys(changes).length) {
    await writeAudit(req, "ticket.updated", {
      organisationId: req.tenant._id,
      targetType: "ticket",
      targetId: String(ticket._id),
      meta: { number: ticket.ticketNumber, changes, reason: reasonFrom(b) },
    });
    announce(ticket);
  }
  ok(res, await ticketOut(ticket, req.tenant));
};

/** DELETE /tenants/:id/tickets/:ticketId — permanent (the one hard delete in this API). */
exports.remove = async (req, res) => {
  const ticket = await loadTicket(req);
  await SupportTicket.deleteOne({ _id: ticket._id });
  await writeAudit(req, "ticket.deleted", {
    organisationId: req.tenant._id,
    targetType: "ticket",
    targetId: String(ticket._id),
    meta: { number: ticket.ticketNumber, summary: ticket.summary, reporter: ticket.reporter?.email || "" },
  });
  announce(ticket);
  ok(res, { id: String(ticket._id), deleted: true });
};

/**
 * PATCH /tenants/:id/tickets/:ticketId/status
 * { status, resolution_notes?, send_satisfaction_survey? = true }
 */
exports.setStatus = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["status", "resolution_notes", "send_satisfaction_survey", "reason"]);
  const status = input.oneOf(b.status, "status", STATUSES);
  if (status.error) throw bad(status.error, "status");
  const notes = input.text(b.resolution_notes, "resolution_notes", { max: 5000 });
  if (notes.error) throw bad(notes.error, "resolution_notes");
  const sendSurvey = requireBoolean(b.send_satisfaction_survey, "send_satisfaction_survey") !== false;

  const ticket = await loadTicket(req);
  const from = ticket.status;
  ticket.status = status.value;

  let csatLink = null;
  if (status.value === "solved" || status.value === "declined") {
    ticket.resolution = {
      notes: notes.value || ticket.resolution?.notes || "",
      resolvedBy: null,
      resolvedAt: new Date(),
    };
    // Same one-time CSAT request the tenant helpdesk sends on first resolution.
    const base = portalOrigin(req.tenant);
    if (sendSurvey && ticket.reporter?.email && base && !ticket.satisfactionRequestedAt && ticket.satisfactionRating == null) {
      ticket.satisfactionToken = crypto.randomBytes(24).toString("hex");
      ticket.satisfactionRequestedAt = new Date();
      csatLink = `${base}/support/feedback/${ticket._id}?token=${ticket.satisfactionToken}`;
    }
  }
  await ticket.save();

  await writeAudit(req, "ticket.status_changed", {
    organisationId: req.tenant._id,
    targetType: "ticket",
    targetId: String(ticket._id),
    meta: { number: ticket.ticketNumber, from, to: status.value, surveySent: !!csatLink, reason: reasonFrom(b) },
  });
  announce(ticket);
  if (csatLink) {
    sendTemplateEmail("support.satisfactionSurvey", {
      to: ticket.reporter.email,
      organisationId: ticket.organisationId,
      data: {
        recipient: { name: ticket.reporter?.name || "", email: ticket.reporter.email },
        ticket: { number: ticket.ticketNumber, summary: ticket.summary || "" },
        survey: { url: csatLink },
      },
      meta: { ticketId: String(ticket._id), ticketNumber: ticket.ticketNumber, via: "integration" },
    }).catch((e) => console.error("[integration] CSAT email error:", e?.message || e));
  }
  const data = await ticketOut(ticket, req.tenant);
  data.satisfaction_survey_sent = !!csatLink;
  ok(res, data);
};

/** POST /tenants/:id/tickets/:ticketId/assign  { assignee_id | null } */
exports.assign = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["assignee_id", "reason"]);
  if (!Object.prototype.hasOwnProperty.call(b, "assignee_id")) throw bad("assignee_id is required (null to unassign)", "assignee_id");

  let assignee = null;
  if (b.assignee_id !== null && b.assignee_id !== "") {
    if (!isObjectId(b.assignee_id)) throw bad("assignee_id is not a valid id", "assignee_id");
    assignee = await User.findOne({ _id: b.assignee_id, organisationId: req.tenant._id, role: { $in: ["admin", "superadmin"] } })
      .select("name email")
      .lean();
    if (!assignee) {
      throw new ServiceError(404, "ASSIGNEE_NOT_IN_TENANT", "assignee_id must be an admin user of this tenant", { assignee_id: b.assignee_id });
    }
  }

  const ticket = await loadTicket(req);
  const from = ticket.assignee?.userId ? String(ticket.assignee.userId) : null;
  ticket.assignee = { userId: assignee?._id || null, assignedAt: assignee ? new Date() : null };
  // Status is left alone, matching the Donexus helpdesk's own assign action.
  await ticket.save();
  await writeAudit(req, "ticket.assigned", {
    organisationId: req.tenant._id,
    targetType: "ticket",
    targetId: String(ticket._id),
    meta: { number: ticket.ticketNumber, from, to: assignee ? String(assignee._id) : null, reason: reasonFrom(b) },
  });
  announce(ticket);
  ok(res, await ticketOut(ticket, req.tenant));
};

/**
 * POST /tenants/:id/tickets/:ticketId/comments
 * { message, is_internal? = true, visibility?, author_name? }
 */
exports.addComment = async (req, res) => {
  const b = req.body || {};
  assertKnownFields(b, ["message", "is_internal", "visibility", "author_name"]);
  const message = input.text(b.message, "message", { max: 10000, required: true, allowEmpty: false });
  if (message.error) throw bad(message.error, "message");
  const isInternal = requireBoolean(b.is_internal, "is_internal");
  const visibility = b.visibility !== undefined ? enumFilter(b.visibility, "visibility", VISIBILITIES) : isInternal === false ? "public" : "platform";
  if (isInternal === false && visibility !== "public") throw bad('is_internal:false conflicts with a non-public visibility', "visibility");
  if (isInternal === true && visibility === "public") throw bad("is_internal:true conflicts with visibility:public", "visibility");
  const author = input.text(b.author_name, "author_name", { max: 120 });
  if (author.error) throw bad(author.error, "author_name");
  const authorName = author.value || "Calcite Support";

  const ticket = await loadTicket(req);
  const entry = {
    message: message.value,
    createdBy: null,
    authorName,
    isInternal: visibility !== "public",
    platformOnly: visibility === "platform",
  };

  // A public reply is emailed to the reporter, exactly like the tenant helpdesk's.
  if (visibility === "public" && ticket.reporter?.email) {
    const result = await sendTemplateEmail("support.ticketReply", {
      to: ticket.reporter.email,
      organisationId: ticket.organisationId,
      data: {
        recipient: { name: ticket.reporter?.name || "", email: ticket.reporter.email },
        ticket: { number: ticket.ticketNumber, summary: ticket.summary || "", url: `${portalOrigin(req.tenant)}/admin/support/${ticket._id}` },
        message: { body: message.value },
        staff: { name: authorName },
      },
      meta: { ticketId: String(ticket._id), ticketNumber: ticket.ticketNumber, via: "integration" },
    });
    entry.emailStatus = result?.success ? "sent" : "failed";
  }

  ticket.comments.push(entry);
  if (visibility === "public") {
    if (!ticket.firstResponseAt) ticket.firstResponseAt = new Date();
    if (ticket.status === "new") ticket.status = "in_progress";
  }
  await ticket.save();
  const saved = ticket.comments[ticket.comments.length - 1];

  await writeAudit(req, "ticket.commented", {
    organisationId: req.tenant._id,
    targetType: "ticket",
    targetId: String(ticket._id),
    meta: { number: ticket.ticketNumber, commentId: String(saved._id), visibility, emailStatus: entry.emailStatus || "" },
  });
  announce(ticket);
  const data = await ticketOut(ticket, req.tenant);
  data.comment = S.serializeComment(saved);
  ok(res, data, { status: 201 });
};
