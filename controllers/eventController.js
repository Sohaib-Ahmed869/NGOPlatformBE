// controllers/eventController.js
const Event = require("../models/event");
const { s3Client, deleteS3Object } = require("../config/s3");

// Create event with image upload
exports.createEvent = async (req, res) => {
  try {
    // The image data will be available in req.file from multer middleware
    if (!req.file) {
      return res.status(400).json({ error: "Image is required" });
    }

    // Parse the location JSON if it comes as a string
    let location = req.body.location;
    if (typeof location === "string") {
      try {
        location = JSON.parse(location);
      } catch (e) {
        console.error("Error parsing location JSON:", e);
        location = {};
      }
    }

    // Create the event with the image URL from S3
    const eventData = {
      title: req.body.title,
      date: req.body.date,
      startTime: req.body.startTime || "",
      endTime: req.body.endTime || "",
      timezone: req.body.timezone || "UTC",
      location,
      description: req.body.description || "",
      imageUrl: req.file.location, // S3 URL of the uploaded file
      registrationLink: req.body.registrationLink || "",
      status: req.body.status || "upcoming",
    };

    const event = await Event.create(eventData);
    res.status(201).json(event);
  } catch (error) {
    console.error("Event creation error:", error);
    res.status(400).json({ error: error.message });
  }
};

// Get all events
exports.getEvents = async (req, res) => {
  try {
    const events = await Event.find().sort({ date: 1 });
    res.json(events);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Get single event
exports.getEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    res.json(event);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Update event
exports.updateEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);

    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    // Parse the location JSON if it comes as a string
    let location = req.body.location;
    if (typeof location === "string") {
      try {
        location = JSON.parse(location);
      } catch (e) {
        console.error("Error parsing location JSON:", e);
        // Keep the existing location if parsing fails
        location = event.location;
      }
    }

    // Create update object
    const updateData = {
      title: req.body.title,
      date: req.body.date,
      startTime: req.body.startTime,
      endTime: req.body.endTime,
      timezone: req.body.timezone,
      location,
      description: req.body.description,
      registrationLink: req.body.registrationLink,
      status: req.body.status,
    };

    // If a new image is uploaded
    if (req.file) {
      updateData.imageUrl = req.file.location;

      // Delete old image from S3 if it exists
      if (
        event.imageUrl &&
        event.imageUrl.includes(process.env.S3_BUCKET_NAME)
      ) {
        try {
          // Extract the key from the S3 URL
          const key = event.imageUrl.split("/").slice(3).join("/");

          await deleteS3Object(key);
          console.log(`Deleted old image: ${key}`);
        } catch (deleteError) {
          console.error("Error deleting old image:", deleteError);
          // Continue with the update even if image deletion fails
        }
      }
    }

    const updatedEvent = await Event.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    res.json(updatedEvent);
  } catch (error) {
    console.error("Event update error:", error);
    res.status(400).json({ error: error.message });
  }
};

// Delete event with image
exports.deleteEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);

    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    // Delete the image from S3 if it exists and is from our S3 bucket
    if (event.imageUrl && event.imageUrl.includes(process.env.S3_BUCKET_NAME)) {
      try {
        // Extract the key from the S3 URL
        const key = event.imageUrl.split("/").slice(3).join("/");

        await deleteS3Object(key);
        console.log(`Deleted image: ${key}`);
      } catch (deleteError) {
        console.error("Error deleting image:", deleteError);
        // Continue with the deletion even if image deletion fails
      }
    }

    // Then delete the event
    await Event.findByIdAndDelete(req.params.id);

    res.json({ message: "Event deleted successfully" });
  } catch (error) {
    console.error("Event deletion error:", error);
    res.status(400).json({ error: error.message });
  }
};
