const express = require("express");
const router = express.Router();
const brandingController = require("../controllers/brandingController");
const { protect, admin } = require("../middleware/authMiddleware");

// Public — themes list
router.get("/themes", brandingController.getThemes);

// Admin-only — branding management
router.get("/", protect, admin, brandingController.getBranding);
router.put("/", protect, admin, brandingController.updateBranding);
router.post("/logo", protect, admin, brandingController.uploadLogo);
router.delete("/logo", protect, admin, brandingController.deleteLogo);

// Branding change requests (org admin → super admin approval)
router.post("/request", protect, admin, brandingController.submitRequest);
router.get("/requests", protect, admin, brandingController.getMyRequests);

module.exports = router;
