// controllers/admin/eventController.js
const Event = require("../../models/event");
const { s3Client, deleteS3Object } = require("../../config/s3");

// Get all events with filtering and pagination
exports.getEvents = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = "",
      status,
      sortBy = "date",
      sortOrder = "desc",
      startDate,
      endDate,
    } = req.query;

    // Build filter conditions
    const filter = {};

    if (status && status !== "all") {
      filter.status = status;
    }

    // Date range filter
    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) filter.date.$lte = new Date(endDate);
    }

    // Search in title, description, or location
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { "location.city": { $regex: search, $options: "i" } },
        { "location.venue": { $regex: search, $options: "i" } },
      ];
    }

    // Build sort configuration
    const sortConfig = {};
    sortConfig[sortBy] = sortOrder === "asc" ? 1 : -1;

    // Execute query with pagination
    const events = await Event.find(filter)
      .sort(sortConfig)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Get total count for pagination
    const total = await Event.countDocuments(filter);

    res.json({
      events,
      pagination: {
        total,
        pages: Math.ceil(total / limit),
        currentPage: Number(page),
        perPage: Number(limit),
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch events",
      error: error.message,
    });
  }
};

// Get single event
exports.getEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({
        status: "Error",
        message: "Event not found",
      });
    }
    res.json(event);
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch event",
      error: error.message,
    });
  }
};

// Create new event with image upload
exports.createEvent = async (req, res) => {
  try {
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

    // If we have a file uploaded, use its S3 location; otherwise, use imageUrl from the body
    const imageUrl = req.file ? req.file.location : req.body.imageUrl;

    // Validate that we have an image
    if (!imageUrl) {
      return res.status(400).json({
        status: "Error",
        message: "Event image is required",
      });
    }

    const event = new Event({
      title: req.body.title,
      date: req.body.date,
      startTime: req.body.startTime,
      endTime: req.body.endTime,
      timezone: req.body.timezone,
      location,
      description: req.body.description,
      imageUrl,
      registrationLink: req.body.registrationLink,
      status: req.body.status || "upcoming",
    });

    await event.save();

    res.status(201).json({
      status: "Success",
      message: "Event created successfully",
      event,
    });
  } catch (error) {
    console.error("Event creation error:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to create event",
      error: error.message,
    });
  }
};

// Update event with image upload
exports.updateEvent = async (req, res) => {
  try {
    // Get the current event
    const currentEvent = await Event.findById(req.params.id);

    if (!currentEvent) {
      return res.status(404).json({
        status: "Error",
        message: "Event not found",
      });
    }

    // Parse the location JSON if it comes as a string
    let location = req.body.location;
    if (typeof location === "string") {
      try {
        location = JSON.parse(location);
      } catch (e) {
        console.error("Error parsing location JSON:", e);
        // Keep the existing location if parsing fails
        location = currentEvent.location;
      }
    }

    // Prepare the update data
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

    // If we have a file uploaded, use its S3 location
    if (req.file) {
      updateData.imageUrl = req.file.location;

      // Delete the old image from S3 if it exists and is from our S3 bucket
      if (
        currentEvent.imageUrl &&
        currentEvent.imageUrl.includes(process.env.S3_BUCKET_NAME)
      ) {
        try {
          // Extract the key from the S3 URL
          const key = currentEvent.imageUrl.split("/").slice(3).join("/");

          await deleteS3Object(key);

          console.log(`Deleted old image: ${key}`);
        } catch (deleteError) {
          console.error("Error deleting old image:", deleteError);
          // Continue with the update even if deleting old image fails
        }
      }
    }

    // Update the event
    const event = await Event.findByIdAndUpdate(
      req.params.id,
      { $set: updateData },
      { new: true, runValidators: true }
    );

    res.json({
      status: "Success",
      message: "Event updated successfully",
      event,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to update event",
      error: error.message,
    });
  }
};

// Delete event
exports.deleteEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);

    if (!event) {
      return res.status(404).json({
        status: "Error",
        message: "Event not found",
      });
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
        // Continue with the deletion even if deleting image fails
      }
    }

    // Delete the event
    await Event.findByIdAndDelete(req.params.id);

    res.json({
      status: "Success",
      message: "Event deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to delete event",
      error: error.message,
    });
  }
};

// Get event statistics
exports.getEventStats = async (req, res) => {
  try {
    const stats = await Event.aggregate([
      {
        $facet: {
          totalEvents: [{ $count: "count" }],
          byStatus: [
            {
              $group: {
                _id: "$status",
                count: { $sum: 1 },
              },
            },
          ],
          byCity: [
            {
              $group: {
                _id: "$location.city",
                count: { $sum: 1 },
              },
            },
          ],
          upcomingEvents: [
            {
              $match: {
                date: { $gte: new Date() },
                status: "upcoming",
              },
            },
            { $count: "count" },
          ],
        },
      },
    ]);

    const formattedStats = {
      totalEvents: stats[0].totalEvents[0]?.count || 0,
      upcomingEvents: stats[0].upcomingEvents[0]?.count || 0,
      statusDistribution: stats[0].byStatus,
      cityDistribution: stats[0].byCity.filter((city) => city._id != null),
    };

    res.json({
      status: "Success",
      stats: formattedStats,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch event statistics",
      error: error.message,
    });
  }
};
