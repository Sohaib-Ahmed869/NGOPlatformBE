// routes/subscription.js
const express = require("express");
const router = express.Router();
const subscriptionController = require("../controllers/subscriptionController");
const auth = require("../middleware/auth");

// Get active subscriptions for the authenticated user
router.get("/active", auth, subscriptionController.getActiveSubscriptions);

// Get a specific subscription by ID
router.get(
  "/:subscriptionId",
  auth,
  subscriptionController.getSubscriptionById
);

// Pause a subscription
router.post(
  "/:subscriptionId/pause",
  auth,
  subscriptionController.pauseSubscription
);

// Resume a subscription
router.post(
  "/:subscriptionId/resume",
  auth,
  subscriptionController.resumeSubscription
);

// Cancel a subscription
router.post(
  "/:subscriptionId/cancel",
  auth,
  subscriptionController.cancelSubscription
);

// Update subscription amount
router.post(
  "/:subscriptionId/update-amount",
  auth,
  subscriptionController.updateSubscriptionAmount
);
router.post(
  "/:subscriptionId/update-end-date",
  auth,
  subscriptionController.updateSubscriptionEndDate
);
// Stripe webhook handler (no auth required as it comes from Stripe)
router.post("/webhook", subscriptionController.handleStripeWebhook);

module.exports = router;
