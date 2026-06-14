// routes/contactRoutes.js
const express = require("express");
const router = express.Router();
const contactController = require("../controllers/contactController");
const isAdmin = require("../middleware/isAdmin");

// Public: website contact form submission.
router.post("/", contactController.createContact);

// Admin inbox (static paths first so they don't collide with "/:id/...").
router.get("/", isAdmin, contactController.getAlContact);
router.get("/team", isAdmin, contactController.getTeam);
router.get("/unread-count", isAdmin, contactController.getUnreadCount);

// Internal communication thread.
router.get("/:id/messages", isAdmin, contactController.getMessages);
router.post("/:id/messages", isAdmin, contactController.addMessage);
router.post("/:id/read", isAdmin, contactController.markRead);

// Workflow.
router.patch("/:id/assign", isAdmin, contactController.assignContact);
router.patch("/:id/status", isAdmin, contactController.updateContactStatus);
router.delete("/:id", isAdmin, contactController.deleteContact);

module.exports = router;
