// Mailbox service — owns the sending identities used for marketing campaigns:
// verifying credentials, building/caching nodemailer transports, atomic quota
// reservation with ROTATION across a tenant's mailboxes, and the rate-limit
// cooldown back-off that protects sender reputation.
const nodemailer = require("nodemailer");
const Mailbox = require("../models/Mailbox");
const { encrypt, decrypt } = require("../utils/crypto");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const COOLDOWN_MINUTES = 10; // back-off after a provider rate-limit signal

// Cache built transports by config signature so we don't rebuild one per send.
const transportCache = new Map();

/** Build a nodemailer transport from a plain SMTP config (decrypted password). */
function buildTransport(cfg) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port) || 587,
    secure: !!cfg.secure,
    auth: { user: cfg.username, pass: cfg.password },
  });
}

/** Resolve (and cache) the transport for a mailbox doc. Returns null if the
 *  stored password can't be decrypted. */
function getTransport(mailbox) {
  const password = decrypt(mailbox.smtp?.passwordEnc);
  if (!password) return null;
  const s = mailbox.smtp;
  const sig = [mailbox._id, s.host, s.port, s.secure, s.username, password].join("|");
  if (!transportCache.has(sig)) {
    transportCache.set(sig, buildTransport({ host: s.host, port: s.port, secure: s.secure, username: s.username, password }));
  }
  return transportCache.get(sig);
}

/** Drop a mailbox's cached transport (after a config change or cooldown). */
function evictTransport(mailbox) {
  for (const key of transportCache.keys()) {
    if (key.startsWith(`${mailbox._id}|`)) transportCache.delete(key);
  }
}

/** The From identity for a mailbox (falls back to the SMTP username). */
function fromIdentity(mailbox) {
  const fromEmail = mailbox.fromEmail || mailbox.smtp?.username || "";
  const fromName = mailbox.fromName || "";
  return { fromName, fromEmail, replyTo: mailbox.replyTo || "" };
}

/** Strip secrets before returning a mailbox to any client. */
function sanitize(mailbox) {
  const m = mailbox.toObject ? mailbox.toObject() : mailbox;
  const { smtp = {}, ...rest } = m;
  return {
    ...rest,
    smtp: { host: smtp.host || "", port: smtp.port || 587, secure: !!smtp.secure, username: smtp.username || "" },
    hasPassword: !!smtp.passwordEnc,
  };
}

/** Verify SMTP credentials live before we save/trust them. Throws on failure. */
async function verifyCredentials({ host, port, secure, username, password }) {
  const transport = buildTransport({ host, port, secure, username, password });
  await transport.verify();
  return true;
}

/**
 * Lazily reset a mailbox's rolling counters when their window has elapsed, and
 * clear an expired cooldown. Returns the (possibly) refreshed doc.
 */
async function rollover(mailbox) {
  const now = Date.now();
  const set = {};
  if (now - new Date(mailbox.usage.hourResetAt).getTime() >= HOUR_MS) {
    set["usage.sentThisHour"] = 0;
    set["usage.hourResetAt"] = new Date(now);
  }
  if (now - new Date(mailbox.usage.dayResetAt).getTime() >= DAY_MS) {
    set["usage.sentToday"] = 0;
    set["usage.dayResetAt"] = new Date(now);
  }
  if (mailbox.healthStatus === "cooldown" && (!mailbox.cooldownUntil || new Date(mailbox.cooldownUntil).getTime() <= now)) {
    set["healthStatus"] = "healthy";
    set["cooldownUntil"] = null;
  }
  if (!Object.keys(set).length) return mailbox;
  return Mailbox.findByIdAndUpdate(mailbox._id, { $set: set }, { new: true });
}

/**
 * Reserve one send slot for an organisation, rotating to the least-loaded
 * healthy mailbox that's under both its hourly and daily limits. The increment
 * is atomic (findOneAndUpdate) so concurrent sends can't overshoot a limit.
 * Returns the reserved mailbox doc, or null if every mailbox is exhausted /
 * cooling down (caller should pause).
 */
