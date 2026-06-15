// Event Model
const mongoose = require("mongoose");

// A custom registration question defined by the admin for one event.
const questionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true }, // stable id (slug of label)
    label: { type: String, required: true },
    type: {
      type: String,
      enum: ["text", "textarea", "select", "checkbox", "number", "email", "phone"],
      default: "text",
    },
    required: { type: Boolean, default: false },
    options: [String], // for select / checkbox
    help: { type: String, default: "" },
  },
  { _id: false }
);

const eventSchema = new mongoose.Schema(
  {
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      default: null,
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    // `date` is the canonical START date/time (kept for backward compatibility).
    date: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date, // optional — set for multi-day events
    },
    startTime: {
      type: String,
      required: true,
    },
    endTime: {
      type: String,
      required: true,
    },
    timezone: {
      type: String,
      required: true,
    },
    location: {
      city: String,
      venue: String,
      address: String,
    },
    description: String,
    imageUrl: String,

    // ── Taxonomy ──────────────────────────────────────────────────────────
    eventType: {
      type: String,
      enum: [
        "fundraiser",
        "gala",
        "community",
        "awareness",
        "volunteer",
        "workshop",
        "webinar",
        "other",
      ],
      default: "other",
    },
    // When eventType is "other", the custom type name entered by the admin.
    eventTypeOther: { type: String, default: "" },

    // Who the event is for. Stores a stable `key` that references one of the
    // tenant's configured audiences (Organisation.eventAudiences) — the label &
    // colour live there so they can be edited without touching events. Empty =
    // no specific audience (rendered neutrally on the public calendar).
    audience: { type: String, default: "" },

    // ── Registration control ──────────────────────────────────────────────
    // none     → info-only event
    // external → use `registrationLink` (legacy behaviour)
    // internal → built-in RSVP captured in EventRegistration
    registrationMode: {
      type: String,
      enum: ["none", "external", "internal"],
      default: "external",
    },
    registrationLink: String, // used when registrationMode === "external"

    capacity: { type: Number, default: null }, // null = unlimited
    registrationCount: { type: Number, default: 0 }, // attendees (excl. their guests)
    requiresRegistration: { type: Boolean, default: false },
    registrationDeadline: { type: Date },
    isRegistrationOpen: { type: Boolean, default: true },
    allowGuests: { type: Boolean, default: false },
    maxGuestsPerRegistration: { type: Number, default: 0 },

    // ── Dynamic registration questions ("ask questions if any") ───────────
    registrationQuestions: { type: [questionSchema], default: [] },

    // ── Paid-ready (no payment logic yet; reuses tenant Stripe later) ──────
    isPaid: { type: Boolean, default: false },
    price: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "AUD" },

    // ── Extras ────────────────────────────────────────────────────────────
    organizer: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    contactEmail: String,
    contactPhone: String,
    attachments: [
      {
        url: { type: String, required: true },
        key: { type: String },
        name: { type: String },
      },
    ],
    featured: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ["upcoming", "ongoing", "completed", "cancelled"],
      default: "upcoming",
    },
  },
  {
    timestamps: true,
  }
);

eventSchema.index({ organisationId: 1, date: 1 });
eventSchema.index({ organisationId: 1, status: 1 });

const Event = mongoose.model("Event", eventSchema);

module.exports = Event;
