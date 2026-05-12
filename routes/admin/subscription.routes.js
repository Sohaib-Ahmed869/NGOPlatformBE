// routes/admin/subscriptionRoutes.js
const express = require("express");
const router = express.Router();
const isAdmin = require("../../middleware/isAdmin");
const {
  getDashboardStats,
  getSubscriptions,
  getSubscriptionDetails,
  updateSubscriptionStatus,
  getPendingCancellationRequests,
  approveCancellationRequest,
  denyCancellationRequest
} = require("../../controllers/admin/subcriptionController");

// Dashboard Statistics
router.get("/dashboard/subscription-stats", isAdmin, getDashboardStats);

// Get Subscriptions List
router.get("/", isAdmin, getSubscriptions);

// Get Pending Cancellation Requests
router.get("/cancellation-requests/pending", isAdmin, getPendingCancellationRequests);

// Get Subscription Details
router.get("/:id", isAdmin, getSubscriptionDetails);

// Update Subscription Status
router.patch("/:id/status", isAdmin, updateSubscriptionStatus);

// Approve Cancellation Request
router.post("/:subscriptionId/cancellation/approve", isAdmin, approveCancellationRequest);

// Deny Cancellation Request
router.post("/:subscriptionId/cancellation/deny", isAdmin, denyCancellationRequest);

module.exports = router;
