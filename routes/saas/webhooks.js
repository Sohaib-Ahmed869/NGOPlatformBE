const express = require("express");
const router = express.Router();
const webhookController = require("../../controllers/saas/webhookController");

// Stripe SaaS webhook — raw body parsing handled at server.js level
router.post("/stripe", webhookController.handleWebhook);

module.exports = router;
