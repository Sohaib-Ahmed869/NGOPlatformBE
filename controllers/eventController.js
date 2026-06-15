// controllers/eventController.js  (public, tenant-scoped)
const Event = require("../models/event");
const EventRegistration = require("../models/eventRegistration");
const { validateAnswers } = require("../utils/eventQuestions");
const { getTenantStripe } = require("../services/tenantStripe");
const { sendEmail } = require("../services/emailUtil");

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

// Tenant-branded "you're registered" email (best-effort; never throws).
function sendRegistrationConfirmation(org, registration, event) {
  try {
    if (!registration?.email || !event) return;
    const when = new Date(event.date).toLocaleDateString("en-AU", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
    });
    const time = [event.startTime, event.endTime].filter(Boolean).join(" – ");
    const venue = [event.location?.venue, event.location?.city].filter(Boolean).join(", ");
    const guestsLine =
      registration.numberOfGuests > 0
        ? `<p style="margin:4px 0"><strong>Guests:</strong> ${registration.numberOfGuests}</p>`
        : "";
    const paidLine =
      registration.paymentStatus === "paid"
        ? `<p style="margin:4px 0"><strong>Amount paid:</strong> $${Number(registration.amountPaid).toFixed(2)} ${registration.currency || "AUD"}</p>`
        : "";
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
        <h2 style="color:#2C2418">You're registered 🎉</h2>
        <p>Hi ${registration.name || "there"}, your spot for <strong>${event.title}</strong> is confirmed.</p>
        <div style="background:#f9f9f9;padding:15px;border-radius:6px;margin:16px 0">
          <p style="margin:4px 0"><strong>When:</strong> ${when}${time ? ` · ${time}` : ""}</p>
          ${venue ? `<p style="margin:4px 0"><strong>Where:</strong> ${venue}</p>` : ""}
          ${guestsLine}
          ${paidLine}
        </div>
        <p>We look forward to seeing you there.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
        <p style="font-size:12px;color:#888">Sent by ${org?.name || "the organisers"}.</p>
      </div>`;
    return sendEmail(registration.email, html, `You're registered — ${event.title}`, [], {
      org,
      fromName: org?.name,
      replyTo: org?.contactEmail || undefined,
    });
  } catch (e) {
    console.error("sendRegistrationConfirmation error:", e.message);
  }
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

    // Paid events must go through the Stripe flow (payment-intent → confirm).
    if (event.isPaid && event.price > 0) {
      return res
        .status(400)
        .json({ error: "This event requires payment — please register via the payment form" });
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
        sendRegistrationConfirmation(req.organisation, existing, event);
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
    sendRegistrationConfirmation(req.organisation, registration, event);

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

/* ── paid registration (internal events, in-house Stripe) ────────────────── */

// POST /events/:id/payment-intent  — validate + reserve a pending registration
// and create a PaymentIntent on the tenant's Stripe account. Returns the
// clientSecret the front-end mounts the Stripe PaymentElement with.
exports.createRegistrationPaymentIntent = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (req.organisation?._id) filter.organisationId = req.organisation._id;
    const event = await Event.findOne(filter);
    if (!event) return res.status(404).json({ error: "Event not found" });

    if (event.registrationMode !== "internal") {
      return res.status(400).json({ error: "Online registration is not available for this event" });
    }
    if (!event.isPaid || !(event.price > 0)) {
      return res.status(400).json({ error: "This event is free — no payment is required" });
    }

    const state = registrationState(event);
    if (event.status === "cancelled") return res.status(400).json({ error: "This event has been cancelled" });
    if (!event.isRegistrationOpen) return res.status(400).json({ error: "Registration is closed for this event" });
    if (state.deadlinePassed) return res.status(400).json({ error: "The registration deadline has passed" });
    if (state.isFull) return res.status(400).json({ error: "This event is at full capacity" });

    const name = (req.user?.name || req.body.name || "").trim();
    const email = (req.user?.email || req.body.email || "").toLowerCase().trim();
    const phone = req.body.phone || req.user?.phone || "";
    if (!name || !email) return res.status(400).json({ error: "Name and email are required" });

    let numberOfGuests = Number(req.body.numberOfGuests) || 0;
    if (!event.allowGuests) numberOfGuests = 0;
    else if (event.maxGuestsPerRegistration && numberOfGuests > event.maxGuestsPerRegistration) {
      return res.status(400).json({ error: `You may bring at most ${event.maxGuestsPerRegistration} guest(s)` });
    }

    const result = validateAnswers(event.registrationQuestions, req.body.answers);
    if (!result.ok) return res.status(400).json({ error: result.error });

    // Already fully paid for? block. (cancelled/pending rows can continue.)
    const existing = await EventRegistration.findOne({ eventId: event._id, email });
    if (existing && existing.rsvpStatus !== "cancelled" && existing.paymentStatus === "paid") {
      return res.status(409).json({ error: "You are already registered for this event" });
    }

    const currency = event.currency || "AUD";
    const seats = 1 + numberOfGuests;
    const amount = Math.round(event.price * seats * 100); // cents
    if (amount < 50) {
      // Stripe's minimum charge is ~A$0.50.
      return res.status(400).json({ error: "This amount is too low to process by card" });
    }

    // Reserve a pending registration carrying the answers/guests so we don't
    // have to stuff them into Stripe metadata. The headcount is only added once
    // payment succeeds (see confirmRegistrationPayment).
    const regData = {
      organisationId: event.organisationId,
      eventId: event._id,
      userId: req.user?._id || null,
      name, email, phone,
      numberOfGuests,
      answers: result.answers,
      notes: req.body.notes || "",
      rsvpStatus: "registered",
      paymentStatus: "pending",
      amountPaid: 0,
      currency,
      source: "public",
    };
    let registration;
    if (existing) {
      Object.assign(existing, regData);
      registration = await existing.save();
    } else {
      registration = await EventRegistration.create(regData);
    }

    const stripe = getTenantStripe(req.organisation);
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: currency.toLowerCase(),
      automatic_payment_methods: { enabled: true },
      metadata: {
        registrationId: String(registration._id),
        eventId: String(event._id),
        organisationId: String(event.organisationId || ""),
        paymentType: "event_registration",
        userId: req.user?._id ? String(req.user._id) : "",
      },
    });

    registration.stripePaymentIntentId = paymentIntent.id;
    await registration.save();

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      registrationId: registration._id,
      amount: amount / 100,
      currency,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: "You are already registered for this event" });
    }
    console.error("createRegistrationPaymentIntent error:", error);
    res.status(400).json({ error: error.message });
  }
};

