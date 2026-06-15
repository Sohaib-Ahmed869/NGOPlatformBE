const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/partnerInquiryController");
const { protect, admin } = require("../middleware/authMiddleware");
const { partnerLogoUpload } = require("../config/s3");

// ── Public: "Become a partner" form submission (tenant context only) ──
// `logo` is optional; multer also parses the multipart text fields into req.body.
router.post("/apply", partnerLogoUpload.single("logo"), ctrl.submit);

// ── Admin: manage partnership enquiries ──
router.get("/", protect, admin, ctrl.list);
router.get("/:id", protect, admin, ctrl.getOne);
router.patch("/:id", protect, admin, ctrl.update);
router.delete("/:id", protect, admin, ctrl.remove);

module.exports = router;
