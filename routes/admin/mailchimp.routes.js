// routes/admin/mailchimp.routes.js — per-tenant Mailchimp connection (org-admin).
const express = require("express");
const router = express.Router();
const ctrl = require("../../controllers/mailchimpController");
const { protect, admin } = require("../../middleware/authMiddleware");

router.get("/", protect, admin, ctrl.getStatus);
router.post("/connect", protect, admin, ctrl.connect);
router.get("/audiences", protect, admin, ctrl.audiences);
router.post("/configure", protect, admin, ctrl.configure);
router.post("/sync", protect, admin, ctrl.sync);
router.delete("/", protect, admin, ctrl.disconnect);

module.exports = router;
