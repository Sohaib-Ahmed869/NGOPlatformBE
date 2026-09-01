const express = require("express");
const router = express.Router();
const isSuperAdmin = require("../../middleware/isSuperAdmin");
const ipAllowlist = require("../../middleware/ipAllowlist");
const requireCapability = require("../../middleware/requireCapability");
const superAdminController = require("../../controllers/superAdminController");
const superAdminUserController = require("../../controllers/superAdminUserController");
const planController = require("../../controllers/planController");
const supportTicketController = require("../../controllers/supportTicketController");
const couponController = require("../../controllers/couponController");
const contactQueryController = require("../../controllers/contactQueryController");
const leadController = require("../../controllers/leadController");
const crmTaskController = require("../../controllers/crmTaskController");
const crmOverviewController = require("../../controllers/crmOverviewController");
const supportSessionController = require("../../controllers/supportSessionController");
const { requireObjectId } = require("../../utils/operatorInput");

// Capability guards, one per SA nav section — see config/platformRoles.js.
const canTenants = requireCapability("tenants");
const canBilling = requireCapability("billing");
const canSupport = requireCapability("support");
const canOps = requireCapability("ops");

// A malformed :id used to reach Mongo and come back as a 500 ("Failed to fetch
// organisation") on every one of these routes. Rejecting it here means each
// controller can assume the id is castable.
const orgId = requireObjectId("id", "organisation id");
const docId = requireObjectId("id", "id");
// Sub-document routes carry a second id (a checklist item inside a task); it
// needs the same guard, since `task.checklist.id("abc")` throws rather than
// answering "no such item".
const itemId = requireObjectId("itemId", "item id");

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

// Accepting a Team invite happens before the invitee has any credentials —
// the reset-style token itself is the proof of identity, same as
// /reset-password/:token on the donor/admin side.
router.get("/users/accept-invite/:token", superAdminUserController.getInvite);
router.post("/users/accept-invite/:token", superAdminUserController.acceptInvite);

// Forgot-password — a locked-out operator can't authenticate, so this has to
// run before the guard too. email -> 6-digit code -> verify -> reset.
router.post("/auth/forgot-password", superAdminUserController.forgotPassword);
router.post("/auth/forgot-password/verify", superAdminUserController.verifyResetCode);
router.post("/auth/forgot-password/reset", superAdminUserController.resetPasswordWithCode);

// Everything below requires the superadmin role.
router.use(isSuperAdmin);

router.get("/organisations", canTenants, superAdminController.listOrganisations);
router.get("/organisations/:id", canTenants, orgId, superAdminController.getOrganisationDetail);
router.patch("/organisations/:id/plan", canTenants, orgId, superAdminController.changePlan);
router.patch("/organisations/:id/suspend", canTenants, orgId, superAdminController.suspendOrg);
router.patch("/organisations/:id/status", canTenants, orgId, superAdminController.updateStatus);
router.delete("/organisations/:id", canTenants, orgId, superAdminController.deleteOrganisation);
router.post("/organisations/:id/act-as", canSupport, orgId, superAdminController.actAs);
router.post("/organisations/:id/comp", canTenants, orgId, superAdminController.compOrg);
router.put("/organisations/:id/override", canTenants, orgId, superAdminController.setOverride);
router.delete("/organisations/:id/override", canTenants, orgId, superAdminController.clearOverride);
router.post("/organisations/:id/trial", canTenants, orgId, superAdminController.setTrial);
router.get("/billing", canBilling, superAdminController.getBillingStats);
router.get("/dashboard", superAdminController.getDashboardStats);
router.get("/invoices", canBilling, superAdminController.listInvoices);

// Team / platform-operator management (Owner/Admin only).
router.get("/users", canOps, superAdminUserController.list);
// Read-only companion to the list above: the admin each tenant signs in with.
// Registered before any "/users/:id" pattern so the literal path always wins.
router.get("/users/tenant-admins", canOps, superAdminUserController.listTenantAdmins);
// What an operator can do FOR (or TO) a charity's own admin. Separate paths
// from the operator routes below because they guard on a different role —
// these accept only `role: "admin"`, those only `role: "superadmin"`, so
// neither set can be used to reach the other population.
router.patch("/users/tenant-admins/:id/status", canOps, docId, superAdminUserController.setTenantAdminStatus);
router.post("/users/tenant-admins/:id/force-logout", canOps, docId, superAdminUserController.forceLogoutTenantAdmin);
router.post("/users/tenant-admins/:id/unlock", canOps, docId, superAdminUserController.unlockTenantAdmin);
router.post("/users/tenant-admins/:id/reset-2fa", canOps, docId, superAdminUserController.resetTenantAdminMfa);
router.patch("/users/tenant-admins/:id/mfa-policy", canOps, docId, superAdminUserController.setTenantAdminMfaPolicy);
router.post("/users/tenant-admins/:id/password-reset", canOps, docId, superAdminUserController.sendTenantAdminPasswordReset);
router.post("/users", canOps, superAdminUserController.invite);
router.patch("/users/:id/invite", canOps, docId, superAdminUserController.updateInvite);
router.patch("/users/:id/role", canOps, docId, superAdminUserController.changeRole);
router.patch("/users/:id/status", canOps, docId, superAdminUserController.changeStatus);
router.patch("/users/:id/mfa-policy", canOps, docId, superAdminUserController.setMfaPolicy);
router.post("/users/:id/resend-invite", canOps, docId, superAdminUserController.resendInvite);
router.post("/users/:id/force-logout", canOps, docId, superAdminUserController.forceLogout);

