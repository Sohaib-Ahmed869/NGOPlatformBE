const Organisation = require("../models/organisation");

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
      "name slug contactEmail contactPhone address website bankDetails"
    );
    if (!org) {
      return res.status(404).json({ error: "Organisation not found" });
    }

    res.json({
      name: org.name,
      slug: org.slug,
      contactEmail: org.contactEmail || "",
      contactPhone: org.contactPhone || "",
      address: org.address || "",
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

    const { contactEmail, contactPhone, address, website, bankDetails } = req.body;

    const updateFields = {};
    if (contactEmail !== undefined) updateFields.contactEmail = contactEmail.trim();
    if (contactPhone !== undefined) updateFields.contactPhone = contactPhone.trim();
    if (address !== undefined) updateFields.address = address.trim();
    if (website !== undefined) updateFields.website = website.trim();
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
    ).select("name slug contactEmail contactPhone address website bankDetails");

    res.json({
      message: "Settings updated successfully",
      settings: {
        contactEmail: org.contactEmail,
        contactPhone: org.contactPhone,
        address: org.address,
        website: org.website,
        bankDetails: org.bankDetails,
      },
    });
  } catch (error) {
    console.error("Update settings error:", error);
    res.status(500).json({ error: "Failed to update settings" });
  }
};
