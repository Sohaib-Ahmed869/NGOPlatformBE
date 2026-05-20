const Organisation = require("../models/organisation");

const tenantMiddleware = async (req, res, next) => {
  try {
    const host = req.headers.host || "";
    // Remove port if present
    const hostname = host.split(":")[0];

    // Extract subdomain: for "acme.localhost" → "acme", for "localhost" → null
    const parts = hostname.split(".");
    let slug = null;

    if (parts.length > 1 && parts[0] !== "www" && parts[0] !== "admin") {
      slug = parts[0];
    }

    // Also check X-Tenant-Slug header (useful for dev/testing)
    if (!slug) {
      slug = req.headers["x-tenant-slug"] || null;
    }

    // No tenant context needed
    if (!slug) {
      req.organisation = null;
      return next();
    }

    const organisation = await Organisation.findOne({ slug });

    if (!organisation) {
      return res.status(404).json({ error: "Organisation not found" });
    }

    if (
      organisation.subscriptionStatus === "cancelled" ||
      organisation.subscriptionStatus === "past_due"
    ) {
      return res.status(402).json({ error: "Subscription inactive" });
    }

    if (!organisation.isActive) {
      return res.status(402).json({ error: "Organisation is not active" });
    }

    req.organisation = organisation;
    next();
  } catch (error) {
    console.error("Tenant middleware error:", error);
    res.status(500).json({ error: "Server error resolving tenant" });
  }
};

module.exports = tenantMiddleware;
