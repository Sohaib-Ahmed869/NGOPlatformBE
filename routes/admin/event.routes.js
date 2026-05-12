// routes/admin/event.routes.js
const express = require("express");
const router = express.Router();
const eventController = require("../../controllers/admin/eventController");
const isAdmin = require("../../middleware/isAdmin");
const { upload } = require('../../config/s3');

// Get event statistics
router.get("/stats", isAdmin, eventController.getEventStats);

// CRUD operations
router.get("/", isAdmin, eventController.getEvents);
router.get("/:id", isAdmin, eventController.getEvent);

// Create with image upload
router.post("/", isAdmin, upload.single('image'), eventController.createEvent);

// Update with optional image upload
router.put("/:id", isAdmin, upload.single('image'), eventController.updateEvent);

// Delete
router.delete("/:id", isAdmin, eventController.deleteEvent);

module.exports = router;