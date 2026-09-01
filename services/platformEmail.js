const nodemailer = require("nodemailer");
const { decrypt } = require("../utils/crypto");

/**
 * The PLATFORM's own outbound mailbox — the account every transactional email
 * leaves from unless the sending tenant has connected SMTP of their own. This
 * is the platform-level counterpart to the per-tenant transports in
 * services/tenantEmail.js, and the email twin of services/platformStripe.js.
 *
 * Credentials resolve in this order:
 *   1. PlatformSettings.email   (saved by the superadmin in the console, AES-GCM encrypted)
 *   2. process.env.EMAIL_HOST / EMAIL_PORT / EMAIL_SECURE / EMAIL_USER / EMAIL_PASS
 *
 * Two things to know about the exported `transport` object, both learned from
 * the Stripe service:
 *
 * - It is a PROXY, not a transport. Every property access resolves the
 *   currently active transport, so call sites that used to hold a module-scope
 *   `nodemailer.createTransport(process.env...)` pick up a mailbox saved in the
 *   console without a restart, keeping their `transport.sendMail(...)` syntax
 *   verbatim. That matters more here than it did for Stripe: the old
 *   module-scope transport in tenantEmail.js was built at REQUIRE time, so the
 *   values it captured were whatever was in .env when the process booted and
 *   nothing short of a redeploy could change them.
 *
 * - Construction is DEFERRED. Unlike Stripe, nodemailer.createTransport() does
 *   not throw on empty credentials — it cheerfully builds a transport that
 *   fails on every send with an authentication error. Deferring means an
 *   operator with no mail configured at all gets `isEmailConfigured() === false`
 *   and a message naming the fix, instead of a stream of 535s.
 *
 * Never log or return a decrypted password from here.
 */

let _transport = null; // active nodemailer transport (built lazily)
let _sig = ""; // config signature the active transport was built from
let _source = "none"; // "database" | "env" | "none"
let _identity = { fromName: "", fromEmail: "", replyTo: "" };
let _primed = false; // has the DB config been read at least once?

// Leaving EMAIL_HOST unset while EMAIL_USER points at another provider sends
// the right credentials to the wrong server, which the provider rejects as
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

/** Best-guess SMTP host for an address whose provider was not stated. */
function defaultSmtpHost(user) {
  const domain = String(user || "").split("@")[1];
  return SMTP_BY_DOMAIN[(domain || "").toLowerCase()] || "smtp-mail.outlook.com";
}

/** The EMAIL_* environment mailbox, or null when it isn't usable. */
function envConfig() {
  const username = (process.env.EMAIL_USER || "").trim();
  const password = process.env.EMAIL_PASS || "";
  if (!username || !password) return null;
  return {
    host: (process.env.EMAIL_HOST || "").trim() || defaultSmtpHost(username),
    port: Number(process.env.EMAIL_PORT) || 587,
    secure: process.env.EMAIL_SECURE === "true",
    username,
    password,
    fromName: (process.env.EMAIL_FROM_NAME || "").trim(),
    fromEmail: username,
    replyTo: "",
  };
}

/** Everything that changes the wire behaviour, for cheap identity comparison. */
const signature = (c) =>
  c ? [c.host, c.port, c.secure, c.username, c.password].join("|") : "";

/**
 * Build a nodemailer transport from a plain config.
 * Exported because the console's "send test" needs to exercise a mailbox the
 * operator has typed but not yet saved.
 */
function buildTransport(cfg) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port) || 587,
    secure: !!cfg.secure, // 465 -> true, 587/STARTTLS -> false
    auth: { user: cfg.username, pass: cfg.password },
    // Legacy workaround for Outlook's SMTP only — forcing it on other providers
    // (Gmail especially) breaks the TLS handshake.
    ...(isOutlookHost(cfg.host) ? { tls: { ciphers: "SSLv3" } } : {}),
  });
}

