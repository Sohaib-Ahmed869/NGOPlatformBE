const express = require("express");
const router = express.Router();
const programController = require("../controllers/programController");
const { protect, admin } = require("../middleware/authMiddleware");
const { checkLimit } = require("../middleware/planEnforcement");
const { programUpload } = require("../config/s3");

// Public
router.get("/", programController.listPrograms);

// Donor (auth required) — static segments before /:id
router.get("/my/donated", protect, programController.myDonatedPrograms);

// Admin — static segments before /:id
router.get("/admin/followup-requests", protect, admin, programController.getFollowUpRequests);
router.put("/admin/followup-requests/:programId/:requestId/acknowledge", protect, admin, programController.acknowledgeFollowUpRequest);

// Donor actions
router.post("/:id/request-followup", protect, programController.requestFollowUp);
router.post("/:id/donate", protect, programController.donateToProgram);

// Single program (public)
router.get("/:id", programController.getProgram);

// Admin CRUD (with image uploads)
router.post("/", protect, admin, checkLimit("campaigns"), programUpload.array("images", 5), programController.createProgram);
router.put("/:id", protect, admin, programUpload.array("images", 5), programController.updateProgram);
router.delete("/:id", protect, admin, programController.deleteProgram);
router.post("/:id/followup", protect, admin, programUpload.array("images", 5), programController.postFollowUp);
router.put("/:id/close", protect, admin, programController.closeProgram);

module.exports = router;
