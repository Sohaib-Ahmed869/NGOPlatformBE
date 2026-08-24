const express = require("express");
const router = express.Router();
const registrationController = require("../../controllers/saas/registrationController");
const leadController = require("../../controllers/saas/leadController");
const { brandingUpload } = require("../../config/s3");

// Logo upload during registration (before org is created)
router.post("/register/upload-logo", brandingUpload.single("logo"), registrationController.uploadRegistrationLogo);

// Registration
router.post("/register", registrationController.register);

// Activate a paid registration from the browser — the success page calls this so
// going live does not depend on Stripe webhook delivery (which cannot reach
// localhost at all). Verified server-side against Stripe; see the controller.
router.post("/register/confirm", registrationController.confirmRegistration);

// Slug availability check
router.get("/register/check-slug", registrationController.checkSlug);

// Email availability check
router.get("/register/check-email", registrationController.checkEmail);

// Organisation status (polling for registration success page)
router.get("/organisations/status", registrationController.getStatus);

// Get organisation by slug (used by TenantContext)
router.get("/organisations/slug/:slug", registrationController.getBySlug);

// Plan limits (public, for pricing page)
router.get("/plans", registrationController.getPlans);

// Public list of sellable plans (dynamic, SuperAdmin-managed)
router.get("/plans/public", registrationController.getPublicPlans);

// Validate a discount coupon (public, for the registration/pricing page)
router.get("/coupon/:code", require("../../controllers/couponController").validateCoupon);

// "Talk to Sales" lead capture (public) — lands in the SuperAdmin Leads CRM.
router.post("/lead", leadController.submitLead);
router.get("/lead/prefill/:token", leadController.getPrefill);

module.exports = router;
