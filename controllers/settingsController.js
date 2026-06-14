const Organisation = require("../models/organisation");

// Compose a single-line address from structured parts (kept for legacy consumers).
function composeAddress(a = {}) {
  const cityState = [a.city, a.state].filter(Boolean).join(", ");
  const cityLine = [cityState, a.postalCode].filter(Boolean).join(" ").trim();
  return [a.line1, a.line2, cityLine, a.country]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join(", ");
}

const SOCIAL_KEYS = ["facebook", "instagram", "twitter", "linkedin", "whatsapp"];

/**
 * GET /api/settings
 * Get the current organisation's settings (contact, bank details, etc.)
 */
exports.getSettings = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    const org = await Organisation.findById(orgId).select(
      "name slug contactEmail contactPhone address addressDetails socialLinks website bankDetails"
    );
    if (!org) {
      return res.status(404).json({ error: "Organisation not found" });
    }

    const a = org.addressDetails || {};
    const s = org.socialLinks || {};
    res.json({
      name: org.name,
      slug: org.slug,
      contactEmail: org.contactEmail || "",
      contactPhone: org.contactPhone || "",
      address: org.address || "",
      addressDetails: {
        line1: a.line1 || "",
        line2: a.line2 || "",
        city: a.city || "",
        state: a.state || "",
        postalCode: a.postalCode || "",
        country: a.country || "",
      },
      socialLinks: SOCIAL_KEYS.reduce((acc, k) => ({ ...acc, [k]: s[k] || "" }), {}),
      website: org.website || "",
      bankDetails: {
        bankName: org.bankDetails?.bankName || "",
        bsb: org.bankDetails?.bsb || "",
        accountNumber: org.bankDetails?.accountNumber || "",
        accountName: org.bankDetails?.accountName || "",
      },
    });
  } catch (error) {
    console.error("Get settings error:", error);
    res.status(500).json({ error: "Failed to fetch settings" });
  }
};

/**
 * PUT /api/settings
 * Update the organisation's settings.
 */
exports.updateSettings = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    const { contactEmail, contactPhone, address, addressDetails, socialLinks, website, bankDetails } = req.body;

    const updateFields = {};
    if (contactEmail !== undefined) updateFields.contactEmail = contactEmail.trim();
    if (contactPhone !== undefined) updateFields.contactPhone = contactPhone.trim();
    if (website !== undefined) updateFields.website = website.trim();

    // Structured address → store parts, and keep the legacy single-line in sync.
    if (addressDetails && typeof addressDetails === "object") {
      const parts = {};
      ["line1", "line2", "city", "state", "postalCode", "country"].forEach((k) => {
        if (addressDetails[k] !== undefined) {
          const v = String(addressDetails[k]).trim();
          parts[k] = v;
          updateFields[`addressDetails.${k}`] = v;
        }
      });
      updateFields.address = composeAddress({ ...parts });
    } else if (address !== undefined) {
      updateFields.address = address.trim();
    }

    if (socialLinks && typeof socialLinks === "object") {
      SOCIAL_KEYS.forEach((k) => {
        if (socialLinks[k] !== undefined) {
          updateFields[`socialLinks.${k}`] = String(socialLinks[k]).trim();
        }
      });
    }

    if (bankDetails) {
      if (bankDetails.bankName !== undefined) updateFields["bankDetails.bankName"] = bankDetails.bankName.trim();
      if (bankDetails.bsb !== undefined) updateFields["bankDetails.bsb"] = bankDetails.bsb.trim();
      if (bankDetails.accountNumber !== undefined) updateFields["bankDetails.accountNumber"] = bankDetails.accountNumber.trim();
      if (bankDetails.accountName !== undefined) updateFields["bankDetails.accountName"] = bankDetails.accountName.trim();
    }

    const org = await Organisation.findByIdAndUpdate(
      orgId,
      { $set: updateFields },
      { new: true }
    ).select("name slug contactEmail contactPhone address addressDetails socialLinks website bankDetails");

    res.json({
      message: "Settings updated successfully",
      settings: {
        contactEmail: org.contactEmail,
        contactPhone: org.contactPhone,
        address: org.address,
        addressDetails: org.addressDetails,
        socialLinks: org.socialLinks,
        website: org.website,
        bankDetails: org.bankDetails,
      },
    });
  } catch (error) {
    console.error("Update settings error:", error);
    res.status(500).json({ error: "Failed to update settings" });
  }
};