/** Point the module at a config, rebuilding the transport only when it changed. */
function adopt(cfg, source) {
  const next = signature(cfg);
  if (next === _sig) {
    _source = next ? source : "none";
    return;
  }
  _sig = next;
  // A pooled transport holds sockets open; drop the old one so a re-saved
  // mailbox does not leave the previous provider's connections dangling.
  if (_transport && typeof _transport.close === "function") {
    try {
      _transport.close();
    } catch {
      /* closing a never-connected transport is not an error worth surfacing */
    }
  }
  _transport = next ? buildTransport(cfg) : null;
  _source = next ? source : "none";
  _identity = cfg
    ? {
        fromName: cfg.fromName || "",
        // Most providers reject a From address the authenticated mailbox does
        // not own, so the username is the safe default rather than blank.
        fromEmail: cfg.fromEmail || cfg.username || "",
        replyTo: cfg.replyTo || "",
      }
    : { fromName: "", fromEmail: "", replyTo: "" };
}

/** Re-read PlatformSettings.email and adopt it, else fall back to the env. */
async function refresh() {
  try {
    // Required lazily: this service is pulled in by modules that load before
    // Mongoose models are registered.
    const PlatformSettings = require("../models/platformSettings");
    const s = await PlatformSettings.findOne({ key: "platform" }).select("email").lean();
    const cfg = s?.email;

    if (cfg?.enabled && cfg.host && cfg.username && cfg.passwordEnc) {
      const password = decrypt(cfg.passwordEnc);
      if (password) {
        adopt(
          {
            host: cfg.host,
            port: cfg.port,
            secure: cfg.secure,
            username: cfg.username,
            password,
            fromName: cfg.fromName,
            fromEmail: cfg.fromEmail,
            replyTo: cfg.replyTo,
          },
          "database",
        );
        _primed = true;
        return;
      }
      // Enabled with a password that will not decrypt means the key rotated
      // out from under the stored value. Say so — falling through silently
      // would look like "the console setting is being ignored".
      console.warn("[email] stored platform mailbox could not be decrypted — falling back to EMAIL_* env");
    }
    adopt(envConfig(), "env");
  } catch (err) {
    console.error("[email] platform mailbox refresh failed:", err.message);
    adopt(envConfig(), "env");
  } finally {
    _primed = true;
  }
}

/** Read the stored config once at boot. Safe to call more than once. */
async function prime() {
  if (_primed) return;
  await refresh();
}

/** Drop the cached transport so the next send re-reads the database. */
function invalidate() {
  _primed = false;
  _sig = "";
  if (_transport && typeof _transport.close === "function") {
    try {
      _transport.close();
    } catch {
      /* see adopt() */
    }
  }
  _transport = null;
  _source = "none";
  _identity = { fromName: "", fromEmail: "", replyTo: "" };
}

/**
 * The transport to send platform mail through, or null when nothing is
 * configured. Synchronous on purpose: the send path is synchronous everywhere
 * and prime() has already run at boot. If it hasn't (a script that never
 * called prime), fall back to the env rather than returning nothing.
 */
function activeTransport() {
  if (!_primed && !_transport) adopt(envConfig(), "env");
  return _transport;
}

function isEmailConfigured() {
  return !!activeTransport();
}

/** { fromName, fromEmail, replyTo } for the active mailbox. */
function getIdentity() {
  activeTransport();
  return { ..._identity };
}

/** "database" | "env" | "none" — for the console's status line. */
function describeSource() {
  activeTransport();
  return _source;
}

/**
 * Proxy over the active transport. Property access resolves lazily so a mailbox
 * saved in the console takes effect on the next send, with no restart.
 *
 * A send with nothing configured throws with a message naming the fix, rather
 * than nodemailer's "Missing credentials for PLAIN" three frames deeper.
 */
const transport = new Proxy(
  {},
  {
    get(_t, prop) {
      const t = activeTransport();
      if (!t) {
        // `then` is probed by the runtime whenever this object is awaited or
        // resolved; answering with a thrower turns any accidental await into a
        // confusing rejection, so report "not a thenable" instead.
        if (prop === "then") return undefined;
        throw new Error(
          "No platform mailbox configured. Add one in the SuperAdmin console (Platform Settings -> Email), or set EMAIL_USER and EMAIL_PASS.",
        );
      }
      const value = t[prop];
      return typeof value === "function" ? value.bind(t) : value;
    },
    has(_t, prop) {
      const t = activeTransport();
      return t ? prop in t : false;
    },
  },
);

module.exports = {
  transport,
  platformTransport: transport, // name used by services/tenantEmail.js
  buildTransport,
  defaultSmtpHost,
  isEmailConfigured,
  getIdentity,
  describeSource,
  invalidate,
  prime,
  refresh,
};
