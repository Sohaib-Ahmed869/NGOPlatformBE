const mongoose = require("mongoose");

// A custom question the org adds to its public volunteer application form.
// Same shape as the Event registrationQuestions so the builder UI is shared.
const volunteerQuestionSchema = new mongoose.Schema(
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

// A public-facing event audience segment the org defines (e.g. "Brothers only",
// "Sisters only", "Open to all"). Events reference one by `key`; the label and
// colour drive the public Events calendar (colour-coded blocks + legend).
const eventAudienceSchema = new mongoose.Schema(
  {
    key: { type: String, required: true }, // stable id (slug of label)
    label: { type: String, required: true },
    color: { type: String, default: "#C9A84C" }, // hex, used on the public calendar
  },
  { _id: false }
);

const organisationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Organisation name is required"],
      trim: true,
    },
    slug: {
      type: String,
      required: [true, "Slug is required"],
      unique: true,
      lowercase: true,
      trim: true,
    },
    plan: {
      type: String,
      enum: ["basic", "professional", "enterprise"],
      default: "basic",
    },
    billingCycle: {
      type: String,
      enum: ["monthly", "annual"],
      default: "monthly",
    },
    stripeCustomerId: {
      type: String,
    },
    stripeSubscriptionId: {
      type: String,
    },
    subscriptionStatus: {
      type: String,
      enum: ["pending", "active", "past_due", "cancelled"],
      default: "pending",
    },
    revenueRange: {
      type: String,
      enum: ["0-500", "500-5000000", "5000000+"],
    },
    adminUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    branding: {
      // Primary logo — the light/white variant, shown on DARK backgrounds
      // (admin sidebar, footer, over dark headers).
      logo: { type: String, default: "" },
      // Dark-coloured logo variant, shown on LIGHT backgrounds (the white
      // public navbar, light pages). Falls back to `logo` when not set.
      logoDark: { type: String, default: "" },
      // Square mark shown when the admin sidebar is collapsed (the LIGHT/white
      // variant, for dark backgrounds). Falls back to a letter badge.
      iconLogo: { type: String, default: "" },
      // Dark-coloured square mark for LIGHT backgrounds — used as the favicon on
      // a light browser tab. Falls back to `iconLogo` when not set.
      iconLogoDark: { type: String, default: "" },
      // Browser tab icon. Ignored at render time when `faviconUseIcon` is true,
      // in which case `iconLogo` is used instead.
      favicon: { type: String, default: "" },
      // When true, the icon/collapsed logo doubles as the favicon so the admin
      // doesn't have to upload a separate file.
      faviconUseIcon: { type: Boolean, default: true },
      // Text shown in the browser tab. Empty → falls back to the org name.
      siteTitle: { type: String, default: "" },
      primaryColor: { type: String, default: "#2C2418" },
      accentColor: { type: String, default: "#C9A84C" },
      backgroundColor: { type: String, default: "#FAF7F2" },
      theme: {
        type: String,
        default: "default",
      },
      tagline: { type: String, default: "" },
    },
    // Organisation contact & details (managed by org admin)
    contactEmail: { type: String, default: "" },
    contactPhone: { type: String, default: "" },
    // Legacy single-line address — kept populated (composed from addressDetails)
    // for existing consumers (receipts, contact page, etc.).
    address: { type: String, default: "" },
    // Structured address for richer display/formatting.
    addressDetails: {
      line1: { type: String, default: "" },
      line2: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      postalCode: { type: String, default: "" },
      country: { type: String, default: "" },
    },
    // Optional social profiles — only the ones set are shown in the footer.
    socialLinks: {
      facebook: { type: String, default: "" },
      instagram: { type: String, default: "" },
      twitter: { type: String, default: "" },
      linkedin: { type: String, default: "" },
      whatsapp: { type: String, default: "" },
    },
    website: { type: String, default: "" },
    bankDetails: {
      bankName: { type: String, default: "" },
      bsb: { type: String, default: "" },
      accountNumber: { type: String, default: "" },
      accountName: { type: String, default: "" },
    },
    // Per-tenant payment processing (the tenant's OWN Stripe account).
    // Secrets are stored AES-256-GCM encrypted (see utils/crypto.js) and are
    // never returned to any client.
    payment: {
      provider: { type: String, default: "stripe" },
      enabled: { type: Boolean, default: false },
      publishableKey: { type: String, default: "" },
      secretKeyEnc: { type: String, default: "" },
      webhookSecretEnc: { type: String, default: "" },
      accountLabel: { type: String, default: "" },
      lastVerifiedAt: { type: Date },
    },
    // Per-tenant PayPal (the tenant's OWN PayPal app). The client secret is
    // AES-256-GCM encrypted (utils/crypto.js) and never returned; clientId is
    // public (the donor checkout buttons load with it, like Stripe's
    // publishableKey). Falls back to the platform PayPal app when not enabled.
    paypal: {
      enabled: { type: Boolean, default: false },
      mode: { type: String, enum: ["sandbox", "live"], default: "sandbox" },
      clientId: { type: String, default: "" },
      clientSecretEnc: { type: String, default: "" },
      webhookId: { type: String, default: "" }, // for webhook signature verification
      productId: { type: String, default: "" }, // cached catalog product for recurring plans
      accountLabel: { type: String, default: "" },
      lastVerifiedAt: { type: Date },
    },
    // Per-tenant Mailchimp (the tenant's OWN Mailchimp account) for newsletter
    // campaign delivery. API key is AES-256-GCM encrypted (utils/crypto.js) and
    // never returned to any client.
    mailchimp: {
      connected: { type: Boolean, default: false },
      apiKeyEnc: { type: String, default: "" },
      serverPrefix: { type: String, default: "" }, // datacenter, e.g. "us21"
      audienceId: { type: String, default: "" },
      audienceName: { type: String, default: "" },
      fromName: { type: String, default: "" },
      fromEmail: { type: String, default: "" }, // verified sender in their account
      accountLabel: { type: String, default: "" },
      lastVerifiedAt: { type: Date },
      // Two-way sync: Mailchimp posts subscribe/unsubscribe/clean events to our
      // webhook (secret guards it); webhookId is the registered hook.
      webhookSecret: { type: String, default: "" },
      webhookId: { type: String, default: "" },
    },
    // Per-tenant transactional email (the tenant's OWN SMTP account) for
    // receipts, welcome and notification emails. The SMTP password is stored
    // AES-256-GCM encrypted (utils/crypto.js) and never returned to any client.
    // When not configured/enabled, sending falls back to the platform account.
    email: {
      enabled: { type: Boolean, default: false },
      host: { type: String, default: "" },
      port: { type: Number, default: 587 },
      secure: { type: Boolean, default: false }, // true for 465, false for 587/STARTTLS
      username: { type: String, default: "" },
      passwordEnc: { type: String, default: "" },
      fromName: { type: String, default: "" },
      fromEmail: { type: String, default: "" }, // sender address (defaults to username)
      replyTo: { type: String, default: "" },
      accountLabel: { type: String, default: "" },
      lastVerifiedAt: { type: Date },
    },
    // Custom questions appended to the public volunteer ("Join the team") form.
    volunteerQuestions: { type: [volunteerQuestionSchema], default: [] },
    // Audience segments for events (label + colour). Drives the public Events
    // calendar's audience filter, colour coding and legend. Empty = feature off.
    eventAudiences: { type: [eventAudienceSchema], default: [] },
    isActive: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

organisationSchema.index({ stripeCustomerId: 1 });

module.exports = mongoose.model("Organisation", organisationSchema);
