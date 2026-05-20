const express = require("express");
const router = express.Router();
const programController = require("../controllers/programController");
const { protect, admin } = require("../middleware/authMiddleware");
const { checkLimit } = require("../middleware/planEnforcement");

// Public routes (within tenant context)
router.get("/", programController.listPrograms);
router.get("/:id", programController.getProgram);

// Donor actions (auth required)
router.post("/:id/donate", protect, programController.donateToProgram);

// Admin actions
router.post("/", protect, admin, checkLimit("campaigns"), programController.createProgram);
router.post("/:id/followup", protect, admin, programController.postFollowUp);
router.put("/:id/close", protect, admin, programController.closeProgram);

module.exports = router;
