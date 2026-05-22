const express = require("express");
const router = express.Router();
const settingsController = require("../controllers/settingsController");
const { protect, admin } = require("../middleware/authMiddleware");

router.get("/", protect, admin, settingsController.getSettings);
router.put("/", protect, admin, settingsController.updateSettings);

module.exports = router;
