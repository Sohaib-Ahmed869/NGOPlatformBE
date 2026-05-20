const Organisation = require("../models/organisation");
const { brandingUpload, deleteS3Object } = require("../config/s3");

/**
 * GET /api/branding
 * Get the current organisation's branding settings.
 */
exports.getBranding = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    const org = await Organisation.findById(orgId).select("name slug branding");
    if (!org) {
      return res.status(404).json({ error: "Organisation not found" });
    }

    res.json({
      name: org.name,
      slug: org.slug,
      branding: org.branding,
    });
  } catch (error) {
    console.error("Get branding error:", error);
    res.status(500).json({ error: "Failed to fetch branding settings" });
  }
};

/**
 * PUT /api/branding
 * Update the organisation's branding settings (colors, theme, tagline).
 */
exports.updateBranding = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    const { primaryColor, accentColor, backgroundColor, theme, tagline } = req.body;

    const { themes: allThemes } = require("../config/themePresets");
    if (theme && !allThemes[theme]) {
      return res.status(400).json({ error: "Invalid theme" });
    }

    // Validate hex color format
    const hexRegex = /^#[0-9A-Fa-f]{6}$/;
    if (primaryColor && !hexRegex.test(primaryColor)) {
      return res.status(400).json({ error: "Invalid primary color format" });
    }
    if (accentColor && !hexRegex.test(accentColor)) {
      return res.status(400).json({ error: "Invalid accent color format" });
    }
    if (backgroundColor && !hexRegex.test(backgroundColor)) {
      return res.status(400).json({ error: "Invalid background color format" });
    }

    const updateFields = {};
    if (primaryColor) updateFields["branding.primaryColor"] = primaryColor;
    if (accentColor) updateFields["branding.accentColor"] = accentColor;
    if (backgroundColor) updateFields["branding.backgroundColor"] = backgroundColor;
    if (theme) updateFields["branding.theme"] = theme;
    if (tagline !== undefined) updateFields["branding.tagline"] = tagline;

    const org = await Organisation.findByIdAndUpdate(
      orgId,
      { $set: updateFields },
      { new: true }
    ).select("name slug branding");

    res.json({
      message: "Branding updated successfully",
      branding: org.branding,
    });
  } catch (error) {
    console.error("Update branding error:", error);
    res.status(500).json({ error: "Failed to update branding" });
  }
};

/**
 * POST /api/branding/logo
 * Upload the organisation's logo to S3.
 */
exports.uploadLogo = [
  brandingUpload.single("logo"),
  async (req, res) => {
    try {
      const orgId = req.organisation?._id;
      if (!orgId) {
        return res.status(400).json({ error: "Organisation context required" });
      }

      if (!req.file || !req.file.location) {
        return res.status(400).json({ error: "No logo file uploaded" });
      }

      // Delete old logo from S3 if exists
      const org = await Organisation.findById(orgId);
      if (org.branding?.logo) {
        try {
          const oldKey = new URL(org.branding.logo).pathname.substring(1);
          await deleteS3Object(oldKey);
        } catch (e) {
          // Old logo cleanup is best-effort
        }
      }

      org.branding.logo = req.file.location;
      await org.save();

      res.json({
        message: "Logo uploaded successfully",
        logo: req.file.location,
      });
    } catch (error) {
      console.error("Upload logo error:", error);
      res.status(500).json({ error: "Failed to upload logo" });
    }
  },
];

/**
 * DELETE /api/branding/logo
 * Remove the organisation's logo.
 */
exports.deleteLogo = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    const org = await Organisation.findById(orgId);
    if (org.branding?.logo) {
      try {
        const oldKey = new URL(org.branding.logo).pathname.substring(1);
        await deleteS3Object(oldKey);
      } catch (e) {
        // Best-effort cleanup
      }
    }

    org.branding.logo = "";
    await org.save();

    res.json({ message: "Logo removed successfully" });
  } catch (error) {
    console.error("Delete logo error:", error);
    res.status(500).json({ error: "Failed to remove logo" });
  }
};

/**
 * GET /api/branding/themes
 * Return available theme presets.
 */
exports.getThemes = (req, res) => {
  const themes = {
    default: {
      name: "Default",
      primaryColor: "#2C2418",
      accentColor: "#C9A84C",
      backgroundColor: "#FAF7F2",
      description: "Warm and elegant — the classic charity look",
    },
    modern: {
      name: "Modern",
      primaryColor: "#1A1A2E",
      accentColor: "#E94560",
      backgroundColor: "#F8F9FA",
      description: "Bold and contemporary with vibrant accents",
    },
    classic: {
      name: "Classic",
      primaryColor: "#2D3436",
      accentColor: "#0984E3",
      backgroundColor: "#FFFFFF",
      description: "Clean and professional — inspires trust",
    },
    ocean: {
      name: "Ocean",
      primaryColor: "#1B4332",
      accentColor: "#40916C",
      backgroundColor: "#F0FFF4",
      description: "Fresh and natural — perfect for environmental causes",
    },
    forest: {
      name: "Forest",
      primaryColor: "#3D405B",
      accentColor: "#81B29A",
      backgroundColor: "#F4F1DE",
      description: "Earthy and grounded — warm sustainability vibes",
    },
    sunset: {
      name: "Sunset",
      primaryColor: "#2B2D42",
      accentColor: "#EF8354",
      backgroundColor: "#FFF8F0",
      description: "Warm and inviting — energetic and optimistic",
    },
  };

  res.json(themes);
};

// ── Branding Change Requests ──

const BrandingRequest = require("../models/brandingRequest");

/**
 * POST /api/branding/request
 * Org admin submits a branding change request for super admin review.
 */
exports.submitRequest = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    // Check for existing pending request
    const existing = await BrandingRequest.findOne({
      organisationId: orgId,
      status: "pending",
    });
    if (existing) {
      return res.status(400).json({
        error: "You already have a pending branding request. Please wait for it to be reviewed.",
      });
    }

    const org = await Organisation.findById(orgId);
    const { requestedBranding, message } = req.body;

    if (!requestedBranding) {
      return res.status(400).json({ error: "Requested branding is required" });
    }

    const request = await BrandingRequest.create({
      organisationId: orgId,
      requestedBy: req.user._id,
      requestedBranding,
      currentBranding: org.branding?.toObject?.() || org.branding,
      message: message || "",
    });

    res.status(201).json({
      message: "Branding change request submitted for review",
      request,
    });
  } catch (error) {
    console.error("Submit branding request error:", error);
    res.status(500).json({ error: "Failed to submit branding request" });
  }
};

/**
 * GET /api/branding/requests
 * Org admin views their own branding requests.
 */
exports.getMyRequests = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    const requests = await BrandingRequest.find({ organisationId: orgId })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate("reviewedBy", "name email");

    res.json(requests);
  } catch (error) {
    console.error("Get branding requests error:", error);
    res.status(500).json({ error: "Failed to fetch branding requests" });
  }
};
