// Per-tenant transactional email. Each organisation can connect its OWN SMTP
// account (host/port/user/pass), stored AES-256-GCM encrypted on the org. When a
// tenant hasn't configured (and enabled) their own, we fall back to the platform
// SMTP account — exactly like getTenantStripe() falls back to platformStripe —
// so emails keep sending during rollout.
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const { decrypt } = require("../utils/crypto");
const Organisation = require("../models/organisation");

const PLATFORM_FROM_NAME = process.env.EMAIL_FROM_NAME || "Shahid Afridi Foundation";

// Leaving EMAIL_HOST unset while EMAIL_USER points at another provider sends the
// right credentials to the wrong server, which the provider rejects as
// "535 Authentication unsuccessful" — a login error for what is really a host
// misconfiguration. Infer the host from the address domain instead of assuming.
const SMTP_BY_DOMAIN = {
  "gmail.com": "smtp.gmail.com",
  "googlemail.com": "smtp.gmail.com",
  "outlook.com": "smtp-mail.outlook.com",
  "hotmail.com": "smtp-mail.outlook.com",
  "live.com": "smtp-mail.outlook.com",
  "yahoo.com": "smtp.mail.yahoo.com",
  "zoho.com": "smtp.zoho.com",
};
const isOutlookHost = (host) => /outlook|hotmail|live|office365/i.test(host || "");

function defaultSmtpHost(user) {
  const domain = String(user || "").split("@")[1];
  return SMTP_BY_DOMAIN[(domain || "").toLowerCase()] || "smtp-mail.outlook.com";
}

const PLATFORM_HOST = process.env.EMAIL_HOST || defaultSmtpHost(process.env.EMAIL_USER);
if (!process.env.EMAIL_HOST && process.env.EMAIL_USER) {
  console.warn(`[email] EMAIL_HOST not set — using ${PLATFORM_HOST} for ${process.env.EMAIL_USER}`);
}

// The platform's own SMTP transport (today's global account).
const platformTransport = nodemailer.createTransport({
  host: PLATFORM_HOST,
  port: Number(process.env.EMAIL_PORT) || 587,
  secure: process.env.EMAIL_SECURE === "true" || false,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  // Legacy workaround for Outlook's SMTP only — forcing it on other providers
  // (Gmail especially) breaks the TLS handshake.
  ...(isOutlookHost(PLATFORM_HOST) ? { tls: { ciphers: "SSLv3" } } : {}),
});

// Cache built transports by config signature so we don't rebuild one per send.
const cache = new Map();

/** Has the tenant configured (and enabled) their own SMTP account? */
function isEmailConfigured(org) {
  const e = org && org.email;
  return !!(e && e.enabled && e.host && e.username && e.passwordEnc);
}

/** Build a nodemailer transport from a plain SMTP config. */
function buildTransport(cfg) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port) || 587,
    secure: !!cfg.secure, // 465 → true, 587/STARTTLS → false
    auth: { user: cfg.username, pass: cfg.password },
  });
}

/**
 * Resolve the transport to use for an org.
 * Returns { transport, tenant } — `tenant` is true when the tenant's own SMTP
 * is used, false when falling back to the platform account.
 */
function getTenantTransport(org) {
  if (!isEmailConfigured(org)) return { transport: platformTransport, tenant: false };
  const password = decrypt(org.email.passwordEnc);
  if (!password) return { transport: platformTransport, tenant: false };

  const e = org.email;
  const sig = [e.host, e.port, e.secure, e.username, password].join("|");
  if (!cache.has(sig)) {
    cache.set(sig, buildTransport({ host: e.host, port: e.port, secure: e.secure, username: e.username, password }));
  }
  return { transport: cache.get(sig), tenant: true };
}

/**
 * Resolve the From identity. Prefers the tenant's configured sender; for tenant
 * SMTP the From address must be the tenant's own (their from-email or username).
 * On the platform fallback we keep the platform mailbox as the envelope sender.
 */
function getFromIdentity(org, options = {}) {
  const e = (org && org.email) || {};
  const tenant = isEmailConfigured(org) && !!decrypt(e.passwordEnc);
  const fromName = e.fromName || options.fromName || PLATFORM_FROM_NAME;
  const fromEmail = tenant ? e.fromEmail || e.username : process.env.EMAIL_USER;
  const replyTo = options.replyTo || e.replyTo || "";
  return { fromName, fromEmail, replyTo, tenant };
}

// Resolve an org from a doc OR an id (so helpers that only have an
// organisationId can still send tenant-branded email). Short TTL cache so a
// loop of emails to many donors doesn't hammer the DB.
const orgCache = new Map(); // id → { org, exp }
const ORG_TTL_MS = 5 * 60 * 1000;

async function resolveOrg(orgOrId) {
  if (!orgOrId) return null;
  // An ObjectId is an object too — without this check a caller passing
  // `organisationId` (receipts do) got the id back as the "org", so the tenant's
  // own SMTP was never used and everything silently fell back to the platform.
  const isId =
    typeof orgOrId === "string" || orgOrId instanceof mongoose.Types.ObjectId;
  if (!isId && typeof orgOrId === "object") return orgOrId; // already a doc
  const id = String(orgOrId);
  const now = Date.now();
  const hit = orgCache.get(id);
  if (hit && hit.exp > now) return hit.org;
  let org = null;
  try {
    org = await Organisation.findById(id).select("email name");
  } catch (_) {
    org = null;
  }
  orgCache.set(id, { org, exp: now + ORG_TTL_MS });
  return org;
}

module.exports = {
  platformTransport,
  isEmailConfigured,
  buildTransport,
  getTenantTransport,
  getFromIdentity,
  resolveOrg,
  PLATFORM_FROM_NAME,
};
