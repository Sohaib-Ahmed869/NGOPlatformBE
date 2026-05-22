const Organisation = require("../models/organisation");

// Subdomain labels that are never a tenant slug.
const RESERVED = new Set(["www", "admin", "api", "app", "backend", "ngoplatformbe"]);

// The root domain the tenants live under, e.g. "charities.ltd".
// Falls back to CORS_DOMAIN so a single env var can drive both.
const ROOT_DOMAIN = (
  process.env.TENANT_ROOT_DOMAIN ||
  process.env.CORS_DOMAIN ||
  ""
).toLowerCase();

/**
 * Derive a tenant slug from a hostname.
 * Production: "calcite.charities.ltd" -> "calcite"  (apex/www/admin -> null)
 * Dev:        "calcite.localhost"     -> "calcite"  ("localhost" -> null)
 * The API server's own host (e.g. "ngoplatformbe.onrender.com") -> null,
 * so the request Host header can never be mistaken for a tenant.
 */
function slugFromHostname(hostname) {
  if (!hostname) return null;
  hostname = hostname.toLowerCase().split(":")[0];

  // Local development: "<slug>.localhost"
  if (hostname === "localhost") return null;
  if (hostname.endsWith(".localhost")) {
    const first = hostname.split(".")[0];
    return RESERVED.has(first) ? null : first;
  }

  // Production: "<slug>.<ROOT_DOMAIN>"
  if (ROOT_DOMAIN) {
    if (hostname === ROOT_DOMAIN) return null; // apex domain
    if (hostname.endsWith("." + ROOT_DOMAIN)) {
      const first = hostname.slice(0, -(ROOT_DOMAIN.length + 1)).split(".")[0];
      return RESERVED.has(first) ? null : first;
    }
  }

  // Any other host (e.g. the API server's own domain) is not a tenant.
  return null;
}

function slugFromUrl(value) {
  if (!value) return null;
  try {
    return slugFromHostname(new URL(value).hostname);
  } catch (_) {
    return null;
  }
}

const tenantMiddleware = async (req, res, next) => {
  try {
    let slug = null;

    // 1. Explicit header set by the frontend — most reliable when present.
    const headerSlug = req.headers["x-tenant-slug"];
    if (headerSlug) {
      slug = String(headerSlug).trim().toLowerCase() || null;
    }

    // 2. The frontend's real URL — the browser sends Origin on every
    //    cross-origin request, so this works with no frontend changes.
    if (!slug) slug = slugFromUrl(req.headers.origin);

    // 3. Referer, as a secondary signal.
    if (!slug) slug = slugFromUrl(req.headers.referer);

    // 4. Request Host — only meaningful when frontend and backend share a
    //    domain (local dev). The API server's own host resolves to null.
    if (!slug) slug = slugFromHostname(req.headers.host);

    // No tenant context (non-tenant routes, server-to-server, etc.)
    if (!slug) {
      console.log("No tenant slug resolved — proceeding without tenant context");
      console.log("Request URL:", req.originalUrl);
      req.organisation = null;
      return next();
    }

    const organisation = await Organisation.findOne({ slug });

    if (!organisation) {
      console.warn(`Tenant not found for slug: ${slug}`);
      console.log("Request URL:", req.originalUrl);
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
