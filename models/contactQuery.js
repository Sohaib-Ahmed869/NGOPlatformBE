const mongoose = require("mongoose");

// A unified thread entry — an internal note (team-only) or a reply emailed to
// the submitter. Mirrors the tenant Contacts ContactMessage `kind`.
const threadEntrySchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["note", "reply"], default: "note" },
    body: { type: String, required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    authorName: { type: String, default: "" },
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }], // @mentions on notes
    emailedTo: { type: String, default: "" }, // recipient on a reply
    emailStatus: { type: String, enum: ["sent", "failed", ""], default: "" },
  },
  { timestamps: true }
);

const contactQuerySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    subject: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["new", "read", "in_progress", "replied", "closed"],
      default: "new",
    },
    assignee: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      name: { type: String, default: "" },
      assignedAt: { type: Date, default: null },
    },
    thread: { type: [threadEntrySchema], default: [] },
    lastMessageAt: { type: Date, default: Date.now }, // drives ordering + unread
    readAt: { type: Date, default: null },
    adminNote: { type: String, default: "" }, // legacy (pre-thread)
  },
  { timestamps: true }
);

contactQuerySchema.index({ status: 1, lastMessageAt: -1 });

module.exports = mongoose.model("ContactQuery", contactQuerySchema);
