// controllers/admin/eventController.js
const mongoose = require("mongoose");
const Event = require("../../models/event");
const EventRegistration = require("../../models/eventRegistration");
const Join = require("../../models/join");
const { deleteS3Object } = require("../../config/s3");
const { normalizeQuestions } = require("../../utils/eventQuestions");

/* ── helpers ─────────────────────────────────────────────────────────────── */

// Parse a field that may arrive as a JSON string (multipart form) or already
// be an object/array. Falls back to `fallback` on bad input.
function parseMaybeJson(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

const toBool = (v) => v === true || v === "true" || v === "on" || v === 1 || v === "1";
const toNumOrNull = (v) =>
  v === undefined || v === null || v === "" ? null : Number(v);

// Build the event fields shared by create & update from the request body.
function buildEventFields(body, currentLocation) {
  const fields = {};

  if (body.title !== undefined) fields.title = body.title;
  if (body.date !== undefined) fields.date = body.date;
  if (body.endDate !== undefined) fields.endDate = body.endDate || null;
  if (body.startTime !== undefined) fields.startTime = body.startTime;
  if (body.endTime !== undefined) fields.endTime = body.endTime;
  if (body.timezone !== undefined) fields.timezone = body.timezone;
  if (body.description !== undefined) fields.description = body.description;
  if (body.status !== undefined) fields.status = body.status;
  if (body.registrationLink !== undefined) fields.registrationLink = body.registrationLink;

  if (body.location !== undefined) {
    fields.location = parseMaybeJson(body.location, currentLocation || {});
  }

  // Taxonomy
  if (body.eventType !== undefined) fields.eventType = body.eventType;
  if (body.eventTypeOther !== undefined) {
    fields.eventTypeOther = body.eventType === "other" ? body.eventTypeOther : "";
  }
  if (body.audience !== undefined) fields.audience = (body.audience || "").trim();

  // Registration control
  if (body.registrationMode !== undefined) fields.registrationMode = body.registrationMode;
  if (body.capacity !== undefined) fields.capacity = toNumOrNull(body.capacity);
  if (body.requiresRegistration !== undefined)
    fields.requiresRegistration = toBool(body.requiresRegistration);
  if (body.registrationDeadline !== undefined)
    fields.registrationDeadline = body.registrationDeadline || null;
  if (body.isRegistrationOpen !== undefined)
    fields.isRegistrationOpen = toBool(body.isRegistrationOpen);
  if (body.allowGuests !== undefined) fields.allowGuests = toBool(body.allowGuests);
  if (body.maxGuestsPerRegistration !== undefined)
    fields.maxGuestsPerRegistration = Number(body.maxGuestsPerRegistration) || 0;

  // Dynamic questions
  if (body.registrationQuestions !== undefined)
    fields.registrationQuestions = normalizeQuestions(body.registrationQuestions);

  // Paid-ready
  if (body.isPaid !== undefined) fields.isPaid = toBool(body.isPaid);
  if (body.price !== undefined) fields.price = Number(body.price) || 0;
  if (body.currency !== undefined) fields.currency = body.currency;

  // Extras
  if (body.organizer !== undefined) fields.organizer = body.organizer || null;
  if (body.contactEmail !== undefined) fields.contactEmail = body.contactEmail;
  if (body.contactPhone !== undefined) fields.contactPhone = body.contactPhone;
  if (body.featured !== undefined) fields.featured = toBool(body.featured);
  if (body.attachments !== undefined)
    fields.attachments = parseMaybeJson(body.attachments, []);

  return fields;
}

// Validate cross-field rules. Returns an error string or null.
function validateEventFields(f) {
  if (f.eventType === "other" && !String(f.eventTypeOther || "").trim()) {
    return 'Please specify the event type when selecting "Other".';
  }
  if (f.registrationMode === "external" && f.registrationLink !== undefined && !String(f.registrationLink || "").trim()) {
    return "An external registration link is required for external registration.";
  }
  return null;
}

/* ── events CRUD ─────────────────────────────────────────────────────────── */

// Get all events with filtering and pagination
exports.getEvents = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = "",
      status,
      eventType,
      registrationMode,
      sortBy = "date",
      sortOrder = "desc",
      startDate,
      endDate,
    } = req.query;

    const filter = {};
    if (req.organisation?._id) filter.organisationId = req.organisation._id;

    if (status && status !== "all") filter.status = status;
    if (eventType && eventType !== "all") filter.eventType = eventType;
    if (registrationMode && registrationMode !== "all")
      filter.registrationMode = registrationMode;

    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) filter.date.$lte = new Date(endDate);
    }

    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { "location.city": { $regex: search, $options: "i" } },
        { "location.venue": { $regex: search, $options: "i" } },
      ];
    }

    const sortConfig = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

    const events = await Event.find(filter)
      .sort(sortConfig)
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();

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
    const eventQuery = { _id: req.params.id };
    if (req.organisation?._id) eventQuery.organisationId = req.organisation._id;
    const event = await Event.findOne(eventQuery);
    if (!event) {
      return res.status(404).json({ status: "Error", message: "Event not found" });
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

// Create new event (image optional)
exports.createEvent = async (req, res) => {
  try {
    const fields = buildEventFields(req.body, {});

    const validationError = validateEventFields(fields);
    if (validationError) {
      return res.status(400).json({ status: "Error", message: validationError });
    }

    // Image is optional. Prefer an uploaded file, else a provided URL.
    const imageUrl = req.file ? req.file.location : req.body.imageUrl;

    const event = new Event({
      organisationId: req.organisation?._id || null,
      ...fields,
      imageUrl: imageUrl || "",
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

// Update event (optional image upload)
exports.updateEvent = async (req, res) => {
  try {
    const eventUpdateQuery = { _id: req.params.id };
    if (req.organisation?._id) eventUpdateQuery.organisationId = req.organisation._id;
    const currentEvent = await Event.findOne(eventUpdateQuery);

    if (!currentEvent) {
      return res.status(404).json({ status: "Error", message: "Event not found" });
    }

    const updateData = buildEventFields(req.body, currentEvent.location);

    // Merge with current values for cross-field validation.
    const validationError = validateEventFields({
      eventType: updateData.eventType ?? currentEvent.eventType,
      eventTypeOther: updateData.eventTypeOther ?? currentEvent.eventTypeOther,
      registrationMode: updateData.registrationMode ?? currentEvent.registrationMode,
      registrationLink: updateData.registrationLink,
    });
    if (validationError) {
      return res.status(400).json({ status: "Error", message: validationError });
    }

    // New image uploaded → swap and clean up the old S3 object.
    if (req.file) {
      updateData.imageUrl = req.file.location;
      if (
        currentEvent.imageUrl &&
        currentEvent.imageUrl.includes(process.env.S3_BUCKET_NAME)
      ) {
        try {
          const key = currentEvent.imageUrl.split("/").slice(3).join("/");
          await deleteS3Object(key);
        } catch (deleteError) {
          console.error("Error deleting old image:", deleteError);
        }
      }
    }

    const event = await Event.findOneAndUpdate(
      eventUpdateQuery,
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

// Delete event (and its registrations)
exports.deleteEvent = async (req, res) => {
  try {
    const eventDelQuery = { _id: req.params.id };
    if (req.organisation?._id) eventDelQuery.organisationId = req.organisation._id;
    const event = await Event.findOne(eventDelQuery);

    if (!event) {
      return res.status(404).json({ status: "Error", message: "Event not found" });
    }

    if (event.imageUrl && event.imageUrl.includes(process.env.S3_BUCKET_NAME)) {
      try {
        const key = event.imageUrl.split("/").slice(3).join("/");
        await deleteS3Object(key);
      } catch (deleteError) {
        console.error("Error deleting image:", deleteError);
      }
    }

    await EventRegistration.deleteMany({ eventId: event._id });
    await Event.findOneAndDelete(eventDelQuery);

    res.json({ status: "Success", message: "Event deleted successfully" });
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
    const match = {};
    if (req.organisation?._id) match.organisationId = req.organisation._id;

    const stats = await Event.aggregate([
      { $match: match },
      {
        $facet: {
          totalEvents: [{ $count: "count" }],
          byStatus: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
          byType: [{ $group: { _id: "$eventType", count: { $sum: 1 } } }],
          byCity: [{ $group: { _id: "$location.city", count: { $sum: 1 } } }],
          upcomingEvents: [
            { $match: { date: { $gte: new Date() }, status: "upcoming" } },
            { $count: "count" },
          ],
          totalRegistrations: [
            { $group: { _id: null, count: { $sum: "$registrationCount" } } },
          ],
        },
      },
    ]);

    res.json({
      status: "Success",
      stats: {
        totalEvents: stats[0].totalEvents[0]?.count || 0,
        upcomingEvents: stats[0].upcomingEvents[0]?.count || 0,
        totalRegistrations: stats[0].totalRegistrations[0]?.count || 0,
        statusDistribution: stats[0].byStatus,
        typeDistribution: stats[0].byType.filter((t) => t._id != null),
        cityDistribution: stats[0].byCity.filter((c) => c._id != null),
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch event statistics",
      error: error.message,
    });
  }
};

/* ── registration management ─────────────────────────────────────────────── */

// Confirm an event belongs to this org; returns the event or null.
async function findOrgEvent(req) {
  const q = { _id: req.params.id };
  if (req.organisation?._id) q.organisationId = req.organisation._id;
  return Event.findOne(q);
}

// GET /admin/events/:id/registrations
exports.getEventRegistrations = async (req, res) => {
  try {
    const event = await findOrgEvent(req);
    if (!event) {
      return res.status(404).json({ status: "Error", message: "Event not found" });
    }

    const { rsvpStatus, attended, search = "" } = req.query;
    const filter = { eventId: event._id };
    if (req.organisation?._id) filter.organisationId = req.organisation._id;
    if (rsvpStatus && rsvpStatus !== "all") filter.rsvpStatus = rsvpStatus;
    if (attended === "true") filter.attended = true;
    if (attended === "false") filter.attended = false;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    const registrations = await EventRegistration.find(filter)
      .populate("userId", "name firstName lastName email")
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      status: "Success",
      event: {
        _id: event._id,
        title: event.title,
        capacity: event.capacity,
        registrationCount: event.registrationCount,
        registrationQuestions: event.registrationQuestions,
      },
      registrations,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch registrations",
      error: error.message,
    });
  }
};

// GET /admin/events/payments/list
// Cross-event list of paid event registrations (the "Event Payments" dashboard).
// Always excludes free RSVPs (paymentStatus: "free"); supports search by
// registrant, status/event/date filters, sorting and pagination, plus summary
// stats (collected / paid / pending / refunded) over the whole filtered set.
exports.getEventPayments = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = "",
      paymentStatus,
      eventId,
      startDate,
      endDate,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const filter = { paymentStatus: { $ne: "free" } };
    if (req.organisation?._id) filter.organisationId = req.organisation._id;
    if (paymentStatus && paymentStatus !== "all") filter.paymentStatus = paymentStatus;
    if (eventId && eventId !== "all" && mongoose.Types.ObjectId.isValid(eventId)) {
      filter.eventId = new mongoose.Types.ObjectId(eventId);
    }
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const perPage = Math.max(1, Math.min(1000, parseInt(limit, 10) || 10));
    const sortDir = sortOrder === "asc" ? 1 : -1;
    const allowedSort = ["createdAt", "amountPaid", "name", "paymentStatus"];
    const sortField = allowedSort.includes(sortBy) ? sortBy : "createdAt";

    const [rows, total, statsAgg] = await Promise.all([
      EventRegistration.find(filter)
        .populate("eventId", "title date price currency isPaid")
        .sort({ [sortField]: sortDir })
        .skip((pageNum - 1) * perPage)
        .limit(perPage)
        .lean(),
      EventRegistration.countDocuments(filter),
      EventRegistration.aggregate([
        { $match: filter },
        { $group: { _id: "$paymentStatus", count: { $sum: 1 }, amount: { $sum: "$amountPaid" } } },
      ]),
    ]);

    const stats = { paidCount: 0, pendingCount: 0, refundedCount: 0, totalCollected: 0, currency: "AUD" };
    statsAgg.forEach((g) => {
      if (g._id === "paid") {
        stats.paidCount = g.count;
        stats.totalCollected = g.amount || 0;
      } else if (g._id === "pending") stats.pendingCount = g.count;
      else if (g._id === "refunded") stats.refundedCount = g.count;
    });
    if (rows[0]?.currency) stats.currency = rows[0].currency;

    const payments = rows.map((p) => ({
      _id: p._id,
      name: p.name,
      email: p.email,
      phone: p.phone,
      numberOfGuests: p.numberOfGuests,
      amountPaid: p.amountPaid,
      currency: p.currency,
      paymentStatus: p.paymentStatus,
      stripePaymentIntentId: p.stripePaymentIntentId,
      stripeReceiptUrl: p.stripeReceiptUrl,
      rsvpStatus: p.rsvpStatus,
      attended: p.attended,
      answers: p.answers,
      source: p.source,
      createdAt: p.createdAt,
      event: p.eventId
        ? {
            _id: p.eventId._id,
            title: p.eventId.title,
            date: p.eventId.date,
            price: p.eventId.price,
            currency: p.eventId.currency,
            isPaid: p.eventId.isPaid,
          }
        : null,
    }));

    res.json({
      status: "Success",
      data: {
        payments,
        pagination: { total, pages: Math.ceil(total / perPage), currentPage: pageNum, perPage },
        stats,
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch event payments",
      error: error.message,
    });
  }
};

// POST /admin/events/:id/registrations  — admin adds an attendee manually
exports.createRegistration = async (req, res) => {
  try {
    const event = await findOrgEvent(req);
    if (!event) {
      return res.status(404).json({ status: "Error", message: "Event not found" });
    }

    const { name, email, phone = "", numberOfGuests = 0, answers = {}, notes = "" } = req.body;
    if (!name || !email) {
      return res
        .status(400)
        .json({ status: "Error", message: "Name and email are required" });
    }

    const existing = await EventRegistration.findOne({
      eventId: event._id,
      email: String(email).toLowerCase().trim(),
    });
    if (existing) {
      return res
        .status(409)
        .json({ status: "Error", message: "This email is already registered" });
    }

    const registration = await EventRegistration.create({
      organisationId: event.organisationId,
      eventId: event._id,
      name,
      email,
      phone,
      numberOfGuests: Number(numberOfGuests) || 0,
      answers: answers && typeof answers === "object" ? answers : {},
      notes,
      rsvpStatus: "registered",
      source: "admin",
    });

    await Event.updateOne({ _id: event._id }, { $inc: { registrationCount: 1 } });

    res.status(201).json({
      status: "Success",
      message: "Registration added",
      registration,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to add registration",
      error: error.message,
    });
  }
};

// PATCH /admin/events/:id/registrations/:regId  — attendance / status / notes
exports.updateRegistration = async (req, res) => {
  try {
    const event = await findOrgEvent(req);
    if (!event) {
      return res.status(404).json({ status: "Error", message: "Event not found" });
    }

    const reg = await EventRegistration.findOne({
      _id: req.params.regId,
      eventId: event._id,
    });
    if (!reg) {
      return res.status(404).json({ status: "Error", message: "Registration not found" });
    }

    const wasActive = reg.rsvpStatus !== "cancelled";

    if (req.body.attended !== undefined) {
      reg.attended = toBool(req.body.attended);
      reg.attendanceMarkedAt = reg.attended ? new Date() : null;
    }
    if (req.body.rsvpStatus !== undefined) reg.rsvpStatus = req.body.rsvpStatus;
    if (req.body.notes !== undefined) reg.notes = req.body.notes;
    if (req.body.numberOfGuests !== undefined)
      reg.numberOfGuests = Number(req.body.numberOfGuests) || 0;

    await reg.save();

    // Keep the event's registrationCount in sync when active⇄cancelled flips.
    const isActive = reg.rsvpStatus !== "cancelled";
    if (wasActive && !isActive) {
      await Event.updateOne({ _id: event._id }, { $inc: { registrationCount: -1 } });
    } else if (!wasActive && isActive) {
      await Event.updateOne({ _id: event._id }, { $inc: { registrationCount: 1 } });
    }

    // Reverse sync: if this registration is backed by a volunteer assignment,
    // mirror the attendance change onto that assignment's status.
    if (reg.volunteerId && req.body.attended !== undefined) {
      await Join.updateOne(
        { _id: reg.volunteerId, "assignments.registrationId": reg._id },
        { $set: { "assignments.$.status": reg.attended ? "attended" : "assigned" } }
      );
    }

    res.json({ status: "Success", message: "Registration updated", registration: reg });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to update registration",
      error: error.message,
    });
  }
};

// DELETE /admin/events/:id/registrations/:regId
exports.deleteRegistration = async (req, res) => {
  try {
    const event = await findOrgEvent(req);
    if (!event) {
      return res.status(404).json({ status: "Error", message: "Event not found" });
    }

    const reg = await EventRegistration.findOne({
      _id: req.params.regId,
      eventId: event._id,
    });
    if (!reg) {
      return res.status(404).json({ status: "Error", message: "Registration not found" });
    }

    const wasActive = reg.rsvpStatus !== "cancelled";
    await EventRegistration.deleteOne({ _id: reg._id });
    if (wasActive) {
      await Event.updateOne({ _id: event._id }, { $inc: { registrationCount: -1 } });
    }

    // Reverse sync: detach the volunteer assignment that pointed at this reg.
    if (reg.volunteerId) {
      await Join.updateOne(
        { _id: reg.volunteerId },
        { $pull: { assignments: { registrationId: reg._id } } }
      );
    }

    res.json({ status: "Success", message: "Registration removed" });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to remove registration",
      error: error.message,
    });
  }
};

// GET /admin/events/:id/registrations/export  — CSV download
exports.exportRegistrations = async (req, res) => {
  try {
    const event = await findOrgEvent(req);
    if (!event) {
      return res.status(404).json({ status: "Error", message: "Event not found" });
    }

    const regs = await EventRegistration.find({ eventId: event._id })
      .sort({ createdAt: 1 })
      .lean();

    const questions = event.registrationQuestions || [];
    const headers = [
      "Name",
      "Email",
      "Phone",
      "RSVP",
      "Guests",
      "Attended",
      "Registered At",
      ...questions.map((q) => q.label),
    ];

    const esc = (v) => {
      const s = v === undefined || v === null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const rows = regs.map((r) => {
      const base = [
        r.name,
        r.email,
        r.phone,
        r.rsvpStatus,
        r.numberOfGuests,
        r.attended ? "Yes" : "No",
        new Date(r.createdAt).toISOString(),
      ];
      const answers = questions.map((q) => {
        const a = (r.answers || {})[q.key];
        return Array.isArray(a) ? a.join("; ") : a;
      });
      return [...base, ...answers].map(esc).join(",");
    });

    const csv = [headers.map(esc).join(","), ...rows].join("\n");
    const filename = `registrations-${event._id}.csv`;

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to export registrations",
      error: error.message,
    });
  }
};
