// Admin management of a tenant's sending mailboxes (marketing/newsletter).
// Credentials are verified live before they're trusted and the password is
// AES-256-GCM encrypted; it is never returned to the client.
const Mailbox = require("../models/Mailbox");
const mailboxSvc = require("../services/mailbox.service");

const orgOf = (req) => req.organisation?._id || null;

/** GET /api/admin/mailboxes — list this tenant's mailboxes (sanitised). */
exports.list = async (req, res) => {
  try {
    const orgId = orgOf(req);
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });
    const boxes = await Mailbox.find({ organisationId: orgId }).sort({ isDefault: -1, createdAt: 1 });
    res.json(boxes.map(mailboxSvc.sanitize));
  } catch (e) {
    console.error("List mailboxes error:", e);
    res.status(500).json({ error: "Failed to load mailboxes" });
  }
};

/** POST /api/admin/mailboxes — verify credentials, then connect a new mailbox. */
exports.create = async (req, res) => {
  try {
    const orgId = orgOf(req);
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const { label, host, port, secure, username, password, fromName, fromEmail, replyTo, quotaConfig } = req.body;
    if (!host || !username || !password) {
      return res.status(400).json({ error: "SMTP host, username and password are required" });
    }

    // Don't save credentials we can't actually authenticate with.
    try {
      await mailboxSvc.verifyCredentials({ host, port, secure, username, password });
    } catch (err) {
      return res.status(400).json({ error: err.message || "Could not connect with those SMTP settings" });
    }

    const isFirst = (await Mailbox.countDocuments({ organisationId: orgId })) === 0;
    const mailbox = await Mailbox.create({
      organisationId: orgId,
      label: (label || username || "").trim(),
      smtp: {
        host: String(host).trim(),
        port: Number(port) || 587,
        secure: !!secure,
        username: String(username).trim(),
        passwordEnc: mailboxSvc.encryptPassword(String(password).trim()),
      },
      fromName: (fromName || "").trim(),
      fromEmail: (fromEmail || "").trim(),
      replyTo: (replyTo || "").trim(),
      ...(quotaConfig ? { quotaConfig } : {}),
      lastVerifiedAt: new Date(),
      isDefault: isFirst,
    });
    res.status(201).json(mailboxSvc.sanitize(mailbox));
  } catch (e) {
    console.error("Create mailbox error:", e);
    res.status(500).json({ error: "Failed to connect mailbox" });
  }
};

async function loadOwned(req, res) {
  const orgId = orgOf(req);
  const mailbox = await Mailbox.findOne({ _id: req.params.id, organisationId: orgId });
  if (!mailbox) {
    res.status(404).json({ error: "Mailbox not found" });
    return null;
  }
  return mailbox;
}