// Support-impersonation sessions + the per-action audit they produce, plus the
// kill switch (revoke) and the global operator audit log.
router.get("/support-sessions", canSupport, supportSessionController.listSessions);
// Ahead of the /:sessionId route — otherwise "revoke-all" is read as a session id.
// The platform-wide panic switch stays Owner/Admin-only, unlike the rest of /support-sessions.
router.post("/support-sessions/revoke-all", canOps, supportSessionController.revokeAllSessions);
router.get("/support-sessions/:sessionId", canSupport, supportSessionController.getSession);
router.post("/support-sessions/:sessionId/revoke", canSupport, supportSessionController.revokeSession);
router.get("/audit", canOps, supportSessionController.listAudit);

// Discount coupons (Stripe-synced)
router.get("/coupons", canBilling, couponController.listCoupons);
router.post("/coupons", canBilling, couponController.createCoupon);
router.post("/coupons/:code/archive", canBilling, couponController.archiveCoupon);
// Archiving DELETES the Stripe coupon, so restoring has to recreate it rather
// than flip a flag — see the note on restoreCoupon.
router.post("/coupons/:code/restore", canBilling, couponController.restoreCoupon);
// Stripe coupons are immutable, so editing is split: PATCH for the fields that
// only live here (description, plan whitelist), /replace for the discount terms.
router.patch("/coupons/:code", canBilling, couponController.updateCoupon);
router.post("/coupons/:code/replace", canBilling, couponController.replaceCoupon);
router.delete("/coupons/:code", canBilling, couponController.deleteCoupon);

// Cross-tenant support helpdesk (triage + kanban)
router.get("/tickets", canSupport, supportTicketController.listAllTickets);
router.get("/tickets/board", canSupport, supportTicketController.board);
router.get("/tickets/:id", canSupport, docId, supportTicketController.getOne);
router.post("/tickets/:id/comment", canSupport, docId, supportTicketController.addCommentSuper);
router.patch("/tickets/:id", canSupport, docId, supportTicketController.triage);

// Dynamic, Stripe-synced subscription plans
router.get("/plans", canBilling, planController.listPlans);
router.post("/plans", canBilling, planController.createPlan);
router.patch("/plans/:code", canBilling, planController.updatePlan);
router.post("/plans/:code/archive", canBilling, planController.archivePlan);
router.post("/plans/:code/migrate-subscribers", canBilling, planController.migrateSubscribers);
router.post("/plans/:code/resync", canBilling, planController.resyncPlan);

// Per-plan feature flags + metered limits (the Features matrix)
router.get("/feature-catalog", canBilling, planController.getFeatureCatalog);
router.put("/entitlements", canBilling, planController.bulkUpdateEntitlements);

// Editable pricing-card bullet library (plan editor → Marketing quick-add)
router.get("/plan-bullets", canBilling, planController.getPlanBullets);
router.put("/plan-bullets", canBilling, planController.updatePlanBullets);

// Branding request review
router.get("/branding-requests", canTenants, superAdminController.listBrandingRequests);
router.get("/branding-requests/pending-count", canTenants, superAdminController.brandingPendingCount);
router.patch("/branding-requests/:id/approve", canTenants, docId, superAdminController.approveBrandingRequest);
router.patch("/branding-requests/:id/reject", canTenants, docId, superAdminController.rejectBrandingRequest);

// Contact queries — split-inbox (internal notes, emailed replies, assignment)
router.get("/contact-queries", canSupport, contactQueryController.list);
router.get("/contact-queries/unread-count", canSupport, contactQueryController.unreadCount);
router.get("/contact-queries/staff", canSupport, contactQueryController.getStaff);
router.get("/contact-queries/:id", canSupport, docId, contactQueryController.get);
router.post("/contact-queries/:id/messages", canSupport, docId, contactQueryController.addMessage);
router.patch("/contact-queries/:id/status", canSupport, docId, contactQueryController.updateStatus);
router.patch("/contact-queries/:id/assign", canSupport, docId, contactQueryController.assign);
router.post("/contact-queries/:id/read", canSupport, docId, contactQueryController.markRead);
router.delete("/contact-queries/:id", canSupport, docId, contactQueryController.remove);

