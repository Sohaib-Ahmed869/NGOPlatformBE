const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/platformSettingsController");
const isSuperAdmin = require("../middleware/isSuperAdmin");

// Public — the marketing site reads safe branding + contact fields.
router.get("/public", ctrl.getPublic);

// Superadmin only — edit the platform settings + branding.
router.get("/settings", isSuperAdmin, ctrl.getSettings);
router.put("/settings", isSuperAdmin, ctrl.updateSettings);
router.post("/settings/asset/:type", isSuperAdmin, ctrl.uploadAsset);
router.delete("/settings/asset/:type", isSuperAdmin, ctrl.deleteAsset);

module.exports = router;
