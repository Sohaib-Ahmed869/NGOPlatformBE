// controllers/mailchimpController.js — per-tenant Mailchimp connection management.
const crypto = require("crypto");
const Organisation = require("../models/organisation");
const NewsletterSubscription = require("../models/newsletter");
const { encrypt, decrypt } = require("../utils/crypto");
const mc = require("../services/mailchimp");

const orgId = (req) => req.organisation?._id;
const mcError = (e) => e?.response?.data?.detail || e?.message || "Mailchimp request failed";

// Client-facing connection state — NEVER includes the API key.
function statusOf(org) {
  const m = org.mailchimp || {};
  return {
    connected: !!m.apiKeyEnc,
    ready: !!(m.apiKeyEnc && m.audienceId && m.fromEmail),
    accountLabel: m.accountLabel || "",
    serverPrefix: m.serverPrefix || "",
    audienceId: m.audienceId || "",
    audienceName: m.audienceName || "",
    fromName: m.fromName || "",
    fromEmail: m.fromEmail || "",
    lastVerifiedAt: m.lastVerifiedAt || null,
    webhookRegistered: !!m.webhookId,
    webhookUrl: mc.webhookUrl(org._id, m.webhookSecret),
    // Returned so the settings UI can always build a usable webhook URL even
    // when PUBLIC_API_URL isn't set on the server (admin-only endpoint).
    webhookSecret: m.webhookSecret || "",
    orgId: String(org._id),
  };
}

exports.getStatus = async (req, res) => {
  try {
    const org = await Organisation.findById(orgId(req)).select("mailchimp name");
    if (!org) return res.status(404).json({ error: "Organisation not found" });
    const out = statusOf(org);
    if (out.connected) {
      try {
        out.audiences = await mc.listAudiences(decrypt(org.mailchimp.apiKeyEnc), org.mailchimp.serverPrefix);
      } catch (e) {
        out.audiences = [];
        out.audienceError = mcError(e);
      }
    }
    res.json(out);
  } catch (e) {
    console.error("Mailchimp status error:", e);
    res.status(500).json({ error: "Failed to load Mailchimp status" });
  }
};

exports.connect = async (req, res) => {
  try {
    const apiKey = (req.body.apiKey || "").trim();
    if (!apiKey) return res.status(400).json({ error: "API key is required" });
    const serverPrefix = mc.prefixFromKey(apiKey);
    if (!serverPrefix) return res.status(400).json({ error: "That doesn't look like a valid Mailchimp API key" });

    const info = await mc.verify(apiKey, serverPrefix); // throws on invalid key
    const audiences = await mc.listAudiences(apiKey, serverPrefix);

    await Organisation.findByIdAndUpdate(orgId(req), {
      $set: {
        "mailchimp.apiKeyEnc": encrypt(apiKey),
        "mailchimp.serverPrefix": serverPrefix,
        "mailchimp.accountLabel": info.accountLabel,
        "mailchimp.connected": true,
        "mailchimp.lastVerifiedAt": new Date(),
        // Secret guards our inbound webhook URL.
        "mailchimp.webhookSecret": crypto.randomBytes(20).toString("hex"),
      },
    });
    res.json({ ok: true, accountLabel: info.accountLabel, audiences });
  } catch (e) {
    res.status(400).json({ error: mcError(e) });
  }
};

exports.audiences = async (req, res) => {
  try {
    const org = await Organisation.findById(orgId(req)).select("mailchimp");
    const key = decrypt(org?.mailchimp?.apiKeyEnc);
    if (!key) return res.status(400).json({ error: "Connect Mailchimp first" });
    res.json(await mc.listAudiences(key, org.mailchimp.serverPrefix));
  } catch (e) {
    res.status(400).json({ error: mcError(e) });
  }
};

