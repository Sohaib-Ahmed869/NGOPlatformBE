// controllers/eventController.js  (public, tenant-scoped)
const Event = require("../models/event");
const EventRegistration = require("../models/eventRegistration");
const { validateAnswers } = require("../utils/eventQuestions");

/* ── helpers ─────────────────────────────────────────────────────────────── */

// Derive the live registration state for an event (spots, open/closed).
function registrationState(event) {
  const cap = event.capacity;
  const count = event.registrationCount || 0;
  const spotsLeft = cap == null ? null : Math.max(0, cap - count);
  const isFull = cap != null && count >= cap;
  const deadlinePassed =
    event.registrationDeadline && new Date() > new Date(event.registrationDeadline);
  const registrationOpenNow =
    event.registrationMode === "internal" &&
    event.isRegistrationOpen &&
    event.status !== "cancelled" &&
    !isFull &&
    !deadlinePassed;
  return { spotsLeft, isFull, deadlinePassed: !!deadlinePassed, registrationOpenNow };
}

// Public-facing shape of an event (lean doc) with computed fields.
function decorate(event) {
  return { ...event, ...registrationState(event) };
}

/* ── reads ───────────────────────────────────────────────────────────────── */

// GET /events  — list this tenant's events (with computed registration state).
exports.getEvents = async (req, res) => {
  try {
    const filter = {};
    if (req.organisation?._id) filter.organisationId = req.organisation._id;

    const events = await Event.find(filter).sort({ date: 1 }).lean();
    let decorated = events.map(decorate);

    // For a logged-in user, attach their own registration (button state).
    if (req.user) {
      const regs = await EventRegistration.find({
        eventId: { $in: events.map((e) => e._id) },
        userId: req.user._id,
      })
        .select("eventId rsvpStatus")
        .lean();
      const byEvent = {};
      regs.forEach((r) => (byEvent[r.eventId.toString()] = r.rsvpStatus));
      decorated = decorated.map((e) => ({
        ...e,
        myRegistration: byEvent[e._id.toString()]
          ? { rsvpStatus: byEvent[e._id.toString()] }
          : null,
      }));
    }

    res.json(decorated);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// GET /events/:id  — single event (includes registrationQuestions for the form).
exports.getEvent = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (req.organisation?._id) filter.organisationId = req.organisation._id;
    const event = await Event.findOne(filter).lean();
    if (!event) return res.status(404).json({ error: "Event not found" });
    res.json(decorate(event));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// GET /events/:id/registration-status  — has the current user/email registered?
exports.getRegistrationStatus = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (req.organisation?._id) filter.organisationId = req.organisation._id;
    const event = await Event.findOne(filter).lean();
    if (!event) return res.status(404).json({ error: "Event not found" });

    let registration = null;
    const email = (req.user?.email || req.query.email || "").toLowerCase().trim();
    if (req.user || email) {
      const orQuery = [];
      if (req.user) orQuery.push({ userId: req.user._id });
      if (email) orQuery.push({ email });
      registration = await EventRegistration.findOne({
        eventId: event._id,
        $or: orQuery,
      })
        .select("rsvpStatus numberOfGuests attended")
        .lean();
    }

    res.json({ ...registrationState(event), registration });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

/* ── registration (internal events) ──────────────────────────────────────── */

// POST /events/:id/register  — RSVP (guests via optionalAuth allowed).
exports.registerForEvent = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (req.organisation?._id) filter.organisationId = req.organisation._id;
    const event = await Event.findOne(filter);
    if (!event) return res.status(404).json({ error: "Event not found" });

    if (event.registrationMode !== "internal") {
      return res
        .status(400)
        .json({ error: "Online registration is not available for this event" });
    }

    const state = registrationState(event);
    if (event.status === "cancelled") {
      return res.status(400).json({ error: "This event has been cancelled" });
    }
    if (!event.isRegistrationOpen) {
      return res.status(400).json({ error: "Registration is closed for this event" });
    }
    if (state.deadlinePassed) {
      return res.status(400).json({ error: "The registration deadline has passed" });
    }
    if (state.isFull) {
      return res.status(400).json({ error: "This event is at full capacity" });
    }

    // Identity — logged-in user takes precedence; otherwise guest name+email.
    const name = (req.user?.name || req.body.name || "").trim();
    const email = (req.user?.email || req.body.email || "").toLowerCase().trim();
    const phone = req.body.phone || req.user?.phone || "";

    if (!name || !email) {
      return res.status(400).json({ error: "Name and email are required" });
    }

    // Guests
    let numberOfGuests = Number(req.body.numberOfGuests) || 0;
    if (!event.allowGuests) numberOfGuests = 0;
    else if (event.maxGuestsPerRegistration && numberOfGuests > event.maxGuestsPerRegistration) {
      return res.status(400).json({
        error: `You may bring at most ${event.maxGuestsPerRegistration} guest(s)`,
      });
    }

    // Validate custom answers against the event's questions.
    const result = validateAnswers(event.registrationQuestions, req.body.answers);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    // Dedup: same user, or same email for this event.
    const orQuery = [{ email }];
    if (req.user) orQuery.push({ userId: req.user._id });
    const existing = await EventRegistration.findOne({
      eventId: event._id,
      $or: orQuery,
    });

    if (existing) {
      if (existing.rsvpStatus === "cancelled") {
        // Re-activate a previously cancelled registration.
        existing.rsvpStatus = "registered";
        existing.name = name;
        existing.phone = phone;
        existing.numberOfGuests = numberOfGuests;
        existing.answers = result.answers;
        await existing.save();
        await Event.updateOne({ _id: event._id }, { $inc: { registrationCount: 1 } });
        return res.status(200).json({
          status: "Success",
          message: "You're registered",
          registration: existing,
        });
      }
      return res
        .status(409)
        .json({ error: "You are already registered for this event" });
    }

    const registration = await EventRegistration.create({
      organisationId: event.organisationId,
      eventId: event._id,
      userId: req.user?._id || null,
      name,
      email,
      phone,
      numberOfGuests,
      answers: result.answers,
      notes: req.body.notes || "",
      rsvpStatus: "registered",
      paymentStatus: "free",
      source: "public",
    });

    await Event.updateOne({ _id: event._id }, { $inc: { registrationCount: 1 } });

    res.status(201).json({
      status: "Success",
      message: "You're registered",
      registration,
    });
  } catch (error) {
    // Duplicate key (race on the unique {eventId,email} index)
    if (error.code === 11000) {
      return res
        .status(409)
        .json({ error: "You are already registered for this event" });
    }
    console.error("Event registration error:", error);
    res.status(400).json({ error: error.message });
  }
};

// GET /events/my/registrations  — the logged-in user's registrations.
exports.getMyRegistrations = async (req, res) => {
  try {
    const filter = { userId: req.user._id };
    if (req.organisation?._id) filter.organisationId = req.organisation._id;
    const registrations = await EventRegistration.find(filter)
      .populate("eventId", "title date startTime endTime location imageUrl status")
      .sort({ createdAt: -1 })
      .lean();
    res.json(registrations);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// DELETE /events/registrations/:regId  — cancel my own registration.
exports.cancelMyRegistration = async (req, res) => {
  try {
    const reg = await EventRegistration.findOne({
      _id: req.params.regId,
      userId: req.user._id,
    });
    if (!reg) return res.status(404).json({ error: "Registration not found" });

    if (reg.rsvpStatus !== "cancelled") {
      reg.rsvpStatus = "cancelled";
      await reg.save();
      await Event.updateOne({ _id: reg.eventId }, { $inc: { registrationCount: -1 } });
    }

    res.json({ status: "Success", message: "Registration cancelled" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
