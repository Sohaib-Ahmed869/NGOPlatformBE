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
const billing = require("../../controllers/integration/billingController");
const leads = require("../../controllers/integration/leadController");
const platform = require("../../controllers/integration/platformController");

const router = express.Router();

// Every response is a live read of mutable operator data.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(integrationAuth);

router.get("/ping", handle(meta.ping));
router.get("/feature-flags", handle(meta.featureFlags));

// Platform overview
router.get("/dashboard", handle(platform.dashboard));
router.get("/audit", handle(platform.audit));

// Plans + the feature matrix
router.get("/plans", handle(meta.list));
router.post("/plans", handle(meta.create));
router.get("/plans/:code", handle(meta.get));
router.patch("/plans/:code", handle(meta.update));
router.delete("/plans/:code", handle(meta.archive));
router.post("/plans/:code/archive", handle(meta.archive));
router.post("/plans/:code/restore", handle(meta.restore));
router.post("/plans/:code/sync-stripe", handle(meta.syncStripe));
router.post("/plans/:code/migrate-subscribers", handle(meta.migrateSubscribers));
router.get("/feature-matrix", handle(meta.featureMatrix));
router.put("/feature-matrix", handle(meta.updateFeatureMatrix));

// Billing — revenue, invoices, coupons
router.get("/billing/summary", handle(billing.summary));
router.get("/invoices", handle(billing.listInvoices));
router.get("/invoices/:invoiceId", handle(billing.getInvoice));
router.get("/coupons", handle(billing.listCoupons));
router.post("/coupons", handle(billing.createCoupon));
router.get("/coupons/:code", handle(billing.getCoupon));
router.patch("/coupons/:code", handle(billing.updateCoupon));
router.delete("/coupons/:code", handle(billing.deleteCoupon));
router.post("/coupons/:code/replace", handle(billing.replaceCoupon));
router.post("/coupons/:code/archive", handle(billing.archiveCoupon));
router.post("/coupons/:code/restore", handle(billing.restoreCoupon));

// Tickets — cross-tenant queue
router.get("/tickets", handle(tickets.listAll));

// Leads CRM (static segments ahead of :leadId)
router.get("/leads", handle(leads.list));
router.post("/leads", handle(leads.create));
router.get("/leads/board", handle(leads.board));
router.get("/leads/staff", handle(leads.staff));
router.get("/leads/:leadId", handle(leads.get));
router.patch("/leads/:leadId", handle(leads.update));
router.delete("/leads/:leadId", handle(leads.remove));
router.patch("/leads/:leadId/stage", handle(leads.changeStage));
router.post("/leads/:leadId/messages", handle(leads.addMessage));
router.post("/leads/:leadId/assign", handle(leads.assign));
router.post("/leads/:leadId/convert", handle(leads.convert));

// Tenants
router.get("/tenants", handle(tenants.list));
router.post("/tenants", handle(tenants.create));
router.get("/tenants/:id", loadTenant, handle(tenants.get));
router.patch("/tenants/:id", loadTenant, handle(tenants.update));
router.delete("/tenants/:id", loadTenant, handle(tenants.remove));
router.post("/tenants/:id/assign-plan", loadTenant, handle(tenants.assignPlan));
router.put("/tenants/:id/override", loadTenant, handle(tenants.setOverride));
router.delete("/tenants/:id/override", loadTenant, handle(tenants.clearOverride));
router.post("/tenants/:id/comp", loadTenant, handle(tenants.comp));
router.post("/tenants/:id/trial", loadTenant, handle(tenants.trial));
router.get("/tenants/:id/invoices", loadTenant, handle(tenants.invoices));
router.get("/tenants/:id/audit", loadTenant, handle(tenants.audit));
// Blocked for API keys: minting a tenant session needs a named person.
router.post("/tenants/:id/act-as", loadTenant, handle(tenants.actAs));

// Tenant admins — the charity's own admin accounts
router.get("/tenants/:id/admins", loadTenant, handle(tenants.listAdmins));
router.get("/tenants/:id/admins/:userId", loadTenant, handle(tenants.getAdmin));
router.patch("/tenants/:id/admins/:userId", loadTenant, handle(tenants.updateAdmin));
router.post("/tenants/:id/admins/:userId/force-logout", loadTenant, handle(tenants.adminAction("force-logout")));
router.post("/tenants/:id/admins/:userId/unlock", loadTenant, handle(tenants.adminAction("unlock")));
router.post("/tenants/:id/admins/:userId/reset-2fa", loadTenant, handle(tenants.adminAction("reset-2fa")));
router.post("/tenants/:id/admins/:userId/password-reset", loadTenant, handle(tenants.adminAction("password-reset")));

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
