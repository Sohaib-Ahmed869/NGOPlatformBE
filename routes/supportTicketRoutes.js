const express = require("express");
const router = express.Router();
const c = require("../controllers/supportTicketController");
const isAdmin = require("../middleware/isAdmin");
const auth = require("../middleware/auth");
const optionalAuth = require("../middleware/optionalAuth");
const { ticketUpload } = require("../config/s3");

// ── Public (tenant resolved by middleware; no auth) ──
router.get("/public/org", c.getPublicOrg);
// optionalAuth: links the ticket to the submitter's account when they're logged in.
router.post("/public/submit", optionalAuth, ticketUpload.single("attachment"), c.publicSubmit);
// CSAT from the "How did we do?" email link — gated by a one-time token, not auth.
router.get("/public/satisfaction/:id", c.getPublicSatisfaction);
router.post("/public/satisfaction/:id", c.publicSatisfaction);

// ── Tenant customer (logged-in donor/user) — their own tickets.
//    Registered BEFORE the admin "/:id" routes so "/my" isn't captured as an id. ──
router.get("/my", auth, c.listMyTickets);
router.post("/my", auth, ticketUpload.single("attachment"), c.createMyTicket);
router.get("/my/:id", auth, c.getMyTicket);
router.post("/my/:id/messages", auth, c.addMyMessage);
router.post("/my/:id/satisfaction", auth, c.mySatisfaction);

// ── Tenant admin ──
router.get("/", isAdmin, c.listTickets);
router.get("/stats", isAdmin, c.getStats);
router.get("/:id", isAdmin, c.getTicket);
router.post("/", isAdmin, ticketUpload.single("attachment"), c.createTicket);
router.put("/:id", isAdmin, c.updateTicket);
router.post("/:id/assign", isAdmin, c.assignTicket);
router.patch("/:id/status", isAdmin, c.updateStatus);
router.post("/:id/comments", isAdmin, c.addComment);
router.post("/:id/attachments", isAdmin, ticketUpload.single("attachment"), c.addAttachment);
router.delete("/:id", isAdmin, c.deleteTicket);

module.exports = router;
