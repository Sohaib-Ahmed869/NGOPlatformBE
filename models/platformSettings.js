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

// Fetch (or lazily create) the one settings document.
platformSettingsSchema.statics.getSingleton = async function () {
  let doc = await this.findOne({ key: "platform" });
  if (!doc) doc = await this.create({ key: "platform" });
  return doc;
};

module.exports = mongoose.model("PlatformSettings", platformSettingsSchema);
