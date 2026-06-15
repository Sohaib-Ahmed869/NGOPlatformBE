// Event Registration Model
//
// One document per person registered (RSVP'd) for an internal event. Works for
// both logged-in donors (userId set) and guests (userId null, identified by
// email). Org-scoped like every other operational model.
const mongoose = require("mongoose");

const eventRegistrationSchema = new mongoose.Schema(
  {
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
      index: true,
    },
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      required: true,
      index: true,
    },
    // null for guest registrations
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Set when this registration was created from a volunteer assignment
    // (links back to the Join/volunteer record). Keeps the two views in sync.
    volunteerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Join",
      default: null,
      index: true,
    },

    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, default: "" },

    rsvpStatus: {
      type: String,
      enum: ["registered", "waitlisted", "cancelled"],
      default: "registered",
    },
    numberOfGuests: { type: Number, default: 0, min: 0 },

    // Answers to the event's custom registrationQuestions, keyed by question key.
    answers: { type: mongoose.Schema.Types.Mixed, default: {} },
    notes: { type: String, default: "" },

    // Attendance on the day
    attended: { type: Boolean, default: false },
    attendanceMarkedAt: { type: Date },

    // Paid events — in-house Stripe (per-tenant). Free events stay "free".
    paymentStatus: {
      type: String,
      enum: ["free", "pending", "paid", "refunded"],
      default: "free",
    },
    amountPaid: { type: Number, default: 0 },
    currency: { type: String, default: "AUD" },
    // Stripe PaymentIntent backing a paid registration (used to confirm + dedup).
    stripePaymentIntentId: { type: String, default: "" },
    // Stripe's hosted receipt URL for the charge (captured on confirm).
    stripeReceiptUrl: { type: String, default: "" },

    // Who created it
    source: { type: String, enum: ["public", "admin", "volunteer"], default: "public" },
  },
  { timestamps: true }
);

// One registration per email per event (email is always present, so this dedups
// both guests and logged-in donors). userId still lets us list "my registrations".
eventRegistrationSchema.index({ eventId: 1, email: 1 }, { unique: true });
eventRegistrationSchema.index({ organisationId: 1, eventId: 1, rsvpStatus: 1 });
eventRegistrationSchema.index({ organisationId: 1, userId: 1 });
// Fast confirm lookups; sparse so the many free/unpaid rows don't collide on "".
eventRegistrationSchema.index({ stripePaymentIntentId: 1 }, { sparse: true });

module.exports = mongoose.model("EventRegistration", eventRegistrationSchema);
