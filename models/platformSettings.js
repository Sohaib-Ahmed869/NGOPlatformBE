const mongoose = require("mongoose");

// Platform-wide settings + branding for the PUBLIC SaaS marketing site.
// A single document (the "platform" singleton), edited by the superadmin and
// read publicly (safe fields only) so the marketing site renders dynamically —
// the platform's own equivalent of a tenant's Organisation settings + Branding.
const platformSettingsSchema = new mongoose.Schema(
  {
    // Singleton guard — there is only ever one document.
    key: { type: String, default: "platform", unique: true, index: true },

    name: { type: String, default: "NGO Platform" },
    tagline: { type: String, default: "" },
    description: {
      type: String,
      default:
        "The warm, all-in-one platform that helps charities raise funds, welcome donors and run campaigns — with their own branded portal.",
    },

    branding: {
      logo: { type: String, default: "" }, // light logo — shown on DARK surfaces (footer)
      logoDark: { type: String, default: "" }, // dark logo — shown on LIGHT surfaces (navbar)
      iconLogo: { type: String, default: "" }, // square/collapsed icon — light, for DARK surfaces
      iconLogoDark: { type: String, default: "" }, // square/collapsed icon — dark, for LIGHT surfaces
      favicon: { type: String, default: "" },
      primaryColor: { type: String, default: "#102A23" }, // ink / headings, footer gradient
      accentColor: { type: String, default: "#047857" }, // buttons / links / active
      backgroundColor: { type: String, default: "#F3F8F5" }, // page background
      theme: { type: String, default: "modern-emerald" },
    },

    // Editable library of suggested pricing-card bullets, offered as quick-add
    // chips in the SuperAdmin plan editor (Marketing tab).
    planBulletLibrary: {
      type: [String],
      default: [
        "Unlimited donations",
        "Custom branding & logo",
        "Custom domain",
        "Tax-deductible receipts",
        "Donor management & CRM",
        "Advanced analytics & reports",
        "Priority email support",
        "Dedicated account manager",
        "Remove platform branding",
        "Bring your own Stripe & email",
        "Data export",
      ],
    },

    // The PLATFORM's own Stripe account — bills tenants for their SaaS
    // subscription and is the donation fallback for tenants without their own
    // keys. Mirrors Organisation.payment: secrets are AES-256-GCM encrypted
    // (utils/crypto.js) and are stripped by the toJSON transform below, so they
    // can never reach a client. Falls back to STRIPE_SECRET_KEY when not
    // enabled — see services/platformStripe.js.
    stripe: {
      enabled: { type: Boolean, default: false },
      mode: { type: String, enum: ["test", "live"], default: "test" },
      publishableKey: { type: String, default: "" },
      secretKeyEnc: { type: String, default: "" },
      // Display-only hint ("sk_live_••••••••4242") computed once at save time.
      // Storing it means the read path never has to decrypt the key just to
      // render a mask — plaintext only ever materializes on write and verify.
      secretKeyMask: { type: String, default: "" },
      webhookSecretEnc: { type: String, default: "" },
      // Stripe's id for the SaaS billing webhook endpoint, when it was created
      // from the console rather than by hand in the Stripe dashboard. Stored so
      // the console can tell "an endpoint exists" from "you still have to make
      // one", and so recreating it can delete the old one instead of leaving a
      // second endpoint delivering to the same URL.
      webhookEndpointId: { type: String, default: "" },
      accountLabel: { type: String, default: "" },
      accountId: { type: String, default: "" },
      lastVerifiedAt: { type: Date },

      // May a tenant WITHOUT their own Stripe keys take donations through this
      // platform account? The two Stripe setups are otherwise entirely separate
      // — this flag is their single, deliberate point of contact, and the only
      // reason a tenant page is ever handed the platform publishable key.
      //
      // Defaults to true because that is the long-standing behaviour of
      // services/tenantStripe.js; turning it off makes tenant donations require
      // the tenant's own account, and unconfigured tenants are told so plainly
      // instead of quietly billing into the operator's account.
      allowTenantFallback: { type: Boolean, default: true },
    },

    // The PLATFORM's own outbound mailbox — every transactional email that is
    // not sent through a tenant's own SMTP account goes out of here: SaaS
    // billing, registration, operator notices, and any tenant that hasn't
    // connected their own. Same shape and same rules as `stripe` above: the
    // password is AES-256-GCM encrypted (utils/crypto.js), stripped by the
    // toJSON transform below, and falls back to the EMAIL_* environment
    // variables when not enabled — see services/platformEmail.js.
    email: {
      enabled: { type: Boolean, default: false },
      host: { type: String, default: "" },
      port: { type: Number, default: 587 },
      // 465 => true (implicit TLS), 587 => false (STARTTLS). Getting this
      // backwards is the single most common SMTP misconfiguration: the client
      // waits for a TLS handshake the server never starts, and the send hangs
      // until it times out rather than failing with anything readable.
      secure: { type: Boolean, default: false },
      username: { type: String, default: "" },
      passwordEnc: { type: String, default: "" },
      // Display-only hint ("ab••••••yz"), computed at save time so the read
      // path never decrypts just to render a mask.
      passwordMask: { type: String, default: "" },
      // Envelope identity. fromEmail defaults to `username` when blank, which
      // is what most providers require anyway — they reject a From address the
      // authenticated mailbox does not own.
      fromName: { type: String, default: "" },
      fromEmail: { type: String, default: "" },
      replyTo: { type: String, default: "" },
      lastVerifiedAt: { type: Date },
      // The last failure text from a verify/test, kept so the console can show
      // WHY the mailbox is unhealthy instead of a bare red dot.
      lastVerifyError: { type: String, default: "" },
    },

    contactEmail: { type: String, default: "support@ngoplatform.com" },
    contactPhone: { type: String, default: "" },
    address: { type: String, default: "Sydney, NSW, Australia" },
    socialLinks: {
      facebook: { type: String, default: "" },
      instagram: { type: String, default: "" },
      twitter: { type: String, default: "" },
      linkedin: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

// Belt-and-braces: strip the encrypted secrets from every serialization.
// GET /api/platform/settings returns the whole document, so without this any
// field added under `stripe` would be shipped to the browser by default. Server
// code reads doc.stripe.secretKeyEnc off the Mongoose document directly, which
// this doesn't touch.
function scrubSecrets(_doc, ret) {
  if (ret.stripe) {
    delete ret.stripe.secretKeyEnc;
    delete ret.stripe.webhookSecretEnc;
  }
  if (ret.email) {
    delete ret.email.passwordEnc;
  }
  return ret;
}
platformSettingsSchema.set("toJSON", { transform: scrubSecrets });
platformSettingsSchema.set("toObject", { transform: scrubSecrets });

// Fetch (or lazily create) the one settings document.
platformSettingsSchema.statics.getSingleton = async function () {
  let doc = await this.findOne({ key: "platform" });
  if (!doc) doc = await this.create({ key: "platform" });
  return doc;
};

module.exports = mongoose.model("PlatformSettings", platformSettingsSchema);
