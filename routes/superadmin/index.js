const express = require("express");
const router = express.Router();
const isSuperAdmin = require("../../middleware/isSuperAdmin");
const ipAllowlist = require("../../middleware/ipAllowlist");
const superAdminController = require("../../controllers/superAdminController");
const planController = require("../../controllers/planController");
const supportTicketController = require("../../controllers/supportTicketController");
const couponController = require("../../controllers/couponController");
const contactQueryController = require("../../controllers/contactQueryController");
const supportSessionController = require("../../controllers/supportSessionController");

// Network guard runs BEFORE auth on every operator route (no-op unless
// SUPERADMIN_IP_ALLOWLIST is set).
router.use(ipAllowlist);

// One-shot creation of the FIRST super admin (secret-gated, public). Locked
// permanently once any super admin exists.
router.post("/auth/bootstrap", superAdminController.bootstrap);

// Ending a support session is called from the tenant context with the
// impersonation token (not a superadmin token) — it self-verifies the
// support_session claim, so it sits BEFORE the superadmin guard.
router.post("/support-session/end", superAdminController.endSupportSession);

// Everything below requires the superadmin role.
router.use(isSuperAdmin);

router.get("/organisations", superAdminController.listOrganisations);
router.get("/organisations/:id", superAdminController.getOrganisationDetail);
router.patch("/organisations/:id/plan", superAdminController.changePlan);
router.patch("/organisations/:id/suspend", superAdminController.suspendOrg);
router.patch("/organisations/:id/status", superAdminController.updateStatus);
router.post("/organisations/:id/act-as", superAdminController.actAs);
router.post("/organisations/:id/comp", superAdminController.compOrg);
router.put("/organisations/:id/override", superAdminController.setOverride);
router.delete("/organisations/:id/override", superAdminController.clearOverride);
router.post("/organisations/:id/trial", superAdminController.setTrial);
router.get("/billing", superAdminController.getBillingStats);
router.get("/dashboard", superAdminController.getDashboardStats);
router.get("/invoices", superAdminController.listInvoices);

// Support-impersonation sessions + the per-action audit they produce, plus the
// kill switch (revoke) and the global operator audit log.
router.get("/support-sessions", supportSessionController.listSessions);
router.get("/support-sessions/:sessionId", supportSessionController.getSession);
router.post("/support-sessions/:sessionId/revoke", supportSessionController.revokeSession);
router.get("/audit", supportSessionController.listAudit);

// Discount coupons (Stripe-synced)
router.get("/coupons", couponController.listCoupons);
router.post("/coupons", couponController.createCoupon);
router.post("/coupons/:code/archive", couponController.archiveCoupon);

// Cross-tenant support helpdesk (triage + kanban)
router.get("/tickets", supportTicketController.listAllTickets);
router.get("/tickets/board", supportTicketController.board);
router.get("/tickets/:id", supportTicketController.getOne);
router.post("/tickets/:id/comment", supportTicketController.addCommentSuper);
router.patch("/tickets/:id", supportTicketController.triage);

// Dynamic, Stripe-synced subscription plans
router.get("/plans", planController.listPlans);
router.post("/plans", planController.createPlan);
router.patch("/plans/:code", planController.updatePlan);
router.post("/plans/:code/archive", planController.archivePlan);
router.post("/plans/:code/migrate-subscribers", planController.migrateSubscribers);
router.post("/plans/:code/resync", planController.resyncPlan);

// Per-plan feature flags + metered limits (the Features matrix)
router.get("/feature-catalog", planController.getFeatureCatalog);
router.put("/entitlements", planController.bulkUpdateEntitlements);

// Editable pricing-card bullet library (plan editor → Marketing quick-add)
router.get("/plan-bullets", planController.getPlanBullets);
router.put("/plan-bullets", planController.updatePlanBullets);

// Branding request review
router.get("/branding-requests", superAdminController.listBrandingRequests);
router.get("/branding-requests/pending-count", superAdminController.brandingPendingCount);
router.patch("/branding-requests/:id/approve", superAdminController.approveBrandingRequest);
router.patch("/branding-requests/:id/reject", superAdminController.rejectBrandingRequest);

// Contact queries — split-inbox (internal notes, emailed replies, assignment)
router.get("/contact-queries", contactQueryController.list);
router.get("/contact-queries/unread-count", contactQueryController.unreadCount);
router.get("/contact-queries/staff", contactQueryController.getStaff);
router.get("/contact-queries/:id", contactQueryController.get);
router.post("/contact-queries/:id/messages", contactQueryController.addMessage);
router.patch("/contact-queries/:id/status", contactQueryController.updateStatus);
router.patch("/contact-queries/:id/assign", contactQueryController.assign);
router.post("/contact-queries/:id/read", contactQueryController.markRead);
router.delete("/contact-queries/:id", contactQueryController.remove);

module.exports = router;
