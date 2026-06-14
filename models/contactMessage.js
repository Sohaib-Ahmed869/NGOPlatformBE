// Internal communication thread for a contact request.
// A message is either a team-only "note" or a "reply" that is emailed to the
// original submitter. Both kinds live on the same timeline so the conversation
// reads as one thread in the admin inbox.
const mongoose = require("mongoose");

const contactMessageSchema = new mongoose.Schema(
  {
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      default: null,
      index: true,
    },
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ContactRequest",
      required: true,
      index: true,
    },
    // "note"  → internal, only visible to the team.
    // "reply" → also emailed to the submitter (contact.email).
    kind: {
      type: String,
      enum: ["note", "reply"],
      default: "note",
    },
    body: {
      type: String,
      required: true,
      trim: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Team members @mentioned in the body.
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    // Reply bookkeeping (null for notes).
    emailedTo: { type: String, default: null },
    emailStatus: { type: String, enum: ["sent", "failed"], default: undefined },
  },
  { timestamps: true }
);

contactMessageSchema.index({ contactId: 1, createdAt: 1 });

module.exports = mongoose.model("ContactMessage", contactMessageSchema);
