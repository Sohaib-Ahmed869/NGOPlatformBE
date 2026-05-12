const express = require("express");
const router = express.Router();
const eventController = require("../controllers/eventController");
const { upload } = require("../config/s3");

// Route for creating a new event with image upload
router.post("/", upload.single("image"), eventController.createEvent);

// Route for getting all events
router.get("/", eventController.getEvents);

// Route for deleting an event
router.delete("/:id", eventController.deleteEvent);

module.exports = router;