async function reserveQuota(organisationId) {
  let candidates = await Mailbox.find({ organisationId, isActive: true });
  if (!candidates.length) return null;
  candidates = await Promise.all(candidates.map(rollover));

  const now = Date.now();
  const available = candidates.filter(
    (m) =>
      m.healthStatus !== "unhealthy" &&
      !(m.healthStatus === "cooldown" && m.cooldownUntil && new Date(m.cooldownUntil).getTime() > now) &&
      m.usage.sentToday < m.quotaConfig.dailyLimit &&
      m.usage.sentThisHour < m.quotaConfig.hourlyLimit &&
      !!decrypt(m.smtp?.passwordEnc)
  );
  if (!available.length) return null;

  // Rotation: prefer the mailbox least used this hour, then today, then the one
  // unused longest — spreads load evenly across all connected mailboxes.
  available.sort(
    (a, b) =>
      a.usage.sentThisHour - b.usage.sentThisHour ||
      a.usage.sentToday - b.usage.sentToday ||
      new Date(a.lastUsedAt || 0) - new Date(b.lastUsedAt || 0)
  );

  for (const m of available) {
    const reserved = await Mailbox.findOneAndUpdate(
      {
        _id: m._id,
        isActive: true,
        healthStatus: { $ne: "unhealthy" },
        "usage.sentToday": { $lt: m.quotaConfig.dailyLimit },
        "usage.sentThisHour": { $lt: m.quotaConfig.hourlyLimit },
      },
      { $inc: { "usage.sentToday": 1, "usage.sentThisHour": 1 }, $set: { lastUsedAt: new Date(now) } },
      { new: true }
    );
    if (reserved) return reserved; // won the race for this mailbox
  }
  return null; // everything got reserved out from under us this tick
}

/** Give a reserved slot back (e.g. the send hit a rate limit and was re-queued). */
async function releaseQuota(mailboxId) {
  await Mailbox.findByIdAndUpdate(mailboxId, { $inc: { "usage.sentToday": -1, "usage.sentThisHour": -1 } });
}

/** Put a mailbox into a timed cooldown after a provider rate-limit signal. */
async function setCooldown(mailbox, reason, minutes = COOLDOWN_MINUTES) {
  evictTransport(mailbox);
  await Mailbox.findByIdAndUpdate(mailbox._id, {
    $set: {
      healthStatus: "cooldown",
      cooldownUntil: new Date(Date.now() + minutes * 60 * 1000),
      lastError: reason || "Rate limited by provider",
    },
  });
}

/** Mark a mailbox unhealthy (hard failure like bad credentials) until fixed. */
async function markUnhealthy(mailbox, reason) {
  evictTransport(mailbox);
  await Mailbox.findByIdAndUpdate(mailbox._id, {
    $set: { healthStatus: "unhealthy", lastError: reason || "Mailbox error" },
  });
}

/**
 * Classify an SMTP send error so the sender can react correctly:
 *  - rate_limit → cool the mailbox down and retry the recipient elsewhere
 *  - auth       → mailbox is broken (bad app-password) → mark unhealthy
 *  - hard_bounce→ recipient is undeliverable (5xx)
 *  - soft_bounce→ transient (4xx) — count as failed for now
 */
function classifySmtpError(err) {
  const code = Number(err?.responseCode || err?.code);
  const msg = String(err?.response || err?.message || "").toLowerCase();
  if (/rate|too many|throttl|try again later|quota|temporarily deferred|limit exceeded|4\.7\.0/.test(msg)) {
    return "rate_limit";
  }
  if (/invalid login|authenticat|credential|username and password|535|534/.test(msg)) return "auth";
  if (code >= 500 && code < 600) return "hard_bounce";
  if (code >= 400 && code < 500) return "soft_bounce";
  return "unknown";
}

/** Send one message through a specific mailbox's transport. Throws on failure. */
async function sendViaMailbox(mailbox, { to, subject, html, text, headers }) {
  const transport = getTransport(mailbox);
  if (!transport) throw new Error("Mailbox password could not be decrypted");
  const { fromName, fromEmail, replyTo } = fromIdentity(mailbox);
  const mailOptions = {
    from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
    to,
    subject,
    html,
    ...(text ? { text } : {}),
    ...(headers ? { headers } : {}),
  };
  if (replyTo) mailOptions.replyTo = replyTo;
  return transport.sendMail(mailOptions);
}

module.exports = {
  buildTransport,
  getTransport,
  evictTransport,
  fromIdentity,
  sanitize,
  verifyCredentials,
  rollover,
  reserveQuota,
  releaseQuota,
  setCooldown,
  markUnhealthy,
  classifySmtpError,
  sendViaMailbox,
  encryptPassword: encrypt,
};
