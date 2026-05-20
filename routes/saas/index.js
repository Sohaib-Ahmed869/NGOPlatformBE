const express = require("express");
const router = express.Router();
const registrationController = require("../../controllers/saas/registrationController");

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

module.exports = router;
