const express = require("express");
const router = express.Router();
const pageController = require("../../controllers/pageController");
const { protect, admin } = require("../../middleware/authMiddleware");
const { pageContentUpload } = require("../../config/s3");

// All routes are org-admin only (tenant resolved by tenant middleware).
router.get("/", protect, admin, pageController.listPages);
// Must precede "/:key" so the literal path isn't captured as a page key.
router.get("/section-types", protect, admin, pageController.getSectionTypes);
router.get("/:key", protect, admin, pageController.getPageAdmin);
router.put("/:key", protect, admin, pageController.updatePage);
router.post("/:key/publish", protect, admin, pageController.publishPage);
router.post("/:key/discard", protect, admin, pageController.discardDraft);
router.get("/:key/revisions", protect, admin, pageController.getRevisions);
router.post("/:key/revisions/:revId/restore", protect, admin, pageController.restoreRevision);
router.post(
  "/:key/image",
  protect,
  admin,
  pageContentUpload.single("image"),
  pageController.uploadPageImage
);

module.exports = router;