// POST /events/:id/confirm-payment  — finalise a paid registration after the
// PaymentElement confirms. Idempotent + dedup'd on the PaymentIntent id.
exports.confirmRegistrationPayment = async (req, res) => {
  try {
    const oid = req.organisation?._id;
    const { paymentIntentId } = req.body;
    if (!paymentIntentId) return res.status(400).json({ error: "Payment reference is required" });

    const stripe = getTenantStripe(req.organisation);
    // Expand the charge so we can capture Stripe's hosted receipt URL.
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
    if (pi.status !== "succeeded") return res.status(400).json({ error: "Payment not completed" });
    if (pi.metadata?.organisationId && oid && String(pi.metadata.organisationId) !== String(oid)) {
      return res.status(400).json({ error: "Payment does not belong to this organisation" });
    }

    const regFilter = { stripePaymentIntentId: paymentIntentId };
    if (oid) regFilter.organisationId = oid;
    const registration = await EventRegistration.findOne(regFilter);
    if (!registration) return res.status(404).json({ error: "Registration not found" });

    // Stripe's hosted receipt for this charge (latest_charge is expanded above).
    const receiptUrl =
      (pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge.receipt_url : null) || "";

    // Idempotent — a retried confirm (or webhook) shouldn't double-count. Still
    // backfill the receipt URL if an earlier confirm didn't capture it.
    if (registration.paymentStatus === "paid") {
      if (receiptUrl && !registration.stripeReceiptUrl) {
        registration.stripeReceiptUrl = receiptUrl;
        await registration.save();
      }
      return res.json({ status: "Success", message: "You're registered", registration, alreadyProcessed: true });
    }

    registration.paymentStatus = "paid";
    registration.amountPaid = pi.amount / 100;
    registration.rsvpStatus = "registered";
    registration.stripeReceiptUrl = receiptUrl;
    await registration.save();

    await Event.updateOne({ _id: registration.eventId }, { $inc: { registrationCount: 1 } });

    const event = await Event.findById(registration.eventId).lean();
    sendRegistrationConfirmation(req.organisation, registration, event);

    res.json({ status: "Success", message: "You're registered", registration });
  } catch (error) {
    console.error("confirmRegistrationPayment error:", error);
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
