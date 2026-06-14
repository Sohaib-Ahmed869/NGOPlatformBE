const express = require("express");
const router = express.Router();
const paypal = require("../controllers/paypalController");
const optionalAuth = require("../middleware/optionalAuth");

// Donor-facing PayPal endpoints (tenant resolved by tenant middleware).
// optionalAuth so a logged-in donor is linked, but guests can still donate.
router.post("/create-order", optionalAuth, paypal.createOrder);
router.post("/capture-order", optionalAuth, paypal.captureOrder);
router.post("/create-subscription", optionalAuth, paypal.createSubscription);
router.post("/create-plan", optionalAuth, paypal.createDynamicPlan);
router.post("/confirm-subscription", optionalAuth, paypal.confirmSubscription);

module.exports = router;
