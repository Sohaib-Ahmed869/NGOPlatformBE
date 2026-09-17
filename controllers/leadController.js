/**
 * SuperAdmin console — Leads CRM. Validation, stage rules, emails, conversion
 * and audit live in services/leadService.js, shared with the integration API;
 * these handlers only answer in the console's `{ lead }` / `{ error }` shape.
 */
const leadService = require("../services/leadService");
const { isServiceError } = require("../utils/serviceError");

function sendLeadError(res, err, fallback) {
  if (isServiceError(err)) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(`${fallback}:`, err);
  return res.status(500).json({ error: fallback });
}

/** GET /api/superadmin/leads */
exports.list = async (req, res) => {
  try {
    const { leads, total, page, limit, pages, sort, newCount } = await leadService.listLeads(req.query);
    res.json({
      leads,
      pagination: { total, page, limit, pages },
      // Echoed back so the screen can render the arrow from what the server
      // actually did, not from what it asked for.
      sort,
      newCount,
    });
  } catch (err) {
    sendLeadError(res, err, "Failed to fetch leads");
  }
};

/** GET /api/superadmin/leads/new-count — sidebar badge driver */
exports.newCount = async (req, res) => {
  try {
    res.json({ count: await leadService.countNewLeads() });
  } catch (err) {
    sendLeadError(res, err, "Failed to fetch count");
  }
};

/** GET /api/superadmin/leads/board — grouped by pipeline stage, for the kanban view */
exports.board = async (req, res) => {
  try {
    res.json({ board: await leadService.leadBoard() });
  } catch (err) {
    sendLeadError(res, err, "Failed to fetch pipeline board");
  }
};

/** GET /api/superadmin/leads/staff — assignable operators */
exports.getStaff = async (req, res) => {
  try {
    res.json({ staff: await leadService.listStaff() });
  } catch (err) {
    sendLeadError(res, err, "Failed to fetch staff");
  }
};

/** GET /api/superadmin/leads/:id */
exports.get = async (req, res) => {
  try {
    res.json({ lead: await leadService.getLead(req.params.id) });
  } catch (err) {
    sendLeadError(res, err, "Failed to fetch lead");
  }
};

/** GET /api/superadmin/leads/options — a light list for "which lead is this about?" pickers */
exports.options = async (req, res) => {
  try {
    res.json({ leads: await leadService.leadOptions(req.query) });
  } catch (err) {
    sendLeadError(res, err, "Failed to fetch leads");
  }
};

/** POST /api/superadmin/leads — an operator adding a lead by hand */
exports.create = async (req, res) => {
  try {
    const lead = await leadService.createLead(req.body || {}, req);
    res.status(201).json({ lead });
  } catch (err) {
    sendLeadError(res, err, "Failed to create lead");
  }
};

/** PATCH /api/superadmin/leads/:id — whitelisted intake-field edits */
exports.update = async (req, res) => {
  try {
    res.json({ lead: await leadService.updateLead(req.params.id, req.body || {}, req) });
  } catch (err) {
    sendLeadError(res, err, "Failed to update lead");
  }
};

/** PATCH /api/superadmin/leads/:id/stage  { stage, lostReason?, lostReasonNote?, note? } */
exports.changeStage = async (req, res) => {
  try {
    res.json({ lead: await leadService.changeStage(req.params.id, req.body || {}, req) });
  } catch (err) {
    sendLeadError(res, err, "Failed to change stage");
  }
};

/** POST /api/superadmin/leads/:id/messages  { kind, body, mentions } */
exports.addMessage = async (req, res) => {
  try {
    const { kind, body, mentions } = req.body || {};
    const { lead, emailStatus } = await leadService.addMessage(req.params.id, { kind, body, mentions }, req);
    res.json({ lead, emailStatus });
  } catch (err) {
    sendLeadError(res, err, "Failed to add message");
  }
};

/** PATCH /api/superadmin/leads/:id/assign  { userId } */
exports.assign = async (req, res) => {
  try {
    res.json({ lead: await leadService.assignLead(req.params.id, req.body?.userId, req) });
  } catch (err) {
    sendLeadError(res, err, "Failed to assign lead");
  }
};

const CONVERT_MESSAGES = {
  activation_link_sent: "Activation link sent",
  payment_started: "Enter the card to finish this deal",
  payment_link_sent: "Payment link sent",
  converted: "Organisation created",
};

/** POST /api/superadmin/leads/:id/convert  { mode: "activation_link"|"manual_provision", ... } */
exports.convert = async (req, res) => {
  try {
    const { outcome, ...result } = await leadService.convertLead(req.params.id, req.body || {}, req);
    res.json({ message: CONVERT_MESSAGES[outcome], ...result });
  } catch (err) {
    sendLeadError(res, err, "Failed to convert lead");
  }
};

/** DELETE /api/superadmin/leads/:id */
exports.remove = async (req, res) => {
  try {
    await leadService.deleteLead(req.params.id, req);
    res.json({ message: "Deleted" });
  } catch (err) {
    sendLeadError(res, err, "Failed to delete lead");
  }
};
