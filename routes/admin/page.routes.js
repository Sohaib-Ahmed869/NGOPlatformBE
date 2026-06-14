const express = require("express");
const router = express.Router();
const pageController = require("../../controllers/pageController");
const { protect, admin } = require("../../middleware/authMiddleware");
const { pageContentUpload } = require("../../config/s3");

// All routes are org-admin only (tenant resolved by tenant middleware).
router.get("/", protect, admin, pageController.listPages);
router.get("/:key", protect, admin, pageController.getPageAdmin);
router.put("/:key", protect, admin, pageController.updatePage);
router.post(
  "/:key/image",
  protect,
  admin,
  pageContentUpload.single("image"),
  pageController.uploadPageImage
);

module.exports = router;
