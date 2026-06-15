const express = require("express");
const router = express.Router();
const eventController = require("../controllers/eventController");
const optionalAuth = require("../middleware/optionalAuth");
const { protect } = require("../middleware/authMiddleware");

// ── Reads (anonymous; optionalAuth lets us attach "my registration") ──
router.get("/", optionalAuth, eventController.getEvents);

// Logged-in user's own registrations (must precede "/:id")
router.get("/my/registrations", protect, eventController.getMyRegistrations);
router.delete("/registrations/:regId", protect, eventController.cancelMyRegistration);

router.get("/:id", optionalAuth, eventController.getEvent);
router.get("/:id/registration-status", optionalAuth, eventController.getRegistrationStatus);

// ── Internal registration (guests allowed via optionalAuth) ──
router.post("/:id/register", optionalAuth, eventController.registerForEvent);

// ── Paid registration via in-house Stripe (create intent → confirm) ──
router.post("/:id/payment-intent", optionalAuth, eventController.createRegistrationPaymentIntent);
router.post("/:id/confirm-payment", optionalAuth, eventController.confirmRegistrationPayment);

module.exports = router;
