const PlatformSettings = require("../models/platformSettings");
const { brandingUpload, deleteS3Object } = require("../config/s3");

// Safe public projection — exactly what the marketing site needs, nothing else.
const toPublic = (s) => ({
  name: s.name,
  tagline: s.tagline,
  description: s.description,
  logo: s.branding?.logo || "",
  logoDark: s.branding?.logoDark || "",
  iconLogo: s.branding?.iconLogo || "",
  iconLogoDark: s.branding?.iconLogoDark || "",
  favicon: s.branding?.favicon || "",
  primaryColor: s.branding?.primaryColor || "#102A23",
  accentColor: s.branding?.accentColor || "#047857",
  backgroundColor: s.branding?.backgroundColor || "#F3F8F5",
  theme: s.branding?.theme || "modern-emerald",
  contactEmail: s.contactEmail || "",
  contactPhone: s.contactPhone || "",
  address: s.address || "",
  socialLinks: {
    facebook: s.socialLinks?.facebook || "",
    instagram: s.socialLinks?.instagram || "",
    twitter: s.socialLinks?.twitter || "",
    linkedin: s.socialLinks?.linkedin || "",
  },
});

/**
 * GET /api/platform/public  (no auth)
 * Public branding + contact fields for the marketing site.
 */
exports.getPublic = async (req, res) => {
  try {
    const s = await PlatformSettings.getSingleton();
    res.json(toPublic(s));
  } catch (error) {
    console.error("Get public platform settings error:", error);
    res.status(500).json({ error: "Failed to load platform settings" });
  }
};

/**
 * GET /api/platform/settings  (superadmin)
 * The full settings document for the superadmin editor.
 */
exports.getSettings = async (req, res) => {
  try {
    const s = await PlatformSettings.getSingleton();
    res.json(s);
  } catch (error) {
    console.error("Get platform settings error:", error);
    res.status(500).json({ error: "Failed to load platform settings" });
  }
};

/**
 * PUT /api/platform/settings  (superadmin)
 * Update details (name/tagline/description/contact/social) and branding
 * colours/theme. Logo images are handled by the asset endpoints below.
 */
exports.updateSettings = async (req, res) => {
  try {
    const b = req.body || {};
    const s = await PlatformSettings.getSingleton();
    const hex = /^#[0-9A-Fa-f]{6}$/;

    if (b.name !== undefined) s.name = String(b.name).slice(0, 120);
    if (b.tagline !== undefined) s.tagline = String(b.tagline).slice(0, 200);
    if (b.description !== undefined) s.description = String(b.description).slice(0, 1200);
    if (b.contactEmail !== undefined) s.contactEmail = String(b.contactEmail).slice(0, 160);
    if (b.contactPhone !== undefined) s.contactPhone = String(b.contactPhone).slice(0, 60);
    if (b.address !== undefined) s.address = String(b.address).slice(0, 240);

    if (b.socialLinks && typeof b.socialLinks === "object") {
      ["facebook", "instagram", "twitter", "linkedin"].forEach((k) => {
        if (b.socialLinks[k] !== undefined) s.socialLinks[k] = String(b.socialLinks[k]).slice(0, 300);
      });
      s.markModified("socialLinks");
    }

    // Branding colours/theme may come nested under `branding` or flat.
    const br = b.branding || b;
    if (br.primaryColor && hex.test(br.primaryColor)) s.branding.primaryColor = br.primaryColor;
    if (br.accentColor && hex.test(br.accentColor)) s.branding.accentColor = br.accentColor;
    if (br.backgroundColor && hex.test(br.backgroundColor)) s.branding.backgroundColor = br.backgroundColor;
    if (br.theme !== undefined) s.branding.theme = String(br.theme).slice(0, 60);
    s.markModified("branding");

    await s.save();
    res.json(s);
  } catch (error) {
    console.error("Update platform settings error:", error);
    res.status(500).json({ error: "Failed to update platform settings" });
  }
};

// Whitelist of branding image slots → field on `branding`.
const ASSET_FIELDS = {
  logo: "logo",
  "logo-dark": "logoDark",
  "icon-logo": "iconLogo",
  "icon-logo-dark": "iconLogoDark",
  favicon: "favicon",
};

/**
 * POST /api/platform/settings/asset/:type  (superadmin)  type = logo | logo-dark | favicon
 * Upload a branding image to S3 and store its URL.
 */
exports.uploadAsset = [
  brandingUpload.single("file"),
  async (req, res) => {
    try {
      const field = ASSET_FIELDS[req.params.type];
      if (!field) return res.status(400).json({ error: "Invalid asset type" });
      if (!req.file || !req.file.location) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const s = await PlatformSettings.getSingleton();
      // Best-effort cleanup of the previous image for this slot.
      if (s.branding?.[field]) {
        try {
          const oldKey = new URL(s.branding[field]).pathname.substring(1);
          await deleteS3Object(oldKey);
        } catch (e) {
          // ignore — cleanup is best-effort
        }
      }

      s.branding[field] = req.file.location;
      s.markModified("branding");
      await s.save();

      res.json({ message: "Asset uploaded successfully", field, url: req.file.location });
    } catch (error) {
      console.error("Upload platform asset error:", error);
      res.status(500).json({ error: "Failed to upload asset" });
    }
  },
];

/**
 * DELETE /api/platform/settings/asset/:type  (superadmin)
 * Remove a branding image and clear its field.
 */
exports.deleteAsset = async (req, res) => {
  try {
    const field = ASSET_FIELDS[req.params.type];
    if (!field) return res.status(400).json({ error: "Invalid asset type" });

    const s = await PlatformSettings.getSingleton();
    if (s.branding?.[field]) {
      try {
        const oldKey = new URL(s.branding[field]).pathname.substring(1);
        await deleteS3Object(oldKey);
      } catch (e) {
        // best-effort cleanup
      }
    }

    s.branding[field] = "";
    s.markModified("branding");
    await s.save();

    res.json({ message: "Asset removed successfully", field });
  } catch (error) {
    console.error("Delete platform asset error:", error);
    res.status(500).json({ error: "Failed to remove asset" });
  }
};
