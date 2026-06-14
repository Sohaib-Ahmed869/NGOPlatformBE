const express = require("express");
const router = express.Router();
const joinController = require("../controllers/joinTeamController");
const isAdmin = require("../middleware/isAdmin");

// ── Public: website volunteer application form ──
router.post("/", joinController.createJoin);
router.get("/form", joinController.getForm); // public: questions to render

// ── Admin: collection reads (static paths before any ":id" routes) ──
router.get("/", isAdmin, joinController.getAllJoin);
router.get("/stats", isAdmin, joinController.getStats);
router.get("/export", isAdmin, joinController.exportJoins);
router.get("/team", isAdmin, joinController.getTeam);
router.put("/form", isAdmin, joinController.saveForm); // admin: edit questions
router.patch("/bulk", isAdmin, joinController.bulkUpdate);

// Single application (after the static GET routes so they take precedence).
router.get("/:id", isAdmin, joinController.getJoinById);

// ── Admin: per-application management ──
router.patch("/:id/status", isAdmin, joinController.updateJoinStatus);
router.patch("/:id/assign", isAdmin, joinController.assignJoin);

router.post("/:id/notes", isAdmin, joinController.addNote);
router.delete("/:id/notes/:noteId", isAdmin, joinController.deleteNote);

router.post("/:id/events", isAdmin, joinController.linkEvent);
router.patch("/:id/events/:assignmentId", isAdmin, joinController.updateAssignment);
router.delete("/:id/events/:assignmentId", isAdmin, joinController.unlinkEvent);

router.delete("/:id", isAdmin, joinController.deleteJoin);

module.exports = router;
