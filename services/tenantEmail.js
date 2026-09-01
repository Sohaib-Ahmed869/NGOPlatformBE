// Per-tenant transactional email. Each organisation can connect its OWN SMTP
// account (host/port/user/pass), stored AES-256-GCM encrypted on the org. When a
// tenant hasn't configured (and enabled) their own, we fall back to the platform
// SMTP account — exactly like getTenantStripe() falls back to platformStripe —
// so emails keep sending during rollout.
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const { decrypt } = require("../utils/crypto");
const Organisation = require("../models/organisation");

// The platform mailbox now lives in services/platformEmail.js, which resolves
// PlatformSettings.email first and the EMAIL_* env vars second. `platformTransport`
// re-exported below is that module's PROXY, so this file keeps its old name and
// every call site keeps its old syntax.
//
// It used to be a transport built right here, at require time, from
// process.env. That is why changing the platform mailbox meant editing .env and
// redeploying: the credentials were captured once when the process booted and
// nothing could replace them afterwards. Do not reintroduce a module-scope
// createTransport() — the same mistake as a module-scope Stripe client, and it
// silently disables the console screen that is meant to configure this.
const platformEmail = require("./platformEmail");
const platformTransport = platformEmail.platformTransport;

// Only used for PLATFORM-level mail (SaaS billing, operator notices) when no
// better name is available. Tenant mail falls back to the organisation's own
// name — see getFromIdentity.
const PLATFORM_FROM_NAME = process.env.EMAIL_FROM_NAME || "NGO Platform";

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
  // org.name before the platform default: a tenant that hasn't set a custom
  // from-name should still send as themselves, not as the platform (previously
  // this made every such tenant's mail arrive from one hardcoded charity).
  const fromName =
    e.fromName ||
    options.fromName ||
    (org && org.name) ||
    platformEmail.getIdentity().fromName ||
    PLATFORM_FROM_NAME;
  // Platform fallback: ask the resolver, not the environment — on a
  // console-configured mailbox process.env.EMAIL_USER is empty or, worse,
  // stale, which put a From address on the mail that the authenticated
  // mailbox does not own and providers reject outright.
  const fromEmail = tenant
    ? e.fromEmail || e.username
    : platformEmail.getIdentity().fromEmail || process.env.EMAIL_USER || "";
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
  platformEmail,
  isEmailConfigured,
  buildTransport,
  getTenantTransport,
  getFromIdentity,
  resolveOrg,
  PLATFORM_FROM_NAME,
};
