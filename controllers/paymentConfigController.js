const Stripe = require("stripe");
const Organisation = require("../models/organisation");
const { encrypt, decrypt } = require("../utils/crypto");

/** Shape returned to the admin client — NEVER includes secret values. */
function maskedConfig(org) {
  const p = org.payment || {};
  return {
    enabled: !!p.enabled,
    provider: p.provider || "stripe",
    publishableKey: p.publishableKey || "",
    hasSecretKey: !!p.secretKeyEnc,
    hasWebhookSecret: !!p.webhookSecretEnc,
    accountLabel: p.accountLabel || "",
    lastVerifiedAt: p.lastVerifiedAt || null,
  };
}

/**
 * GET /api/admin/payment-config
 */
exports.getConfig = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });
    const org = await Organisation.findById(orgId).select("payment");
    if (!org) return res.status(404).json({ error: "Organisation not found" });
    res.json(maskedConfig(org));
  } catch (error) {
    console.error("Get payment config error:", error);
    res.status(500).json({ error: "Failed to fetch payment configuration" });
  }
};

/**
 * PUT /api/admin/payment-config
 * Save publishable key and (optionally) new secret / webhook secret. Empty
 * secret fields mean "leave unchanged". Enabling requires a secret key.
 */
exports.updateConfig = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const { publishableKey, secretKey, webhookSecret, enabled } = req.body;
    const org = await Organisation.findById(orgId);
    if (!org) return res.status(404).json({ error: "Organisation not found" });

    const set = {};
    if (publishableKey !== undefined) set["payment.publishableKey"] = String(publishableKey).trim();
    if (typeof secretKey === "string" && secretKey.trim()) {
      set["payment.secretKeyEnc"] = encrypt(secretKey.trim());
    }
    if (typeof webhookSecret === "string" && webhookSecret.trim()) {
      set["payment.webhookSecretEnc"] = encrypt(webhookSecret.trim());
    }

    if (enabled !== undefined) {
      const willHaveSecret = set["payment.secretKeyEnc"] || org.payment?.secretKeyEnc;
      const willHavePublishable =
        set["payment.publishableKey"] !== undefined
          ? set["payment.publishableKey"]
          : org.payment?.publishableKey;
      if (enabled && (!willHaveSecret || !willHavePublishable)) {
        return res.status(400).json({
          error: "Add both a secret key and a publishable key before enabling payments.",
        });
      }
      set["payment.enabled"] = !!enabled;
    }

    const updated = await Organisation.findByIdAndUpdate(orgId, { $set: set }, { new: true }).select("payment");
    res.json({ message: "Payment configuration saved", config: maskedConfig(updated) });
  } catch (error) {
    console.error("Update payment config error:", error);
    res.status(500).json({ error: "Failed to save payment configuration" });
  }
};

/**
 * POST /api/admin/payment-config/test
 * Validate the stored (or just-supplied) secret key against Stripe and record
 * the account label + verification time.
 */
exports.testConnection = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const org = await Organisation.findById(orgId);
    let secret =
      typeof req.body.secretKey === "string" && req.body.secretKey.trim()
        ? req.body.secretKey.trim()
        : decrypt(org.payment?.secretKeyEnc);

    if (!secret) {
      return res.status(400).json({ error: "No secret key to test. Save your secret key first." });
    }

    const stripe = Stripe(secret);
    const acct = await stripe.accounts.retrieve();
    const label =
      acct.settings?.dashboard?.display_name ||
      acct.business_profile?.name ||
      acct.email ||
      acct.id;

    await Organisation.findByIdAndUpdate(orgId, {
      $set: { "payment.accountLabel": label, "payment.lastVerifiedAt": new Date() },
    });

    res.json({
      ok: true,
      accountLabel: label,
      account: { id: acct.id, email: acct.email || "", country: acct.country || "" },
    });
  } catch (error) {
    console.error("Stripe test connection error:", error.message);
    res.status(400).json({ ok: false, error: error.message || "Could not connect to Stripe with that key" });
  }
};

/**
 * DELETE /api/admin/payment-config
 * Disable and clear the tenant's stored Stripe credentials.
 */
exports.clearConfig = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });
    await Organisation.findByIdAndUpdate(orgId, {
      $set: {
        "payment.enabled": false,
        "payment.publishableKey": "",
        "payment.secretKeyEnc": "",
        "payment.webhookSecretEnc": "",
        "payment.accountLabel": "",
        "payment.lastVerifiedAt": null,
      },
    });
    res.json({ message: "Payment configuration cleared" });
  } catch (error) {
    console.error("Clear payment config error:", error);
    res.status(500).json({ error: "Failed to clear payment configuration" });
  }
};
