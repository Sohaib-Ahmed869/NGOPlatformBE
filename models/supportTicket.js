const mongoose = require("mongoose");

const commentSchema = new mongoose.Schema(
  {
    message: { type: String, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    authorName: { type: String, default: "" },
    isInternal: { type: Boolean, default: false }, // internal notes hidden from the reporter
    emailStatus: { type: String, enum: ["sent", "failed", ""], default: "" }, // for a non-internal reply emailed to the reporter
  },
  { timestamps: true }
);

/**
 * A tenant→platform support ticket. Tenant-scoped (organisationId) so the
 * platform operator console can aggregate across every tenant with a single
 * query. `triage`/`kanbanStatus`/`triagedBy` are PLATFORM-ONLY fields the
 * tenant never sees.
 */
const supportTicketSchema = new mongoose.Schema(
  {
    organisationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organisation", required: true },
    ticketNumber: { type: Number }, // per-org sequence

    reporter: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      name: { type: String, default: "" },
      email: { type: String, default: "" },
      isExternal: { type: Boolean, default: false }, // submitted via the public form (i.e. while logged out)
      // Who the ticket is from, from the platform operator's point of view:
      //   "admin"    → the tenant's own NGO staff (admin/superadmin)
      //   "customer" → a donor / end-user (customer) of the tenant
      //   "public"   → an anonymous public-form submission (no account)
      // Stamped from the authenticated user's role at creation (see the
      // controller's reporterKind()). No `default` on purpose: tickets created
      // before this field shipped read as undefined, and the UI/backfill
      // (`npm run backfill:tickets`) resolve those from `isExternal` + the
      // linked user's role rather than being silently mislabelled.
      kind: { type: String, enum: ["admin", "customer", "public"] },
    },

    summary: { type: String, required: true },
    description: { type: String, default: "" },
    priority: { type: String, enum: ["low", "medium", "high", "critical"], default: "medium" },
    status: { type: String, enum: ["new", "in_progress", "on_hold", "solved", "declined"], default: "new" },
    category: {
      type: String,
      enum: ["technical", "bug_report", "feature_request", "access", "data", "billing", "account", "general", "feedback", "other"],
      default: "general",
    },

    assignee: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      assignedAt: { type: Date, default: null },
    },

    comments: { type: [commentSchema], default: [] },
    attachments: { type: [{ key: String, name: String, size: Number, url: String }], default: [] },
    firstResponseAt: { type: Date, default: null },

    satisfactionRating: { type: Number, min: 1, max: 5, default: null },
    satisfactionFeedback: { type: String, default: "" },
    // CSAT delivery: a one-time secret embedded in the "How did we do?" email link
    // (so only the real recipient can rate, and they can't be spoofed). Set when
    // the ticket is first resolved; `requestedAt` is the send-once guard and
    // `ratedAt` records when the reporter actually submitted a rating.
    satisfactionToken: { type: String, default: "" },
    satisfactionRequestedAt: { type: Date, default: null },
    satisfactionRatedAt: { type: Date, default: null },

    resolution: {
      notes: { type: String, default: "" },
      resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      resolvedAt: { type: Date, default: null },
    },

    // ── Platform-operator-only triage (never returned to tenant users) ──
    triage: { type: String, enum: ["unclassified", "bug", "feature", "invalid", "duplicate"], default: "unclassified" },
    kanbanStatus: { type: String, enum: ["todo", "in_progress", "done"], default: "todo" },
    triagedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    triagedAt: { type: Date, default: null },
    triageNotes: { type: String, default: "" },
  },
  { timestamps: true }
);

supportTicketSchema.index({ organisationId: 1, status: 1, createdAt: -1 });
supportTicketSchema.index({ triage: 1, kanbanStatus: 1 });
supportTicketSchema.index({ createdAt: -1 });

module.exports = mongoose.model("SupportTicket", supportTicketSchema);
