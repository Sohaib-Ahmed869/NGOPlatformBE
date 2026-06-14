const axios = require("axios");
const Organisation = require("../models/organisation");
const { encrypt, decrypt } = require("../utils/crypto");
const { BASE_URLS } = require("../services/tenantPaypal");

/** Shape returned to the admin client — NEVER includes the client secret. */
function maskedConfig(org) {
  const p = org.paypal || {};
  return {
    enabled: !!p.enabled,
    mode: p.mode || "sandbox",
    clientId: p.clientId || "",
    hasClientSecret: !!p.clientSecretEnc,
    webhookId: p.webhookId || "",
    accountLabel: p.accountLabel || "",
    lastVerifiedAt: p.lastVerifiedAt || null,
  };
}

/** GET /api/admin/paypal-config */
exports.getConfig = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });
    const org = await Organisation.findById(orgId).select("paypal");
    if (!org) return res.status(404).json({ error: "Organisation not found" });
    res.json(maskedConfig(org));
  } catch (error) {
    console.error("Get PayPal config error:", error);
    res.status(500).json({ error: "Failed to fetch PayPal configuration" });
  }
};

/**
 * PUT /api/admin/paypal-config
 * Save client id, mode, webhook id and (optionally) a new client secret. An
 * empty secret means "leave unchanged". Enabling requires a client id + secret.
 */
exports.updateConfig = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const { clientId, clientSecret, mode, webhookId, enabled } = req.body;
    const org = await Organisation.findById(orgId);
    if (!org) return res.status(404).json({ error: "Organisation not found" });

    const set = {};
    if (clientId !== undefined) set["paypal.clientId"] = String(clientId).trim();
    if (mode !== undefined) set["paypal.mode"] = mode === "live" ? "live" : "sandbox";
    if (webhookId !== undefined) set["paypal.webhookId"] = String(webhookId).trim();
    if (typeof clientSecret === "string" && clientSecret.trim()) {
      set["paypal.clientSecretEnc"] = encrypt(clientSecret.trim());
    }

    if (enabled !== undefined) {
      const willHaveSecret = set["paypal.clientSecretEnc"] || org.paypal?.clientSecretEnc;
      const willHaveClientId =
        set["paypal.clientId"] !== undefined ? set["paypal.clientId"] : org.paypal?.clientId;
      if (enabled && (!willHaveSecret || !willHaveClientId)) {
        return res.status(400).json({
          error: "Add a client ID and secret before enabling PayPal.",
        });
      }
      set["paypal.enabled"] = !!enabled;
    }

    const updated = await Organisation.findByIdAndUpdate(orgId, { $set: set }, { new: true }).select("paypal");
    res.json({ message: "PayPal configuration saved", config: maskedConfig(updated) });
  } catch (error) {
    console.error("Update PayPal config error:", error);
    res.status(500).json({ error: "Failed to save PayPal configuration" });
  }
};

/**
 * POST /api/admin/paypal-config/test
 * Validate the stored (or just-supplied) credentials by fetching an OAuth token.
 */
exports.testConnection = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const org = await Organisation.findById(orgId);
    const p = org.paypal || {};
    const clientId = (req.body.clientId || p.clientId || "").trim();
    const clientSecret =
      typeof req.body.clientSecret === "string" && req.body.clientSecret.trim()
        ? req.body.clientSecret.trim()
        : decrypt(p.clientSecretEnc);
    const mode = (req.body.mode || p.mode) === "live" ? "live" : "sandbox";

    if (!clientId || !clientSecret) {
      return res.status(400).json({ ok: false, error: "Add and save your client ID and secret first." });
    }

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const tokenRes = await axios.post(
      `${BASE_URLS[mode]}/v1/oauth2/token`,
      "grant_type=client_credentials",
      { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" } }
    );

    if (!tokenRes.data.access_token) {
      return res.status(400).json({ ok: false, error: "PayPal did not return an access token" });
    }

    const label = `PayPal (${mode})`;
    await Organisation.findByIdAndUpdate(orgId, {
      $set: { "paypal.accountLabel": label, "paypal.lastVerifiedAt": new Date() },
    });

    res.json({ ok: true, accountLabel: label, mode });
  } catch (error) {
    const detail = error.response?.data?.error_description || error.message;
    console.error("PayPal test connection error:", detail);
    res.status(400).json({ ok: false, error: detail || "Could not authenticate with PayPal" });
  }
};

/** DELETE /api/admin/paypal-config — disable and clear stored PayPal credentials. */
exports.clearConfig = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });
    await Organisation.findByIdAndUpdate(orgId, {
      $set: {
        "paypal.enabled": false,
        "paypal.clientId": "",
        "paypal.clientSecretEnc": "",
        "paypal.webhookId": "",
        "paypal.productId": "",
        "paypal.accountLabel": "",
        "paypal.lastVerifiedAt": null,
      },
    });
    res.json({ message: "PayPal configuration cleared" });
  } catch (error) {
    console.error("Clear PayPal config error:", error);
    res.status(500).json({ error: "Failed to clear PayPal configuration" });
  }
};
