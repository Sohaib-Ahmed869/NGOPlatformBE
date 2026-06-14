const mongoose = require("mongoose");

// An internal note left by a team member on a volunteer application.
const noteSchema = new mongoose.Schema(
  {
    body: { type: String, required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

// A link between a volunteer and an event they've been assigned to. Lets the
// volunteer record double as a lightweight participation/hours log.
const assignmentSchema = new mongoose.Schema(
  {
    event: { type: mongoose.Schema.Types.ObjectId, ref: "Event", required: true },
    // The canonical EventRegistration this assignment is backed by (Option A).
    registrationId: { type: mongoose.Schema.Types.ObjectId, ref: "EventRegistration", default: null },
    role: { type: String, default: "" }, // e.g. "Usher", "Registration desk"
    status: {
      type: String,
      enum: ["assigned", "confirmed", "attended", "no-show"],
      default: "assigned",
    },
    hours: { type: Number, default: 0, min: 0 },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

// A single step in the status workflow — kept for a lightweight audit trail.
const statusEventSchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { _id: false }
);

const joinSchema = new mongoose.Schema(
  {
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      default: null,
      index: true,
    },
    firstName: {
      type: String,
      required: true,
    },
    lastName: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
    phoneNumber: {
      type: String,
      required: true,
    },
    age: {
      type: Number,
      required: true,
    },
    gender: {
      type: String,
      required: true,
    },
    address: {
      type: String,
      required: true,
    },
    skills: {
      type: String,
      required: true,
    },
    availableDays: [
      {
        type: String,
        required: true,
      },
    ],
    status: {
      type: String,
      enum: ["pending", "reviewed", "shortlisted", "approved", "rejected"],
      default: "pending",
    },
    // Answers to the org's custom volunteerQuestions, keyed by question key.
    answers: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Where the application came from (website form today; room to grow).
    source: { type: String, default: "website" },
    // The team member responsible for shepherding this volunteer.
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Internal team notes (not visible to the volunteer).
    notes: { type: [noteSchema], default: [] },
    // Events this volunteer is helping with + their participation/hours.
    assignments: { type: [assignmentSchema], default: [] },
    // Lightweight audit of status transitions.
    statusHistory: { type: [statusEventSchema], default: [] },
  },
  {
    timestamps: true,
  }
);

joinSchema.index({ organisationId: 1, status: 1 });
joinSchema.index({ organisationId: 1, createdAt: -1 });

const Join = mongoose.model("Join", joinSchema);

module.exports = Join;