// Dynamic email templates — the platform-default layer of every transactional
// email (see config/emailCatalog.js), the shared branded layout, and the
// platform-wide send log. `emailScope = "platform"` is set by the mount so the
// shared controller writes to the platform row rather than a tenant's.
router.use(
  "/email",
  canOps,
  (req, _res, next) => {
    req.emailScope = "platform";
    next();
  },
  (() => {
    const email = express.Router();
    const emailCtrl = require("../../controllers/emailTemplateController");
    const { emailAttachmentUpload } = require("../../middleware/emailAttachments");

    email.get("/templates", emailCtrl.listTemplates);
    email.get("/layout", emailCtrl.getLayout);
    email.put("/layout", emailCtrl.saveLayout);
    email.post("/layout/reset", emailCtrl.resetLayout);
    email.get("/logs", emailCtrl.listLogs);
    email.get("/logs/stats", emailCtrl.logStats);

    // The free-form composer -- an email that isn't in the catalog at all.
    email.post("/custom/preview", emailCtrl.previewCustom);
    email.post("/custom/send", emailAttachmentUpload, emailCtrl.sendCustom);

    // Ahead of "/templates/:key" so these aren't read as a template key.
    email.post("/templates/:key/preview", emailCtrl.previewTemplate);
    email.post("/templates/:key/test", emailCtrl.sendTest);
    // A real send to real people, with attachments -- hence multipart.
    email.post("/templates/:key/send", emailAttachmentUpload, emailCtrl.sendManual);
    email.post("/templates/:key/reset", emailCtrl.resetTemplate);
    email.patch("/templates/:key/toggle", emailCtrl.toggleTemplate);
    email.get("/templates/:key", emailCtrl.getTemplate);
    email.put("/templates/:key", emailCtrl.saveTemplate);

    return email;
  })(),
);

// Leads CRM — public "Talk to Sales" capture, sales pipeline + convert-to-tenant.
// Ahead of /:id — otherwise "new-count"/"board"/"staff" is read as a lead id.
router.get("/leads/new-count", canTenants, leadController.newCount);
router.get("/leads/board", canTenants, leadController.board);
router.get("/leads/staff", canTenants, leadController.getStaff);
router.get("/leads/options", canTenants, leadController.options);
router.get("/leads", canTenants, leadController.list);
router.post("/leads", canTenants, leadController.create);
router.get("/leads/:id", canTenants, docId, leadController.get);
router.patch("/leads/:id", canTenants, docId, leadController.update);
router.patch("/leads/:id/stage", canTenants, docId, leadController.changeStage);
router.post("/leads/:id/messages", canTenants, docId, leadController.addMessage);
router.patch("/leads/:id/assign", canTenants, docId, leadController.assign);
router.post("/leads/:id/convert", canTenants, docId, leadController.convert);
router.delete("/leads/:id", canTenants, docId, leadController.remove);

// The CRM's front page — pipeline, follow-ups and what needs attention.
router.get("/crm/overview", canTenants, crmOverviewController.overview);

// CRM tasks — the follow-up work behind the pipeline. Same "tenants" capability
// as leads: a task is sales work, and an operator who can see the deal is the
// operator who can be asked to chase it.
// Static segments ahead of /:id, for the same reason as the lead routes above.
router.get("/tasks/board", canTenants, crmTaskController.board);
router.get("/tasks/stats", canTenants, crmTaskController.stats);
router.get("/tasks/staff", canTenants, crmTaskController.getStaff);
router.post("/tasks/bulk", canTenants, crmTaskController.bulk);
router.get("/tasks", canTenants, crmTaskController.list);
router.post("/tasks", canTenants, crmTaskController.create);
router.get("/tasks/:id", canTenants, docId, crmTaskController.get);
router.patch("/tasks/:id", canTenants, docId, crmTaskController.update);
router.patch("/tasks/:id/status", canTenants, docId, crmTaskController.changeStatus);
router.patch("/tasks/:id/assign", canTenants, docId, crmTaskController.assign);
router.post("/tasks/:id/comments", canTenants, docId, crmTaskController.addComment);
router.post("/tasks/:id/checklist", canTenants, docId, crmTaskController.addChecklistItem);
router.patch("/tasks/:id/checklist/:itemId", canTenants, docId, itemId, crmTaskController.updateChecklistItem);
router.delete("/tasks/:id/checklist/:itemId", canTenants, docId, itemId, crmTaskController.removeChecklistItem);
router.delete("/tasks/:id", canTenants, docId, crmTaskController.remove);

module.exports = router;
