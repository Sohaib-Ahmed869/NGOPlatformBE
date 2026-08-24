const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/platformSettingsController");
const stripeCtrl = require("../controllers/platformStripeController");
const isSuperAdmin = require("../middleware/isSuperAdmin");
const ipAllowlist = require("../middleware/ipAllowlist");
const requireCapability = require("../middleware/requireCapability");

// Public — the marketing site reads safe branding + contact fields.
router.get("/public", ctrl.getPublic);

// Public — aggregate, non-identifying platform totals for the marketing hero.
router.get("/stats", ctrl.getPublicStats);

// Everything below is the operator console. It holds the platform's own Stripe
// credentials, so it belongs behind the SAME network guard as /api/superadmin —
// setting SUPERADMIN_IP_ALLOWLIST used to lock down the operator API while
// leaving this router, and the billing keys on it, open to any network.
const operator = [ipAllowlist, isSuperAdmin, requireCapability("ops")];

// Superadmin only — edit the platform settings + branding.
router.get("/settings", operator, ctrl.getSettings);
router.put("/settings", operator, ctrl.updateSettings);
router.post("/settings/asset/:type", operator, ctrl.uploadAsset);
router.delete("/settings/asset/:type", operator, ctrl.deleteAsset);

// Superadmin only — the platform's own Stripe account (SaaS billing). Secrets
// are write-only over the wire: responses carry a masked hint, never the key.
router.get("/settings/stripe", operator, stripeCtrl.getConfig);
router.put("/settings/stripe", operator, stripeCtrl.updateConfig);
router.post("/settings/stripe/test", operator, stripeCtrl.testConnection);
// Provision the SaaS billing webhook endpoint in the connected account and
// capture its signing secret — Stripe only ever reveals it at creation.
router.post("/settings/stripe/webhook", operator, stripeCtrl.createWebhook);
router.delete("/settings/stripe", operator, stripeCtrl.clearConfig);

module.exports = router;
