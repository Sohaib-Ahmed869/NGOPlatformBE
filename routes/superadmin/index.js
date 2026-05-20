const express = require("express");
const router = express.Router();
const isSuperAdmin = require("../../middleware/isSuperAdmin");
const superAdminController = require("../../controllers/superAdminController");

// All super admin routes require superadmin role
router.use(isSuperAdmin);

router.get("/organisations", superAdminController.listOrganisations);
router.patch("/organisations/:id/plan", superAdminController.changePlan);
router.patch("/organisations/:id/suspend", superAdminController.suspendOrg);
router.get("/billing", superAdminController.getBillingStats);

// Branding request review
router.get("/branding-requests", superAdminController.listBrandingRequests);
router.patch("/branding-requests/:id/approve", superAdminController.approveBrandingRequest);
router.patch("/branding-requests/:id/reject", superAdminController.rejectBrandingRequest);

// Contact queries
router.get("/contact-queries", superAdminController.listContactQueries);
router.patch("/contact-queries/:id/status", superAdminController.updateContactQueryStatus);

module.exports = router;
