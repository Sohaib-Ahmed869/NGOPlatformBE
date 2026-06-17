const express = require("express");
const router = express.Router();
const registrationController = require("../../controllers/saas/registrationController");
const { brandingUpload } = require("../../config/s3");

// Logo upload during registration (before org is created)
router.post("/register/upload-logo", brandingUpload.single("logo"), registrationController.uploadRegistrationLogo);

// Registration
router.post("/register", registrationController.register);

// Slug availability check
router.get("/register/check-slug", registrationController.checkSlug);

// Organisation status (polling for registration success page)
router.get("/organisations/status", registrationController.getStatus);

// Get organisation by slug (used by TenantContext)
router.get("/organisations/slug/:slug", registrationController.getBySlug);

// Plan limits (public, for pricing page)
router.get("/plans", registrationController.getPlans);

// Validate a discount coupon (public, for the registration/pricing page)
router.get("/coupon/:code", require("../../controllers/couponController").validateCoupon);

module.exports = router;
