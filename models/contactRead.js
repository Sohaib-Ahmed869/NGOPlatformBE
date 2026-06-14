// Per-user read state for the contacts inbox. One row per (contact, user):
// `lastReadAt` is bumped whenever that user opens the thread or posts to it.
// A contact counts as "unread" for a user when its lastMessageAt is newer than
// that user's lastReadAt (or no row exists yet).
const mongoose = require("mongoose");

const contactReadSchema = new mongoose.Schema(
  {
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      default: null,
    },
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ContactRequest",
      required: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    lastReadAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

contactReadSchema.index({ contactId: 1, user: 1 }, { unique: true });

module.exports = mongoose.model("ContactRead", contactReadSchema);
