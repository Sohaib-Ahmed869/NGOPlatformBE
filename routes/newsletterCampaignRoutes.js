// routes/newsletterCampaignRoutes.js — admin newsletter campaigns (tenant-scoped)
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/newsletterCampaignController");
const isAdmin = require("../middleware/isAdmin");

// Static paths first so they don't collide with "/:id".
router.get("/", isAdmin, ctrl.list);
router.get("/recipients", isAdmin, ctrl.recipientCount);
router.post("/", isAdmin, ctrl.create);
router.post("/test", isAdmin, ctrl.testSend);

router.get("/:id", isAdmin, ctrl.get);
router.put("/:id", isAdmin, ctrl.update);
router.delete("/:id", isAdmin, ctrl.remove);
router.post("/:id/send", isAdmin, ctrl.sendNow);
router.post("/:id/schedule", isAdmin, ctrl.schedule);
router.post("/:id/cancel", isAdmin, ctrl.cancelSchedule);

module.exports = router;
