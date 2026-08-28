const express = require("express");
const router = express.Router();
const ctrl = require("../../controllers/emailTemplateController");
const { protect, admin } = require("../../middleware/authMiddleware");

/**
 * Tenant-side email template overrides (org admin).
 *
 * The scope marker is set HERE, by the mount, not by anything the client sends —
 * so a tenant request can never be talked into editing the platform default. The
 * controller reads `req.emailScope` and resolves the organisation from the
 * tenant middleware, exactly as the SMTP config routes do.
 *
 * Tenants only ever see `scope: "tenant"` templates; platform mail (billing,
 * operator invites, helpdesk) is filtered out by the controller.
 */
router.use(protect, admin, (req, _res, next) => {
  req.emailScope = "tenant";
  next();
});

router.get("/", ctrl.listTemplates);
router.get("/layout", ctrl.getLayout);
router.put("/layout", ctrl.saveLayout);
router.post("/layout/reset", ctrl.resetLayout);

// Send log — scoped to this tenant's own mail by the controller.
router.get("/logs", ctrl.listLogs);
router.get("/logs/stats", ctrl.logStats);

// Ahead of "/:key" so these aren't read as a template key.
router.post("/:key/preview", ctrl.previewTemplate);
router.post("/:key/test", ctrl.sendTest);
router.post("/:key/reset", ctrl.resetTemplate);
router.patch("/:key/toggle", ctrl.toggleTemplate);
router.get("/:key", ctrl.getTemplate);
router.put("/:key", ctrl.saveTemplate);

module.exports = router;
