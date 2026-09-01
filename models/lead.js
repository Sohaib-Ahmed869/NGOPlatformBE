const mongoose = require("mongoose");

// A unified thread entry — an internal note (team-only) or a reply emailed to
// the lead's contact. Same shape as ContactQuery's threadEntrySchema.
const threadEntrySchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["note", "reply"], default: "note" },
    body: { type: String, required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    authorName: { type: String, default: "" },
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    emailedTo: { type: String, default: "" },
    emailStatus: { type: String, enum: ["sent", "failed", ""], default: "" },
  },
  { timestamps: true }
);

// A secondary contact at the prospect organisation. Only `name` is required —
// an operator who has a name and no email yet still needs somewhere to put it,
// and a form that refuses the half-known contact is a form nobody fills in.
const additionalContactSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    phone: { type: String, default: "" },
    role: { type: String, default: "" },
    note: { type: String, default: "" },
  },
  { timestamps: true }
);

const stageHistorySchema = new mongoose.Schema(
  {
    from: { type: String, default: "" },
    to: { type: String, required: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    changedByName: { type: String, default: "" },
    note: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

// Pipeline stages. "won" and "lost" are terminal — "won" is only ever set by
// the Convert action (never by the plain stage-change endpoint), so a lead can
// never read Won without a real convertedOrgId behind it.
const STAGES = ["new", "contacted", "qualified", "demo_scheduled", "proposal_sent", "won", "lost"];

const leadSchema = new mongoose.Schema(
  {
    // ── Organisation info ──
    orgName: { type: String, required: true, trim: true },
    orgWebsite: { type: String, default: "" },
    // Mirrors Organisation.isMuslimCharity 1:1 so conversion is a trivial copy.
    verticalType: { type: String, enum: ["general", "muslim"], default: "general" },
    causeAreas: [{ type: String }],
    country: { type: String, default: "" },

    // ── Contact person ──
    // The PRIMARY contact — whoever filled the form in. Kept as flat fields
    // rather than folded into `contacts` below because conversion, the reply
    // email and every existing query read them by name, and because a lead
    // always has exactly one of these while `contacts` may be empty.
    contactName: { type: String, required: true, trim: true },
    contactEmail: { type: String, required: true, trim: true, lowercase: true },
    contactPhone: { type: String, default: "" },
    contactRole: { type: String, default: "" },

    // Everyone else at the organisation who matters to the deal — the finance
    // approver, the board sponsor, the person who actually runs the website.
    // Charity software is rarely bought by one person, and a note saying "spoke
    // to their treasurer" is worth much less without the treasurer's number.
    contacts: { type: [additionalContactSchema], default: [] },

    // ── Size / budget ──
    staffSize: { type: String, enum: ["1-5", "6-20", "21-50", "51-200", "200+", ""], default: "" },
    annualBudgetRange: {
      type: String,
      enum: ["under_50k", "50k_250k", "250k_1m", "1m_5m", "5m_plus", ""],
      default: "",
    },
    donorDatabaseSize: {
      type: String,
      enum: ["under_500", "500_2500", "2500_10000", "10000_plus", "unsure", ""],
      default: "",
    },

    // ── Current tools / challenges ──
    currentTools: [{ type: String }],
    currentToolsOther: { type: String, default: "" },
    challenges: [{ type: String }],
    challengesOther: { type: String, default: "" },

    // ── Intent / timeline ──
    interestedPlan: { type: String, default: "" },
    interestedBillingCycle: { type: String, enum: ["monthly", "annual", ""], default: "" },
    timeline: {
      type: String,
      enum: ["immediately", "this_month", "this_quarter", "this_year", "just_researching", ""],
      default: "",
    },
    decisionRole: {
      type: String,
      enum: ["decision_maker", "influencer", "researching_for_others", ""],
      default: "",
    },
    message: { type: String, default: "" },

    // ── Source / UTM tracking ──
    source: {
      type: String,
      enum: ["get_started_form", "contact_page", "superadmin_manual", "referral", "other"],
      default: "get_started_form",
    },
    utm: {
      source: { type: String, default: "" },
      medium: { type: String, default: "" },
      campaign: { type: String, default: "" },
      term: { type: String, default: "" },
      content: { type: String, default: "" },
    },
    referrerUrl: { type: String, default: "" },
    landingPage: { type: String, default: "" },

    // ── Consent ──
    consentToContact: { type: Boolean, default: false },
    consentAt: { type: Date, default: null },

    // ── Spam guard ──
    honeypotTriggered: { type: Boolean, default: false },
    fastSubmit: { type: Boolean, default: false },
    flaggedSpam: { type: Boolean, default: false },
    submitIp: { type: String, default: "" },

    // ── Deal ──
    // What the deal is worth per year if it closes. Annualised on purpose: the
    // catalogue sells monthly and yearly, and summing a mix of the two gives a
    // pipeline figure that means nothing. The console labels it "annual value"
    // and converts a monthly plan on the way in.
    dealValue: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "aud", lowercase: true },
    expectedCloseAt: { type: Date, default: null },
    // Sales-attention priority. Distinct from CrmTask.priority, which is about
    // one piece of work — this is about the account.
    priority: { type: String, enum: ["low", "normal", "high"], default: "normal" },
    // Free-form operator labels ("inbound", "conference-2026", "needs-legal").
    // Not an enum: the whole value of a tag is that nobody had to ship a
    // migration to invent one.
    tags: [{ type: String, trim: true }],

    // ── CRM mechanics ──
    stage: { type: String, enum: STAGES, default: "new" },
    stageHistory: { type: [stageHistorySchema], default: [] },
    assignee: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      name: { type: String, default: "" },
      assignedAt: { type: Date, default: null },
    },
    thread: { type: [threadEntrySchema], default: [] },
    lastMessageAt: { type: Date, default: Date.now },

    lostReason: {
      type: String,
      enum: ["budget", "timing", "chose_competitor", "no_response", "not_a_fit", "spam", "other", ""],
      default: "",
    },
    lostReasonNote: { type: String, default: "" },
    lostAt: { type: Date, default: null },

    // ── Conversion ──
    convertedOrgId: { type: mongoose.Schema.Types.ObjectId, ref: "Organisation", default: null },
    convertedAt: { type: Date, default: null },
    // "manual_provision" = comped/free, created instantly, no Stripe.
    // "manual_provision_paid" = operator-configured deal that still needed real
    // payment — either charged in the console (Elements) or via an emailed
    // payment link; both finalize through the same orgActivation.js chokepoint
    // so the two aren't distinguished here (the audit log has that detail).
    conversionMode: { type: String, enum: ["activation_link", "manual_provision", "manual_provision_paid", ""], default: "" },
    activation: {
      tokenHash: { type: String, default: "" },
      tokenExpiresAt: { type: Date, default: null },
      sentAt: { type: Date, default: null },
      sentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      openedAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

leadSchema.index({ stage: 1, lastMessageAt: -1 });
leadSchema.index({ contactEmail: 1 });
leadSchema.index({ createdAt: -1 });
leadSchema.index({ "activation.tokenHash": 1 });

leadSchema.statics.STAGES = STAGES;

module.exports = mongoose.model("Lead", leadSchema);
