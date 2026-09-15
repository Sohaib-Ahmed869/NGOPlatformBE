/**
 * /api/integration — server-to-server API for Calcite Hyper.
 * Contract + examples: postman/README.md and postman/Donexus.postman_collection.json.
 */
const express = require("express");
const integrationAuth = require("../../middleware/integrationAuth");
const { handle, fail } = require("../../utils/integrationResponse");
const { loadTenant } = require("../../controllers/integration/shared");
const meta = require("../../controllers/integration/planController");
const tenants = require("../../controllers/integration/tenantController");
const tickets = require("../../controllers/integration/ticketController");

const router = express.Router();

// Every response is a live read of mutable operator data.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(integrationAuth);

router.get("/ping", handle(meta.ping));
router.get("/feature-flags", handle(meta.featureFlags));

// Plans
router.get("/plans", handle(meta.list));
router.post("/plans", handle(meta.create));
router.get("/plans/:code", handle(meta.get));
router.patch("/plans/:code", handle(meta.update));
router.delete("/plans/:code", handle(meta.archive));

// Tickets — cross-tenant queue
router.get("/tickets", handle(tickets.listAll));

// Tenants
router.get("/tenants", handle(tenants.list));
router.post("/tenants", handle(tenants.create));
router.get("/tenants/:id", loadTenant, handle(tenants.get));
router.patch("/tenants/:id", loadTenant, handle(tenants.update));
router.delete("/tenants/:id", loadTenant, handle(tenants.remove));
router.post("/tenants/:id/assign-plan", loadTenant, handle(tenants.assignPlan));
router.put("/tenants/:id/override", loadTenant, handle(tenants.setOverride));
router.delete("/tenants/:id/override", loadTenant, handle(tenants.clearOverride));

// Tickets — per tenant ("stats" registered before ":ticketId")
router.get("/tenants/:id/tickets", loadTenant, handle(tickets.listForTenant));
router.post("/tenants/:id/tickets", loadTenant, handle(tickets.create));
router.get("/tenants/:id/tickets/stats", loadTenant, handle(tickets.stats));
router.get("/tenants/:id/tickets/:ticketId", loadTenant, handle(tickets.get));
router.put("/tenants/:id/tickets/:ticketId", loadTenant, handle(tickets.update));
router.delete("/tenants/:id/tickets/:ticketId", loadTenant, handle(tickets.remove));
router.patch("/tenants/:id/tickets/:ticketId/status", loadTenant, handle(tickets.setStatus));
router.post("/tenants/:id/tickets/:ticketId/assign", loadTenant, handle(tickets.assign));
router.post("/tenants/:id/tickets/:ticketId/comments", loadTenant, handle(tickets.addComment));

router.use((req, res) => fail(res, 404, "ROUTE_NOT_FOUND", `No integration endpoint ${req.method} ${req.baseUrl}${req.path}`));

module.exports = router;
