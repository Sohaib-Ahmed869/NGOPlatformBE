const PlatformSettings = require("../models/platformSettings");
const { encrypt, decrypt } = require("../utils/crypto");
const platformEmail = require("../services/platformEmail");
const writeAudit = require("../utils/writeAudit");

/**
 * Platform-level SMTP credentials — the mailbox every transactional email
 * leaves from unless the sending tenant has connected their own. The
 * tenant-level equivalent lives in the organisation's email settings; the
 * closest sibling in shape and in rules is platformStripeController.js.
 *
 * Rules this file exists to enforce:
 *  - A password never leaves the server. Responses carry a masked hint only.
 *  - A mailbox that does not authenticate is never ENABLED. Saving a broken one
 *    silently stops every receipt, every registration email and every operator
 *    notice at once, and the failure surfaces hours later in the send log
 *    rather than here. So the save path verifies against the SMTP server first,
 *    the way the Stripe save verifies against Stripe first.
 *  - Disabling is always allowed without verification: an operator has to be
 *    able to turn a broken mailbox off and fall back to the environment.
 */

// Deliberately permissive: corporate SMTP hosts are frequently bare hostnames
// or IPs, and a strict FQDN pattern rejects perfectly valid internal relays.
const RE_HOST = /^[A-Za-z0-9._-]+$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "ab••••••yz" — enough to tell two passwords apart, useless on its own. */
function maskSecret(v) {
  if (!v) return "";
  if (v.length <= 4) return "•".repeat(8);
  return `${v.slice(0, 2)}${"•".repeat(8)}${v.slice(-2)}`;
}

/**
 * Load ONLY the email sub-document (creating the singleton if missing).
 * getSingleton() pulls branding, socials and the plan-bullet library too, none
 * of which this controller touches.
 */
async function loadEmailDoc() {
  const doc = await PlatformSettings.findOne({ key: "platform" }).select("email");
  return doc || PlatformSettings.create({ key: "platform" });
}

/** Exactly what the console is allowed to see. Contains no secret material. */
function maskedConfig(s) {
  const c = s.email || {};
  const source = platformEmail.describeSource();
  const identity = platformEmail.getIdentity();
  // Enabled with a stored password, yet the resolver is NOT using the database
  // → the ciphertext will not decrypt (PAYMENT_ENC_KEY rotated) or the read
  // failed. Derived from the resolver rather than by decrypting here, so the
  // read path stays free of plaintext and this reflects what the server is
  // actually doing rather than what the row claims.
  const passwordBroken = !!c.enabled && !!c.passwordEnc && source !== "database";

  return {
    enabled: !!c.enabled,
    host: c.host || "",
    port: c.port || 587,
    secure: !!c.secure,
    username: c.username || "",
    hasPassword: !!c.passwordEnc,
    passwordMask: c.passwordMask || "",
    passwordBroken,
    fromName: c.fromName || "",
    fromEmail: c.fromEmail || "",
    replyTo: c.replyTo || "",
    lastVerifiedAt: c.lastVerifiedAt || null,
    lastVerifyError: c.lastVerifyError || "",
    // Which mailbox the running server is ACTUALLY using. Without this the
    // screen cannot tell "saved and live" from "saved but the server is still
    // on the environment mailbox".
    runtime: {
      source, // "database" | "env" | "none"
      configured: platformEmail.isEmailConfigured(),
      fromEmail: identity.fromEmail || "",
      fromName: identity.fromName || "",
      // So the screen can say "you can turn this off and still send".
      envAvailable: !!(process.env.EMAIL_USER && process.env.EMAIL_PASS),
    },
  };
}

/** Verify a config against the real SMTP server. Returns { ok, error }. */
async function verifyConfig(cfg) {
  const transport = platformEmail.buildTransport(cfg);
  try {
    await transport.verify();
    return { ok: true, error: "" };
  } catch (err) {
    // Nodemailer's messages are already the provider's own words ("535
    // Authentication unsuccessful", "getaddrinfo ENOTFOUND"). Pass them
    // through: a generic "could not connect" hides the one useful detail.
    return { ok: false, error: err.message || "Could not connect" };
  } finally {
    try {
      transport.close();
    } catch {
      /* a transport that never connected has nothing to close */
    }
  }
}

/** GET /api/platform/settings/email  (superadmin) */
exports.getConfig = async (req, res) => {
  try {
    const s = await loadEmailDoc();
    // Self-heal rows saved before the mask existed: decrypt once, persist the
    // hint, and never decrypt on a read again.
    if (s.email?.passwordEnc && !s.email.passwordMask) {
      const plain = decrypt(s.email.passwordEnc);
      if (plain) {
        s.email.passwordMask = maskSecret(plain);
        s.markModified("email");
        await s.save();
      }
    }
    res.json(maskedConfig(s));
  } catch (error) {
    console.error("Get platform email config error:", error);
    res.status(500).json({ error: "Failed to load email configuration" });
  }
};

