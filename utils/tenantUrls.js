/**
 * utils/tenantUrls.js
 *
 * Absolute links for a tenant, for use inside emails.
 *
 * Templates now contain buttons ("View your donations", "Review in admin
 * portal"), and a relative href in an email is dead — the recipient's mail
 * client has no base URL. Every controller was otherwise about to grow its own
 * copy of the same subdomain arithmetic, so it lives here once, built on the
 * same portalHost/portalScheme the activation email already uses.
 *
 * Returns "" when the tenant has no slug and no website, which the block
 * compiler treats as "drop this button" rather than rendering a broken link.
 */
const { portalHost, portalScheme } = require("../services/orgActivation");

const trim = (s) => String(s || "").trim().replace(/\/+$/, "");

/** The tenant's portal origin, e.g. https://hopetrust.charities.ltd */
function portalOrigin(org) {
  if (!org) return "";
  if (org.slug) {
    try {
      return `${portalScheme()}://${portalHost(org)}`;
    } catch {
      /* fall through to the configured website */
    }
  }
  return trim(org.website);
}

/** A link inside the tenant's donor-facing portal. */
function portalUrl(org, path = "") {
  const base = portalOrigin(org);
  return base ? `${base}${path}` : "";
}

/**
 * A link into the tenant's ADMIN portal. Same origin as the donor portal in this
 * product — kept as its own function so a future split (admin.<slug>.<domain>)
 * is a one-line change rather than a grep.
 */
function adminPortalUrl(org, path = "/admin") {
  return portalUrl(org, path);
}

/**
 * A link on the tenant's PUBLIC website. Prefers their own domain when they've
 * set one — a partner told "you're on our partners page" should land on the
 * charity's real site, not the platform subdomain.
 */
function publicSiteUrl(org, path = "") {
  const site = trim(org && org.website);
  if (site) return `${site}${path}`;
  return portalUrl(org, path);
}

/** The platform's own app origin — where /reset-password/:token lives. */
function platformAppUrl(path = "") {
  const base = trim(process.env.CLIENT_URL) || "http://localhost:5173";
  return `${base}${path}`;
}

/**
 * The SuperAdmin CONSOLE's origin — where /leads/:id and /tasks/:id live.
 *
 * Not the same place as platformAppUrl. The console is served from the `admin.`
 * subdomain (see App.jsx's host switch), so a console path hung off CLIENT_URL
 * resolves against the public marketing site, which has no such route and
 * bounces the operator to the homepage. That is exactly what the "Open the
 * lead" button in the new-lead alert did.
 *
 * SUPERADMIN_URL overrides it outright, for a deployment that serves the
 * console from somewhere the host name cannot describe.
 */
function platformConsoleUrl(path = "") {
  const explicit = trim(process.env.SUPERADMIN_URL);
  if (explicit) return `${explicit}${path}`;
  const client = trim(process.env.CLIENT_URL) || "http://localhost:5173";
  try {
    const url = new URL(client);
    if (!url.hostname.startsWith("admin.")) url.hostname = `admin.${url.hostname}`;
    return `${trim(url.toString())}${path}`;
  } catch {
    // CLIENT_URL isn't a parseable URL. A link to the wrong host still beats
    // throwing inside an email that is only trying to be helpful.
    return `${client}${path}`;
  }
}

module.exports = { portalOrigin, portalUrl, adminPortalUrl, publicSiteUrl, platformAppUrl, platformConsoleUrl };
