// routes/admin/event.routes.js
const express = require("express");
const router = express.Router();
const eventController = require("../../controllers/admin/eventController");
const isAdmin = require("../../middleware/isAdmin");
const { upload } = require("../../config/s3");

// Stats
router.get("/stats", isAdmin, eventController.getEventStats);

// ── Registration management (per event) ──
router.get("/:id/registrations/export", isAdmin, eventController.exportRegistrations);
router.get("/:id/registrations", isAdmin, eventController.getEventRegistrations);
router.post("/:id/registrations", isAdmin, eventController.createRegistration);
router.patch("/:id/registrations/:regId", isAdmin, eventController.updateRegistration);
router.delete("/:id/registrations/:regId", isAdmin, eventController.deleteRegistration);

// ── Event CRUD ──
router.get("/", isAdmin, eventController.getEvents);
router.get("/:id", isAdmin, eventController.getEvent);

// Image is optional, but multer still parses multipart/form-data bodies.
router.post("/", isAdmin, upload.single("image"), eventController.createEvent);
router.put("/:id", isAdmin, upload.single("image"), eventController.updateEvent);
router.delete("/:id", isAdmin, eventController.deleteEvent);

module.exports = router;