exports.configure = async (req, res) => {
  try {
    const { audienceId, audienceName, fromName, fromEmail } = req.body;
    if (!audienceId) return res.status(400).json({ error: "Choose an audience" });
    if (!fromEmail || !/^\S+@\S+\.\S+$/.test(fromEmail)) {
      return res.status(400).json({ error: "A valid 'from' email is required" });
    }
    await Organisation.findByIdAndUpdate(orgId(req), {
      $set: {
        "mailchimp.audienceId": audienceId,
        "mailchimp.audienceName": audienceName || "",
        "mailchimp.fromName": (fromName || "").trim(),
        "mailchimp.fromEmail": fromEmail.trim(),
      },
    });

    // We do NOT auto-register the inbound webhook. The admin copies the webhook
    // URL (shown in settings) and adds it manually in Mailchimp → Audience →
    // Settings → Webhooks. (services/mailchimp.ensureWebhook still exists if you
    // ever want to switch back to auto-registration.)
    const org = await Organisation.findById(orgId(req));
    res.json({ ok: true, status: statusOf(org) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

exports.sync = async (req, res) => {
  try {
    const org = await Organisation.findById(orgId(req));
    if (!org?.mailchimp?.audienceId) {
      return res.status(400).json({ error: "Connect Mailchimp and choose an audience first" });
    }
    const subs = await NewsletterSubscription.find({ organisationId: org._id, status: "active" }).select("email");
    const result = await mc.syncSubscribers(org, subs);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: mcError(e) });
  }
};

exports.disconnect = async (req, res) => {
  try {
    await Organisation.findByIdAndUpdate(orgId(req), {
      $set: {
        "mailchimp.connected": false,
        "mailchimp.apiKeyEnc": "",
        "mailchimp.serverPrefix": "",
        "mailchimp.audienceId": "",
        "mailchimp.audienceName": "",
        "mailchimp.fromName": "",
        "mailchimp.fromEmail": "",
        "mailchimp.accountLabel": "",
        "mailchimp.lastVerifiedAt": null,
      },
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("Mailchimp disconnect error:", e);
    res.status(500).json({ error: "Failed to disconnect Mailchimp" });
  }
};

/* ── inbound webhook (Mailchimp → us). Public, no auth/tenant. ─────────── */

// Mailchimp validates the URL with a GET on setup — just acknowledge it.
exports.webhookVerify = (req, res) => res.status(200).send("ok");

// Mailchimp posts form-encoded events (subscribe / unsubscribe / cleaned /
// upemail). We map them back onto our NewsletterSubscription rows. Always 200
// so Mailchimp doesn't enter a retry storm.
exports.webhook = async (req, res) => {
  try {
    const { type, data } = req.body || {};
    if (!type || !data) return res.status(200).send("ok");

    // Resolve the org from the URL (?org=) or by the audience id in the payload.
    let org = null;
    if (req.query.org) org = await Organisation.findById(req.query.org).select("mailchimp");
    if (!org && data.list_id) {
      org = await Organisation.findOne({ "mailchimp.audienceId": data.list_id }).select("mailchimp");
    }
    if (!org) return res.status(200).send("ok");

    // If a secret is configured, require it.
    if (org.mailchimp?.webhookSecret && req.query.secret !== org.mailchimp.webhookSecret) {
      return res.status(401).send("bad secret");
    }

    const email = (data.email || "").toLowerCase();
    if ((type === "unsubscribe" || type === "cleaned") && email) {
      await NewsletterSubscription.updateOne(
        { organisationId: org._id, email },
        { $set: { status: "unsubscribed" } },
      );
    } else if (type === "subscribe" && email) {
      await NewsletterSubscription.updateOne(
        { organisationId: org._id, email },
        { $set: { status: "active" }, $setOnInsert: { source: "mailchimp" } },
        { upsert: true, setDefaultsOnInsert: true },
      );
    } else if (type === "upemail" && data.new_email && data.old_email) {
      await NewsletterSubscription.updateOne(
        { organisationId: org._id, email: String(data.old_email).toLowerCase() },
        { $set: { email: String(data.new_email).toLowerCase() } },
      );
    }
    res.status(200).send("ok");
  } catch (e) {
    console.error("Mailchimp webhook error:", e);
    res.status(200).send("ok");
  }
};
