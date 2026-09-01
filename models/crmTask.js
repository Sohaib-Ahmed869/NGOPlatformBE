const mongoose = require("mongoose");

/**
 * A unit of sales/CRM work an operator owes someone: call this lead back, send
 * the proposal, chase the signature.
 *
 * Deliberately NOT a sub-document of Lead. Three of the four things the console
 * needs to ask are cross-lead questions — "what do I owe today", "what is
 * overdue", "what is on this operator's plate" — and none of them can be
 * answered by an array nested inside a document you would first have to find.
 * As its own collection each of those is one indexed query.
 *
 * A task does not have to belong to a lead. `lead` is optional so the same
 * screen carries standalone work ("renew the ABN", "write the Q3 pricing memo")
 * rather than forcing an operator into a second tool for it — which is the
 * usual reason a CRM's task list quietly stops being used.
 */

/** An operator's comment on a task. Internal by definition — a task is never customer-facing. */
const taskCommentSchema = new mongoose.Schema(
  {
    body: { type: String, required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    authorName: { type: String, default: "" },
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

/**
 * A checklist step. Keeps its own `_id` (unlike stageHistory) because the API
 * toggles and removes individual steps, and position is not a stable handle —
 * two operators reordering at once would otherwise tick each other's items.
 */
const checklistItemSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true },
    done: { type: Boolean, default: false },
    doneAt: { type: Date, default: null },
    doneBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

/**
 * Append-only record of what happened to the task. Mirrors Lead.stageHistory:
 * the console shows it as the task's own timeline, and unlike the platform audit
 * log it is scoped tightly enough to render inline.
 */
const taskEventSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ["created", "status", "assigned", "due", "priority", "checklist", "comment", "edited"],
      required: true,
    },
    from: { type: String, default: "" },
    to: { type: String, default: "" },
    note: { type: String, default: "" },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    byName: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const STATUSES = ["todo", "in_progress", "waiting", "done", "cancelled"];
// Statuses that mean the work is finished, one way or another. Everything that
// asks "is this still owed" — overdue, the board's open columns, the sidebar
// badge, the digest — tests membership here rather than restating the pair,
// so adding a sixth status later cannot leave one of those counting it as open.
const TERMINAL_STATUSES = ["done", "cancelled"];
const TYPES = ["call", "email", "meeting", "demo", "follow_up", "proposal", "todo"];
const PRIORITIES = ["low", "normal", "high", "urgent"];

const crmTaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: "" }, // rich text (sanitised client-side + on write)

    type: { type: String, enum: TYPES, default: "todo" },
    priority: { type: String, enum: PRIORITIES, default: "normal" },
    status: { type: String, enum: STATUSES, default: "todo" },

    // Null means "no deadline" — a real state, not a missing value, so it is
    // never coerced to a date. Overdue is `dueAt != null && dueAt < now`.
    dueAt: { type: Date, default: null },

    assignee: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      name: { type: String, default: "" },
      assignedAt: { type: Date, default: null },
    },
    createdBy: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      name: { type: String, default: "" },
    },

    // What the task is about. Both optional and both may be set — a task on a
    // converted lead is still about the lead AND about the tenant it became.
    lead: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },
    organisation: { type: mongoose.Schema.Types.ObjectId, ref: "Organisation", default: null },

    tags: [{ type: String, trim: true }],
    checklist: { type: [checklistItemSchema], default: [] },
    comments: { type: [taskCommentSchema], default: [] },
    events: { type: [taskEventSchema], default: [] },

    // How it actually went. Captured when the task is closed, which is what
    // turns a completed "call" task into a logged call on the lead's timeline.
    outcome: { type: String, default: "" },
    completedAt: { type: Date, default: null },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// "What does this operator owe, soonest first" — the query behind My Tasks, the
// sidebar badge and the digest.
crmTaskSchema.index({ "assignee.userId": 1, status: 1, dueAt: 1 });
// "What is outstanding on this lead" — the lead's Tasks tab, and the per-lead
// counts joined into the leads list.
crmTaskSchema.index({ lead: 1, status: 1, dueAt: 1 });
// The board and the unfiltered list.
crmTaskSchema.index({ status: 1, dueAt: 1 });
crmTaskSchema.index({ createdAt: -1 });

crmTaskSchema.statics.STATUSES = STATUSES;
crmTaskSchema.statics.TERMINAL_STATUSES = TERMINAL_STATUSES;
crmTaskSchema.statics.TYPES = TYPES;
crmTaskSchema.statics.PRIORITIES = PRIORITIES;

module.exports = mongoose.model("CrmTask", crmTaskSchema);