/**
 * PUT /api/platform/settings/email  (superadmin)
 * A blank password means "leave unchanged" — the client never receives it, so
 * it cannot echo it back.
 */
exports.updateConfig = async (req, res) => {
  try {
    const b = req.body || {};
    const s = await loadEmailDoc();
    const cur = s.email || {};

    const host = b.host !== undefined ? String(b.host).trim() : cur.host || "";
    const username = b.username !== undefined ? String(b.username).trim() : cur.username || "";
    const password = typeof b.password === "string" ? b.password : "";
    const port = b.port !== undefined ? Number(b.port) : cur.port || 587;
    const secure = b.secure !== undefined ? !!b.secure : !!cur.secure;
    const fromEmail = b.fromEmail !== undefined ? String(b.fromEmail).trim() : cur.fromEmail || "";
    const replyTo = b.replyTo !== undefined ? String(b.replyTo).trim() : cur.replyTo || "";
    const fromName = b.fromName !== undefined ? String(b.fromName).trim() : cur.fromName || "";
    const enabled = b.enabled !== undefined ? !!b.enabled : !!cur.enabled;

    if (host && !RE_HOST.test(host)) {
      return res.status(400).json({ error: "That host does not look like a server name — use a hostname such as smtp.gmail.com, with no protocol or path." });
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: "Port must be a whole number between 1 and 65535 (usually 587, or 465 for implicit TLS)." });
    }
    if (username && !RE_EMAIL.test(username) && username.includes("@")) {
      return res.status(400).json({ error: "That username does not look like a valid email address." });
    }
    for (const [label, value] of [["From address", fromEmail], ["Reply-to address", replyTo]]) {
      if (value && !RE_EMAIL.test(value)) {
        return res.status(400).json({ error: `That ${label.toLowerCase()} does not look like a valid email address.` });
      }
    }

    // The password that will be in force after this save.
    const effectivePassword = password || (cur.passwordEnc ? decrypt(cur.passwordEnc) : "");

    // Enabling is the dangerous direction, so it is the one that gets verified.
    // Turning the mailbox OFF must always be possible, including when it is off
    // precisely because it no longer authenticates.
    if (enabled) {
      if (!host || !username || !effectivePassword) {
        return res.status(400).json({ error: "Host, username and password are all required before this mailbox can be enabled." });
      }
      const check = await verifyConfig({ host, port, secure, username, password: effectivePassword });
      if (!check.ok) {
        s.email = { ...cur, lastVerifyError: check.error };
        s.markModified("email");
        await s.save();
        return res.status(400).json({
          error: `That mailbox did not accept the connection: ${check.error}`,
          hint:
            port === 465 && !secure
              ? "Port 465 needs implicit TLS — turn on \"Use TLS\"."
              : port === 587 && secure
                ? "Port 587 uses STARTTLS — turn OFF \"Use TLS\"."
                : undefined,
        });
      }
    }

    const next = {
      enabled,
      host,
      port,
      secure,
      username,
      passwordEnc: password ? encrypt(password) : cur.passwordEnc || "",
      passwordMask: password ? maskSecret(password) : cur.passwordMask || "",
      fromName,
      // Most providers reject a From the authenticated mailbox does not own, so
      // an empty value follows the username rather than staying blank.
      fromEmail: fromEmail || username,
      replyTo,
      lastVerifiedAt: enabled ? new Date() : cur.lastVerifiedAt,
      lastVerifyError: "",
    };

    s.email = next;
    s.markModified("email");
    await s.save();

    // Drop the cached transport so the very next send uses the new mailbox —
    // this is what makes the console screen work without a restart.
    platformEmail.invalidate();
    await platformEmail.prime();

    await writeAudit(req, enabled ? "platform.email_configured" : "platform.email_disabled", {
      targetType: "platform",
      targetId: "email",
      // Never the password, and never the ciphertext.
      meta: { host, port, secure, username, fromEmail: next.fromEmail, enabled },
    });

    const fresh = await loadEmailDoc();
    res.json({ config: maskedConfig(fresh) });
  } catch (error) {
    console.error("Update platform email config error:", error);
    res.status(500).json({ error: "Failed to save email configuration" });
  }
};

/**
 * POST /api/platform/settings/email/test  (superadmin)
 * Body: { to?, host?, port?, secure?, username?, password? }
 *
 * With credentials in the body, tests what the operator has TYPED but not yet
 * saved — the point being to get the settings right before committing them.
 * With none, tests the mailbox the server is actually running on, whether that
 * came from the database or the environment.
 * With `to`, actually delivers a message: verify() only proves the login works,
 * not that mail arrives, and "authenticated fine, delivered nothing" is a real
 * and common state (blocked sender, unverified domain).
 */
