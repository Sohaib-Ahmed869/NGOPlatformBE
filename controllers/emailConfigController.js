const Organisation = require("../models/organisation");
const { encrypt, decrypt } = require("../utils/crypto");
const { buildTransport } = require("../services/tenantEmail");

/** Shape returned to the admin client — NEVER includes the SMTP password. */
function maskedConfig(org) {
  const e = org.email || {};
  return {
    enabled: !!e.enabled,
    host: e.host || "",
    port: e.port || 587,
    secure: !!e.secure,
    username: e.username || "",
    hasPassword: !!e.passwordEnc,
    fromName: e.fromName || "",
    fromEmail: e.fromEmail || "",
    replyTo: e.replyTo || "",
    accountLabel: e.accountLabel || "",
    lastVerifiedAt: e.lastVerifiedAt || null,
  };
}

/** GET /api/admin/email-config */
exports.getConfig = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });
    const org = await Organisation.findById(orgId).select("email");
    if (!org) return res.status(404).json({ error: "Organisation not found" });
    res.json(maskedConfig(org));
  } catch (error) {
    console.error("Get email config error:", error);
    res.status(500).json({ error: "Failed to fetch email configuration" });
  }
};

/**
 * PUT /api/admin/email-config
 * Save SMTP settings. An empty password means "leave unchanged". Enabling
 * requires a host, username and a stored (or just-supplied) password.
 */
exports.updateConfig = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const { host, port, secure, username, password, fromName, fromEmail, replyTo, enabled } = req.body;
    const org = await Organisation.findById(orgId);
    if (!org) return res.status(404).json({ error: "Organisation not found" });

    const set = {};
    if (host !== undefined) set["email.host"] = String(host).trim();
    if (port !== undefined) set["email.port"] = Number(port) || 587;
    if (secure !== undefined) set["email.secure"] = !!secure;
    if (username !== undefined) set["email.username"] = String(username).trim();
    if (fromName !== undefined) set["email.fromName"] = String(fromName).trim();
    if (fromEmail !== undefined) set["email.fromEmail"] = String(fromEmail).trim();
    if (replyTo !== undefined) set["email.replyTo"] = String(replyTo).trim();
    if (typeof password === "string" && password.trim()) {
      set["email.passwordEnc"] = encrypt(password.trim());
    }

    if (enabled !== undefined) {
      const willHavePassword = set["email.passwordEnc"] || org.email?.passwordEnc;
      const willHaveHost = set["email.host"] !== undefined ? set["email.host"] : org.email?.host;
      const willHaveUser = set["email.username"] !== undefined ? set["email.username"] : org.email?.username;
      if (enabled && (!willHavePassword || !willHaveHost || !willHaveUser)) {
        return res.status(400).json({
          error: "Add an SMTP host, username and password before enabling email.",
        });
      }
      set["email.enabled"] = !!enabled;
    }

    const updated = await Organisation.findByIdAndUpdate(orgId, { $set: set }, { new: true }).select("email");
    res.json({ message: "Email configuration saved", config: maskedConfig(updated) });
  } catch (error) {
    console.error("Update email config error:", error);
    res.status(500).json({ error: "Failed to save email configuration" });
  }
};

/**
 * POST /api/admin/email-config/test
 * Verify the SMTP connection and (best-effort) send a test email to the admin.
 * Uses the just-supplied password if present, otherwise the stored one.
 */
exports.testConnection = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const org = await Organisation.findById(orgId);
    const e = org.email || {};
    const password =
      typeof req.body.password === "string" && req.body.password.trim()
        ? req.body.password.trim()
        : decrypt(e.passwordEnc);

    const host = req.body.host || e.host;
    const username = req.body.username || e.username;
    if (!host || !username || !password) {
      return res.status(400).json({ ok: false, error: "Add and save your SMTP host, username and password first." });
    }

    const transport = buildTransport({
      host,
      port: req.body.port || e.port,
      secure: req.body.secure !== undefined ? req.body.secure : e.secure,
      username,
      password,
    });

    await transport.verify();

    // Best-effort test email to the admin who is configuring it.
    const to = req.user?.email || e.fromEmail || username;
    let delivered = false;
    try {
      await transport.sendMail({
        from: `"${e.fromName || org.name || "Your Charity"}" <${e.fromEmail || username}>`,
        to,
        subject: "Test email — your SMTP is connected ✅",
        text: "This is a test email confirming your SMTP settings work. You can now send receipts and notifications from your own email.",
        html: "<p>This is a test email confirming your SMTP settings work.</p><p>You can now send receipts and notifications from your own email.</p>",
      });
      delivered = true;
    } catch (sendErr) {
      console.warn("SMTP verified but test send failed:", sendErr.message);
    }

    const label = `${username}`;
    await Organisation.findByIdAndUpdate(orgId, {
      $set: { "email.accountLabel": label, "email.lastVerifiedAt": new Date() },
    });

    res.json({ ok: true, accountLabel: label, delivered, sentTo: delivered ? to : null });
  } catch (error) {
    console.error("SMTP test connection error:", error.message);
    res.status(400).json({ ok: false, error: error.message || "Could not connect with those SMTP settings" });
  }
};

/** DELETE /api/admin/email-config — disable and clear stored SMTP credentials. */
exports.clearConfig = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });
    await Organisation.findByIdAndUpdate(orgId, {
      $set: {
        "email.enabled": false,
        "email.host": "",
        "email.username": "",
        "email.passwordEnc": "",
        "email.accountLabel": "",
        "email.lastVerifiedAt": null,
      },
    });
    res.json({ message: "Email configuration cleared" });
  } catch (error) {
    console.error("Clear email config error:", error);
    res.status(500).json({ error: "Failed to clear email configuration" });
  }
};