/** PUT /api/admin/mailboxes/:id — update settings/quota (blank password = keep). */
exports.update = async (req, res) => {
  try {
    const mailbox = await loadOwned(req, res);
    if (!mailbox) return;
    const { label, host, port, secure, username, password, fromName, fromEmail, replyTo, quotaConfig, isActive } = req.body;

    if (label !== undefined) mailbox.label = String(label).trim();
    if (host !== undefined) mailbox.smtp.host = String(host).trim();
    if (port !== undefined) mailbox.smtp.port = Number(port) || 587;
    if (secure !== undefined) mailbox.smtp.secure = !!secure;
    if (username !== undefined) mailbox.smtp.username = String(username).trim();
    if (fromName !== undefined) mailbox.fromName = String(fromName).trim();
    if (fromEmail !== undefined) mailbox.fromEmail = String(fromEmail).trim();
    if (replyTo !== undefined) mailbox.replyTo = String(replyTo).trim();
    if (quotaConfig?.dailyLimit !== undefined) mailbox.quotaConfig.dailyLimit = Math.max(1, Number(quotaConfig.dailyLimit) || 500);
    if (quotaConfig?.hourlyLimit !== undefined) mailbox.quotaConfig.hourlyLimit = Math.max(1, Number(quotaConfig.hourlyLimit) || 20);
    if (isActive !== undefined) mailbox.isActive = !!isActive;

    const newPassword = typeof password === "string" && password.trim() ? password.trim() : null;

    // Re-verify whenever credentials change so a broken mailbox can't be saved.
    if (newPassword || host !== undefined || username !== undefined || port !== undefined || secure !== undefined) {
      const { decrypt } = require("../utils/crypto");
      const pw = newPassword || decrypt(mailbox.smtp.passwordEnc);
      if (mailbox.smtp.host && mailbox.smtp.username && pw) {
        try {
          await mailboxSvc.verifyCredentials({
            host: mailbox.smtp.host,
            port: mailbox.smtp.port,
            secure: mailbox.smtp.secure,
            username: mailbox.smtp.username,
            password: pw,
          });
          mailbox.lastVerifiedAt = new Date();
          mailbox.healthStatus = "healthy";
          mailbox.cooldownUntil = null;
          mailbox.lastError = "";
        } catch (err) {
          return res.status(400).json({ error: err.message || "Could not connect with the updated SMTP settings" });
        }
      }
    }
    if (newPassword) mailbox.smtp.passwordEnc = mailboxSvc.encryptPassword(newPassword);

    mailboxSvc.evictTransport(mailbox);
    await mailbox.save();
    res.json(mailboxSvc.sanitize(mailbox));
  } catch (e) {
    console.error("Update mailbox error:", e);
    res.status(500).json({ error: "Failed to update mailbox" });
  }
};

/** POST /api/admin/mailboxes/:id/test — send a test email to the admin. */
exports.test = async (req, res) => {
  try {
    const mailbox = await loadOwned(req, res);
    if (!mailbox) return;
    const to = req.user?.email || mailbox.fromEmail || mailbox.smtp.username;
    try {
      await mailboxSvc.sendViaMailbox(mailbox, {
        to,
        subject: "Test email — your mailbox is connected ✅",
        html: "<p>This is a test from your newsletter mailbox. Campaigns will send from here.</p>",
        text: "This is a test from your newsletter mailbox. Campaigns will send from here.",
      });
      await Mailbox.findByIdAndUpdate(mailbox._id, { $set: { lastVerifiedAt: new Date(), healthStatus: "healthy", cooldownUntil: null, lastError: "" } });
      res.json({ ok: true, sentTo: to });
    } catch (err) {
      const kind = mailboxSvc.classifySmtpError(err);
      if (kind === "auth") await mailboxSvc.markUnhealthy(mailbox, err.message);
      res.status(400).json({ ok: false, error: err.message || "Test send failed" });
    }
  } catch (e) {
    console.error("Test mailbox error:", e);
    res.status(500).json({ error: "Failed to send test" });
  }
};

/** POST /api/admin/mailboxes/:id/default — make this the default sending mailbox. */
exports.setDefault = async (req, res) => {
  try {
    const orgId = orgOf(req);
    const mailbox = await loadOwned(req, res);
    if (!mailbox) return;
    await Mailbox.updateMany({ organisationId: orgId }, { $set: { isDefault: false } });
    mailbox.isDefault = true;
    await mailbox.save();
    res.json(mailboxSvc.sanitize(mailbox));
  } catch (e) {
    console.error("Set default mailbox error:", e);
    res.status(500).json({ error: "Failed to set default mailbox" });
  }
};

/** DELETE /api/admin/mailboxes/:id — remove a mailbox. */
exports.remove = async (req, res) => {
  try {
    const orgId = orgOf(req);
    const mailbox = await loadOwned(req, res);
    if (!mailbox) return;
    mailboxSvc.evictTransport(mailbox);
    await mailbox.deleteOne();
    // If we removed the default, promote the next remaining mailbox.
    if (mailbox.isDefault) {
      const next = await Mailbox.findOne({ organisationId: orgId }).sort({ createdAt: 1 });
      if (next) {
        next.isDefault = true;
        await next.save();
      }
    }
    res.json({ message: "Mailbox removed", id: req.params.id });
  } catch (e) {
    console.error("Remove mailbox error:", e);
    res.status(500).json({ error: "Failed to remove mailbox" });
  }
};