exports.testConnection = async (req, res) => {
  try {
    const b = req.body || {};
    const typed = !!(b.host && b.username);
    let cfg;

    if (typed) {
      const password = b.password || "";
      if (!password) {
        // The saved password is reused so an operator can re-test a stored
        // mailbox after changing only its host or port.
        const s = await loadEmailDoc();
        const stored = s.email?.passwordEnc ? decrypt(s.email.passwordEnc) : "";
        if (!stored) return res.status(400).json({ error: "Enter the mailbox password to test these settings." });
        cfg = { host: b.host, port: Number(b.port) || 587, secure: !!b.secure, username: b.username, password: stored };
      } else {
        cfg = { host: b.host, port: Number(b.port) || 587, secure: !!b.secure, username: b.username, password };
      }
    } else if (!platformEmail.isEmailConfigured()) {
      return res.status(400).json({ error: "No mailbox to test — enter SMTP settings above, or save one first." });
    }

    const to = typeof b.to === "string" ? b.to.trim() : "";
    if (to && !RE_EMAIL.test(to)) {
      return res.status(400).json({ error: "That test recipient does not look like a valid email address." });
    }

    // ── typed-but-unsaved settings ────────────────────────────────────────
    if (cfg) {
      const check = await verifyConfig(cfg);
      if (!check.ok) return res.status(400).json({ ok: false, error: check.error });
      if (!to) return res.json({ ok: true, delivered: false, message: "Connected and authenticated." });

      const transport = platformEmail.buildTransport(cfg);
      try {
        await transport.sendMail({
          from: `"${b.fromName || "Platform"}" <${b.fromEmail || cfg.username}>`,
          to,
          subject: "Test email from your platform console",
          text: `This is a test message sent from the SuperAdmin console.\n\nHost: ${cfg.host}:${cfg.port}\nMailbox: ${cfg.username}\n\nIf you received this, the mailbox is configured correctly.`,
        });
        return res.json({ ok: true, delivered: true, message: `Test email sent to ${to}.` });
      } finally {
        try {
          transport.close();
        } catch {
          /* nothing to close */
        }
      }
    }

    // ── the mailbox the server is actually running on ─────────────────────
    const identity = platformEmail.getIdentity();
    if (!to) {
      // The proxy resolves the live transport; verify() proves the login.
      await platformEmail.transport.verify();
      const s = await loadEmailDoc();
      if (s.email?.enabled) {
        s.email.lastVerifiedAt = new Date();
        s.email.lastVerifyError = "";
        s.markModified("email");
        await s.save();
      }
      const fresh = await loadEmailDoc();
      return res.json({ ok: true, delivered: false, message: "Connected and authenticated.", config: maskedConfig(fresh) });
    }

    await platformEmail.transport.sendMail({
      from: `"${identity.fromName || "Platform"}" <${identity.fromEmail}>`,
      to,
      subject: "Test email from your platform console",
      text: `This is a test message sent from the SuperAdmin console.\n\nSending mailbox: ${identity.fromEmail}\nSource: ${platformEmail.describeSource()}\n\nIf you received this, the platform mailbox is working.`,
    });
    return res.json({ ok: true, delivered: true, message: `Test email sent to ${to}.` });
  } catch (error) {
    console.error("Platform email test error:", error);
    res.status(400).json({ ok: false, error: error.message || "Test failed" });
  }
};

/**
 * DELETE /api/platform/settings/email  (superadmin)
 * Clears the stored mailbox entirely and drops back to the EMAIL_* environment
 * variables. Not the same as disabling: disabling keeps the credentials so they
 * can be switched back on.
 */
exports.clearConfig = async (req, res) => {
  try {
    const s = await loadEmailDoc();
    s.email = {
      enabled: false,
      host: "",
      port: 587,
      secure: false,
      username: "",
      passwordEnc: "",
      passwordMask: "",
      fromName: "",
      fromEmail: "",
      replyTo: "",
      lastVerifiedAt: null,
      lastVerifyError: "",
    };
    s.markModified("email");
    await s.save();

    platformEmail.invalidate();
    await platformEmail.prime();

    await writeAudit(req, "platform.email_cleared", { targetType: "platform", targetId: "email" });
    const fresh = await loadEmailDoc();
    res.json({ config: maskedConfig(fresh) });
  } catch (error) {
    console.error("Clear platform email config error:", error);
    res.status(500).json({ error: "Failed to clear email configuration" });
  }
};
