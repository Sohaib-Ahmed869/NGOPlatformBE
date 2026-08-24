const Organisation = require("../models/organisation");
const { portalHost, portalScheme } = require("../services/orgActivation");

/**
 * Donor-facing identity for a tenant — the name, links and contact details that
 * appear in receipts and transactional emails.
 *
 * This exists because those strings used to be hardcoded to the single charity
 * this platform was originally built for, so EVERY tenant's receipt carried that
 * charity's website, email and phone number, and their donors' cancellation
 * requests were emailed to that charity's inbox.
 *
 * Resolution is tenant → platform → generic. Nothing here hardcodes a specific
 * organisation, and the platform fallback is read from PlatformSettings so it
 * follows whatever the operator has configured.
 */

// Cached briefly: receipts are generated in bursts (one per installment) and
// this would otherwise re-read the same two documents for each one.
const TTL_MS = 60 * 1000;
let _platformCache = null; // { at, data }

async function platformDefaults() {
  if (_platformCache && Date.now() - _platformCache.at < TTL_MS) return _platformCache.data;
  let data = { name: "", email: "", phone: "", website: "" };
  try {
    const PlatformSettings = require("../models/platformSettings");
    const s = await PlatformSettings.findOne({ key: "platform" })
      .select("name contactEmail contactPhone")
      .lean();
    if (s) {
      data = {
        name: s.name || "",
        email: s.contactEmail || "",
        phone: s.contactPhone || "",
        website: "",
      };
    }
  } catch (e) {
    // Never let a settings read break a receipt or a transactional email.
    console.error("orgIdentity: platform defaults unavailable:", e.message);
  }
  _platformCache = { at: Date.now(), data };
  return data;
}

/** Drop the cached platform defaults (called when platform settings change). */
function invalidate() {
  _platformCache = null;
}

const clean = (v) => String(v || "").trim();

/** Strip the scheme so a website reads as "example.org" in a receipt footer. */
function bareDomain(url) {
  return clean(url).replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/**
 * @param {object|string} orgOrId  an Organisation document, or its id
 * @returns {Promise<{name,email,phone,website,portalUrl,loginUrl,footer}>}
 */
async function getOrgIdentity(orgOrId) {
  let org = orgOrId;
  if (org && typeof org !== "object") {
    try {
      org = await Organisation.findById(org)
        .select("name slug contactEmail contactPhone website email branding.logo branding.logoDark")
        .lean();
    } catch {
      org = null;
    }
  }

  const platform = await platformDefaults();

  // Name falls back to the platform so an email is never signed by a blank.
  const name = clean(org?.name) || platform.name || "Our Foundation";
  // Contact details deliberately DON'T fall back to the platform. These appear
  // on donor-facing receipts and emails; telling a charity's donor to call the
  // platform's support line about their donation is the same wrong-contact bug
  // this file was written to fix, just with a different wrong party. No details
  // is correct; someone else's is not. (Internal routing is separate — see
  // getOrgAdminEmail.)
  const email = clean(org?.contactEmail) || clean(org?.email);
  const phone = clean(org?.contactPhone);
  const website = clean(org?.website);
  // Email clients render on a light background, so prefer the dark-on-light
  // variant — the same rule the public navbar uses.
  const logo = clean(org?.branding?.logoDark) || clean(org?.branding?.logo);

  // The tenant's own portal, built the same way activation emails build it.
  let portalUrl = "";
  if (org?.slug) {
    try {
      portalUrl = `${portalScheme()}://${portalHost(org)}`;
    } catch {
      portalUrl = "";
    }
  }
  if (!portalUrl && website) portalUrl = clean(website);

  // "example.org | hello@example.org | 1300 000 000" — only the parts we have.
  const footer = [bareDomain(website || portalUrl), email, phone].filter(Boolean).join(" | ");

  return {
    name,
    email,
    phone,
    website,
    logo,
    portalUrl,
    loginUrl: portalUrl ? `${portalUrl}/login` : "",
    footer,
  };
}

/**
 * Where operational notices about a tenant (e.g. a cancellation request) should
 * go: the tenant's own inbox, else ADMIN_EMAIL, else the platform's support
 * address. Returns "" when nothing is configured, so callers can skip sending
 * rather than mail a stranger.
 */
async function getOrgAdminEmail(orgOrId) {
  const id = await getOrgIdentity(orgOrId);
  if (id.email) return id.email;
  // Operational escalation, not donor-facing: reaching the operator beats
  // dropping a cancellation request on the floor.
  const platform = await platformDefaults();
  return clean(process.env.ADMIN_EMAIL) || platform.email || "";
}

module.exports = { getOrgIdentity, getOrgAdminEmail, invalidate };
