// routes/admin/mailbox.routes.js — per-tenant sending mailboxes (org-admin).
const express = require("express");
const router = express.Router();
const ctrl = require("../../controllers/mailbox.controller");
const { protect, admin } = require("../../middleware/authMiddleware");

router.get("/", protect, admin, ctrl.list);
router.post("/", protect, admin, ctrl.create);
router.put("/:id", protect, admin, ctrl.update);
router.post("/:id/test", protect, admin, ctrl.test);
router.post("/:id/default", protect, admin, ctrl.setDefault);
router.delete("/:id", protect, admin, ctrl.remove);

module.exports = router;
