const express = require("express");
const router = express.Router();
const ctrl = require("../../controllers/paypalConfigController");
const { protect, admin } = require("../../middleware/authMiddleware");

// Org-admin only (tenant resolved by tenant middleware).
router.get("/", protect, admin, ctrl.getConfig);
router.put("/", protect, admin, ctrl.updateConfig);
router.post("/test", protect, admin, ctrl.testConnection);
router.delete("/", protect, admin, ctrl.clearConfig);

module.exports = router;
