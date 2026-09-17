const Organisation = require("../models/organisation");
const User = require("../models/user");
const BrandingRequest = require("../models/brandingRequest");
const ContactQuery = require("../models/contactQuery");
const Plan = require("../models/plan");
const PlatformAuditLog = require("../models/platformAuditLog");
const PlatformInvoice = require("../models/platformInvoice");
const SupportSession = require("../models/supportSession");
const writeAudit = require("../utils/writeAudit");
const { sendTemplateEmail } = require("../services/emailUtil");
const { adminPortalUrl } = require("../utils/tenantUrls");
const { getEffectiveLimits } = require("../utils/effectiveLimits");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { emitToSuperAdmins } = require("./../services/socket");
const platformStats = require("../services/platformStats");
const tenantLifecycle = require("../services/tenantLifecycle");
const { isServiceError } = require("../utils/serviceError");

// Escape user-supplied text for safe inclusion in notification HTML.
const escapeHtml = (s) =>
  String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * Best-effort tenant notification when a branding request is decided. Sent from
 * the PLATFORM email account (no `org` option) since it's a platform→tenant
 * message, and never throws — a mail failure must not fail the review.
 * Addressed TO the org's primary admin; the requester is CC'd when they're a
 * different person. `request` needs `requestedBy` + `organisationId.adminUserId`
 * populated.
 */
async function notifyBrandingDecision(request, decision) {
  try {
    const org = request.organisationId || {};
    const primaryAdminEmail = org.adminUserId?.email || null;
    const requesterEmail = request.requestedBy?.email || null;
    const to = primaryAdminEmail || requesterEmail; // fall back to requester if no admin linked
    if (!to) return;
    const cc = requesterEmail && requesterEmail !== to ? requesterEmail : undefined;
    const orgName = org.name || "your organisation";
    const approved = decision === "approved";
    await sendTemplateEmail("tenant.brandingDecision", {
      to,
      cc,
      data: {
        recipient: { name: request.requestedBy?.name || "", email: to },
        tenant: { name: orgName },
        branding: {
          approved,
          note: request.reviewNote || "",
          settingsUrl: adminPortalUrl(org, "/admin/branding"),
        },
      },
      meta: { requestId: String(request._id || ""), decision },
    });
  } catch (e) {
    console.error("Branding decision email failed:", e.message);
  }
}

/**
 * POST /api/superadmin/auth/bootstrap  (public, secret-gated)
 * Creates the FIRST super admin. Requires SUPERADMIN_BOOTSTRAP_SECRET in the
 * `x-bootstrap-secret` header and zero existing super admins. Permanently
 * locked once one exists.
 */
exports.bootstrap = async (req, res) => {
  try {
    const secret = process.env.SUPERADMIN_BOOTSTRAP_SECRET;
    if (!secret) {
      return res.status(503).json({ error: "Bootstrap is not configured" });
    }
    const provided = req.header("x-bootstrap-secret") || "";
    const a = Buffer.from(secret);
    const b = Buffer.from(provided);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: "Invalid bootstrap secret" });
    }

    const existing = await User.countDocuments({ role: "superadmin" });
    if (existing > 0) {
      return res.status(403).json({ error: "Bootstrap locked — a super admin already exists" });
    }

    const { email, name, password } = req.body;
    if (!email) return res.status(400).json({ error: "email is required" });

    const generated =
      password ||
      crypto.randomBytes(15).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
    const hashed = await bcrypt.hash(generated, 10);
    const user = await User.create({
      name: name || "Super Admin",
      email: String(email).toLowerCase(),
      password: hashed,
      role: "superadmin",
      platformRole: "owner",
      platformStatus: "active",
      organisationId: null,
    });

    await writeAudit(req, "superadmin.bootstrapped", {
      targetType: "user",
      targetId: String(user._id),
      meta: { email: user.email },
    });

    res.status(201).json({
      message: "Super admin created",
      email: user.email,
      ...(password ? {} : { password: generated }), // returned ONCE when generated
    });
  } catch (err) {
    console.error("Bootstrap error:", err);
    res.status(500).json({ error: "Bootstrap failed" });
  }
};

// User-typed search terms are matched literally — escape regex metacharacters
// so "(" can't throw and ".*" can't match everything.
const escapeRegex = require("../utils/operatorInput").escapeRegex;
const input = require("../utils/operatorInput");

// The tenant list feeds a table of names, plans and statuses. It does NOT need
// the per-tenant payment credentials, and shipping them (even encrypted) put
// every tenant's Stripe/PayPal ciphertext and webhook secrets into the operator
// browser on every page load.
const LIST_PROJECTION = "-payment -paypal -bankDetails -pendingAdmin -draftDesign -volunteerQuestions -eventAudiences";

/**
 * Columns the organisations table may sort by. Every path here is one the
 * console actually renders — sorting by something the operator can't see is
 * how a list stops being explicable.
 */
const ORGANISATION_SORTS = {
  name: "name",
  slug: "slug",
  plan: "plan",
  status: "subscriptionStatus",
  created: "createdAt",
};

/** Columns the invoices table may sort by. */
const INVOICE_SORTS = {
  invoice: "number",
  period: "periodStart",
  amount: "amountDue",
  status: "status",
  date: "createdAt",
};

/**
 * GET /api/superadmin/organisations
 * List all organisations with pagination, search, and filter.
 */
exports.listOrganisations = async (req, res) => {
  try {
    const { page, limit, skip } = input.paging(req.query, { defaultLimit: 20, maxLimit: 100 });

    // Soft-deleted orgs never show up on the operator console.
    const filter = { deletedAt: null };
    const rx = input.searchRegex(req.query.search);
    if (rx) filter.$or = [{ name: rx }, { slug: rx }];
    // `?plan[$ne]=null` arrives as an object and used to reach Mongo as a query
    // operator, returning every tenant. It's refused rather than dropped —
    // quietly ignoring it answers with the whole list, which looks like a match.
    const plan = input.scalarFilter(req.query.plan, "plan");
    if (plan.error) return res.status(400).json({ error: plan.error });
    const status = input.scalarFilter(req.query.status, "status");
    if (status.error) return res.status(400).json({ error: status.error });
    if (plan.value) filter.plan = plan.value;
    if (status.value) filter.subscriptionStatus = status.value;

    const { sort, key: sortKey, dir: sortDir } = input.sorting(req.query, ORGANISATION_SORTS, {
      defaultKey: "created",
    });

    const [organisations, total] = await Promise.all([
      Organisation.find(filter)
        .select(LIST_PROJECTION)
        .populate("adminUserId", "name email")
        .sort(sort)
        .skip(skip)
        .limit(limit),
      Organisation.countDocuments(filter),
    ]);

    res.json({
      organisations,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
      sort: { key: sortKey, dir: sortDir },
    });
  } catch (error) {
    console.error("List organisations error:", error);
    res.status(500).json({ error: "Failed to fetch organisations" });
  }
};

/**
 * Console answer for a failure thrown by services/tenantLifecycle.js — same
 * `{ error }` shape the console has always read, with the service's status.
 */
function sendLifecycleError(res, err, fallback) {
  if (isServiceError(err)) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(`${fallback}:`, err);
  return res.status(500).json({ error: fallback });
}

/**
 * PATCH /api/superadmin/organisations/:id/plan
 * Change an organisation's plan (billing cycle unchanged). The Stripe swap and
 * its failure rules live in tenantLifecycle.assignPlan.
 */
exports.changePlan = async (req, res) => {
  try {
    // `plan` must be a scalar before it becomes a Mongo query. An object like
    // { $ne: null } used to match the FIRST plan in the collection.
    const parsed = input.text(req.body?.plan, "Plan", { max: 60, required: true, allowEmpty: false });
    if (parsed.error) return res.status(400).json({ error: "Invalid plan" });

    const org = await Organisation.findById(req.params.id);
    if (!org) {
      return res.status(404).json({ error: "Organisation not found" });
    }

    await tenantLifecycle.assignPlan(org, { planCode: parsed.value }, req);
    res.json({ message: "Plan updated", organisation: org });
  } catch (error) {
    sendLifecycleError(res, error, "Failed to change plan");
  }
};

/**
 * PATCH /api/superadmin/organisations/:id/suspend
 * Suspend an organisation — cancels Stripe subscription and deactivates portal.
 */
exports.suspendOrg = async (req, res) => {
  try {
    const org = await Organisation.findById(req.params.id);
    if (!org) {
      return res.status(404).json({ error: "Organisation not found" });
    }
    const result = await tenantLifecycle.suspendTenant(org, req);
    res.json({ message: "Organisation suspended", organisation: org, warnings: result.warnings });
  } catch (error) {
    sendLifecycleError(res, error, "Failed to suspend organisation");
  }
};

/**
 * DELETE /api/superadmin/organisations/:id  { confirmName }
 * Soft-deletes an organisation — same lifecycle effect as suspend (Stripe
 * subscription cancelled, portal locked) plus `deletedAt`/`deletedBy`, which
 * hides it from every SuperAdmin list/stat. Nothing is actually erased: donor
 * orders, invoices and the audit trail stay in Mongo. Gated on the operator
 * typing the organisation's exact name, mirroring the confirm-by-name pattern
 * used for destructive actions elsewhere.
 */
exports.deleteOrganisation = async (req, res) => {
  try {
    const org = await Organisation.findById(req.params.id);
    if (!org) return res.status(404).json({ error: "Organisation not found" });
    if (org.deletedAt) return res.status(409).json({ error: "Organisation already deleted" });

    const confirmName = input.text(req.body?.confirmName, "Confirmation", { max: 200, required: true, allowEmpty: false });
    if (confirmName.error) return res.status(400).json({ error: confirmName.error });
    if (confirmName.value !== org.name) {
      return res.status(400).json({ error: "Typed name doesn't match the organisation's name" });
    }

    const result = await tenantLifecycle.softDeleteTenant(org, req);
    res.json({ message: "Organisation deleted", organisation: org, warnings: result.warnings });
  } catch (error) {
    sendLifecycleError(res, error, "Failed to delete organisation");
  }
};

/**
 * GET /api/superadmin/organisations/:id
 * Full tenant detail: org + owner, effective entitlement limits, the dynamic
 * plan, and the last 20 operator audit entries for this org.
 */
exports.getOrganisationDetail = async (req, res) => {
  try {
    const org = await Organisation.findById(req.params.id).populate("adminUserId", "name email profileImage");
    if (!org) return res.status(404).json({ error: "Organisation not found" });

    const orgId = org._id;
    const [effectiveLimits, plan, audit, invoices, brandingRequests, supportSessions, footprint] = await Promise.all([
      getEffectiveLimits(org),
      Plan.findOne({ code: org.plan }).select("code name price color limits").lean(),
      PlatformAuditLog.find({ organisationId: orgId }).sort({ createdAt: -1 }).limit(20).lean(),
      PlatformInvoice.find({ organisationId: orgId }).sort({ createdAt: -1 }).limit(10).lean(),
      BrandingRequest.find({ organisationId: orgId }).populate("requestedBy", "name email").sort({ createdAt: -1 }).limit(5).lean(),
      SupportSession.find({ organisationId: orgId }).sort({ startedAt: -1 }).limit(5).lean(),
      // Usage of metered limits + tenant-by-the-numbers (shared with the integration API).
      platformStats.tenantFootprint(orgId),
    ]);
    const { usage, stats } = footprint;

    res.json({ organisation: org, plan, effectiveLimits, audit, invoices, brandingRequests, supportSessions, usage, stats });
  } catch (err) {
    console.error("Get organisation detail error:", err);
    res.status(500).json({ error: "Failed to fetch organisation" });
  }
};

/**
 * PATCH /api/superadmin/organisations/:id/status  { action: "suspend"|"reactivate" }
 */
exports.updateStatus = async (req, res) => {
  try {
    const { action } = req.body;
    if (!["suspend", "reactivate"].includes(action)) return res.status(400).json({ error: "Invalid action" });
    const org = await Organisation.findById(req.params.id);
    if (!org) return res.status(404).json({ error: "Organisation not found" });

    const result =
      action === "suspend"
        ? await tenantLifecycle.suspendTenant(org, req)
        : await tenantLifecycle.reactivateTenant(org, req);
    res.json({
      message: `Organisation ${action === "suspend" ? "suspended" : "reactivated"}`,
      organisation: org,
      warnings: result.warnings,
    });
  } catch (err) {
    sendLifecycleError(res, err, "Failed to update status");
  }
};

/**
 * POST /api/superadmin/organisations/:id/comp  { isComp, reason }
 * Rules (reason required to comp, audit) live in tenantLifecycle.setComp.
 */
exports.compOrg = async (req, res) => {
  try {
    const org = await Organisation.findById(req.params.id);
    if (!org) return res.status(404).json({ error: "Organisation not found" });
    const result = await tenantLifecycle.setComp(org, { isComp: !!req.body?.isComp, reason: req.body?.reason }, req);
    res.json({ message: "Updated", organisation: org, warnings: result.warnings });
  } catch (err) {
    sendLifecycleError(res, err, "Failed to update comp status");
  }
};

/**
 * PUT /api/superadmin/organisations/:id/override  { limits, pricing, reason }
 */
exports.setOverride = async (req, res) => {
  try {
    const org = await Organisation.findById(req.params.id);
    if (!org) return res.status(404).json({ error: "Organisation not found" });
    await tenantLifecycle.setOverride(org, req.body || {}, req);
    res.json({ message: "Override saved", organisation: org });
  } catch (err) {
    sendLifecycleError(res, err, "Failed to set override");
  }
};

/**
 * DELETE /api/superadmin/organisations/:id/override
 */
exports.clearOverride = async (req, res) => {
  try {
    const org = await Organisation.findById(req.params.id);
    if (!org) return res.status(404).json({ error: "Organisation not found" });
    await tenantLifecycle.clearOverride(org, req);
    res.json({ message: "Override cleared", organisation: org });
  } catch (err) {
    sendLifecycleError(res, err, "Failed to clear override");
  }
};

/**
 * POST /api/superadmin/organisations/:id/trial  { trialEndsAt }
 * Validation (a past date is refused) lives in tenantLifecycle.setTrial.
 */
exports.setTrial = async (req, res) => {
  try {
    const org = await Organisation.findById(req.params.id);
    if (!org) return res.status(404).json({ error: "Organisation not found" });
    await tenantLifecycle.setTrial(org, { trialEndsAt: req.body?.trialEndsAt }, req);
    res.json({ message: "Trial updated", organisation: org });
  } catch (err) {
    sendLifecycleError(res, err, "Failed to update trial");
  }
};

/**
 * POST /api/superadmin/organisations/:id/act-as   (super admin)
 * Mint a 1-hour tenant JWT that impersonates the org's admin user. Actions in the
 * resulting session run AS that admin; start/end are audited here.
 */
exports.actAs = async (req, res) => {
  try {
    const org = await Organisation.findById(req.params.id).populate("adminUserId", "name email role");
    if (!org) return res.status(404).json({ error: "Organisation not found" });
    const orgAdmin = org.adminUserId;

    const mode = req.body?.mode === "website" ? "website" : "admin";

    // Resolve the identity to impersonate.
    //  - admin mode  → the org's designated admin user.
    //  - website mode → the specific reported user (when a userId is given and
    //    belongs to this org), otherwise fall back to the org admin.
    let target = orgAdmin;
    if (mode === "website" && req.body?.userId) {
      const reported = await User.findOne({ _id: req.body.userId, organisationId: org._id }).select(
        "name email role organisationId"
      );
      if (!reported) {
        return res.status(400).json({ error: "Reported user not found for this organisation" });
      }
      target = reported;
    }
    if (!target) {
      return res.status(400).json({ error: "This organisation has no user to act as" });
    }

    // Default access: view-only for website/donor sessions (safer), full for
    // admin sessions — unless the operator explicitly chose one.
    const requested = req.body?.access;
    const access =
      requested === "view_only" || requested === "full"
        ? requested
        : mode === "website"
        ? "view_only"
        : "full";

    const sessionId = crypto.randomUUID();
    const ticketId = req.body?.ticketId || null;
    const expiresAt = new Date(Date.now() + 3600 * 1000);

    await SupportSession.create({
      sessionId,
      organisationId: org._id,
      orgSlug: org.slug,
      impersonatorId: req.user._id,
      impersonatorEmail: req.user.email,
      targetUserId: target._id,
      targetEmail: target.email || "",
      targetRole: target.role || "",
      mode,
      access,
      reason: req.body?.reason || "",
      ticketId,
      status: "active",
      startedAt: new Date(),
      expiresAt,
      ip: (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "",
      userAgent: req.headers["user-agent"] || "",
    });

    const token = jwt.sign(
      {
        id: String(target._id),
        orgId: String(org._id),
        slug: org.slug,
        role: target.role || "admin",
        name: target.name || "",
        email: target.email || "",
        support_session: true,
        mode,
        access,
        ticketId: ticketId ? String(ticketId) : null,
        impersonatedBy: req.user.email,
        impersonatorId: String(req.user._id),
        sessionId,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    await writeAudit(req, "support.session_started", {
      organisationId: org._id,
      targetType: "organisation",
      targetId: String(org._id),
      meta: { sessionId, reason: req.body?.reason || "", actingAs: target.email, mode, access, ticketId },
    });
    emitToSuperAdmins("organisation:updated", { organisationId: String(org._id) });

    res.json({
      token,
      slug: org.slug,
      orgId: String(org._id),
      sessionId,
      mode,
      access,
      expiresIn: 3600,
    });
  } catch (err) {
    console.error("Act-as error:", err);
    res.status(500).json({ error: "Failed to start support session" });
  }
};

/**
 * POST /api/superadmin/support-session/end
 * Called FROM the tenant context with the impersonation token — self-verifies the
 * support_session claim (no superadmin role required). Best-effort audit.
 */
exports.endSupportSession = async (req, res) => {
  try {
    const token = (req.header("Authorization") || "").replace("Bearer ", "");
    let decoded = {};
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      decoded = {};
    }
    if (!decoded.support_session) {
      return res.status(403).json({ error: "Not a support session" });
    }

    // Flip the session record closed (the kill switch). Best-effort: only an
    // already-active row is touched, so re-ending is a no-op.
    if (decoded.sessionId) {
      await SupportSession.updateOne(
        { sessionId: decoded.sessionId, status: "active" },
        { $set: { status: "ended", endedAt: new Date(), endedBy: decoded.impersonatorId || null } }
      ).catch((e) => console.error("End support session record update failed:", e.message));
      // Tell any open Support Sessions screen the row just went quiet.
      emitToSuperAdmins("supportSession:updated", { reason: "ended", sessionId: decoded.sessionId });
    }

    await PlatformAuditLog.create({
      actorId: decoded.impersonatorId || null,
      actorEmail: decoded.impersonatedBy || "",
      action: "support.session_ended",
      organisationId: decoded.orgId || null,
      targetType: "organisation",
      targetId: decoded.orgId ? String(decoded.orgId) : "",
      meta: { sessionId: decoded.sessionId || "" },
      ip: (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "",
      userAgent: req.headers["user-agent"] || "",
    });

    res.json({ message: "Support session ended" });
  } catch (err) {
    console.error("End support session error:", err);
    res.status(500).json({ error: "Failed to end support session" });
  }
};

/**
 * GET /api/superadmin/invoices
 * Platform SaaS invoices (mirrored from Stripe by the webhook).
 */
exports.listInvoices = async (req, res) => {
  try {
    const { page, limit, skip } = input.paging(req.query, { defaultLimit: 30, maxLimit: 100 });
    // "Tenant" isn't sortable: the name lives on the populated Organisation,
    // not on the invoice, so Mongo can't order by it without a $lookup — and
    // sorting a page by a field the query can't reach would silently do
    // nothing. The table renders that column unsortable rather than lying.
    const invoiceSort = input.sorting(req.query, INVOICE_SORTS, { defaultKey: "date" });

    const filter = {};
    const status = input.filterValue(req.query.status);
    if (status && status !== "all") filter.status = status;
    // A malformed organisationId used to reach Mongo and answer 500; an object
    // like `?organisationId[$ne]=null` reached it as a query operator.
    const orgFilter = input.filterValue(req.query.organisationId);
    if (orgFilter) {
      if (!input.isObjectId(orgFilter)) return res.status(400).json({ error: "That organisation id is not valid" });
      filter.organisationId = orgFilter;
    }

    // Search spans the invoice's own identifiers AND the tenant it belongs to,
    // so looking up a charity by name finds their invoices on any page — the
    // screen used to filter only the 30 rows already loaded.
    const rx = input.searchRegex(req.query.search);
    if (rx) {
      const orgIds = await Organisation.find({ $or: [{ name: rx }, { slug: rx }] })
        .select("_id")
        .lean();
      filter.$or = [{ number: rx }, { stripeInvoiceId: rx }];
      if (orgIds.length) filter.$or.push({ organisationId: { $in: orgIds.map((o) => o._id) } });
    }

    const [invoices, summaryAgg, collectedAgg] = await Promise.all([
      PlatformInvoice.find(filter)
        .populate("organisationId", "name slug branding")
        .sort(invoiceSort.sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      // Count + paid/outstanding across the WHOLE filtered set, not just the
      // page on screen — the tiles sat next to lifetime figures and quietly
      // described a 30-row window.
      PlatformInvoice.aggregate([
        { $match: filter },
        {
          $facet: {
            total: [{ $count: "n" }],
            paid: [{ $match: { status: "paid" } }, { $count: "n" }],
            outstanding: [
              { $match: { status: { $in: ["open", "failed", "uncollectible"] } } },
              { $group: { _id: null, amount: { $sum: "$amountDue" }, count: { $sum: 1 } } },
            ],
          },
        },
      ]),
      // Lifetime collected is deliberately global — it's the platform total,
      // independent of whatever filter is applied.
      PlatformInvoice.aggregate([
        { $match: { status: "paid" } },
        { $group: { _id: null, total: { $sum: "$amountPaid" } } },
      ]),
    ]);

    const s = summaryAgg[0] || {};
    const total = s.total?.[0]?.n || 0;

    res.json({
      invoices,
      totalCollected: collectedAgg[0]?.total || 0,
      summary: {
        paidCount: s.paid?.[0]?.n || 0,
        outstandingAmount: s.outstanding?.[0]?.amount || 0,
        outstandingCount: s.outstanding?.[0]?.count || 0,
      },
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      sort: { key: invoiceSort.key, dir: invoiceSort.dir },
    });
  } catch (err) {
    console.error("List invoices error:", err);
    res.status(500).json({ error: "Failed to fetch invoices" });
  }
};

/**
 * GET /api/superadmin/billing
 * Aggregate billing stats for the platform — see services/platformStats.js.
 */
exports.getBillingStats = async (req, res) => {
  try {
    res.json(await platformStats.billingStats());
  } catch (error) {
    console.error("Billing stats error:", error);
    res.status(500).json({ error: "Failed to fetch billing stats" });
  }
};

/**
 * GET /api/superadmin/dashboard
 * Platform overview — subscription health, 12-month signup trend and
 * cross-tenant footprint. Computed in services/platformStats.js.
 */
exports.getDashboardStats = async (req, res) => {
  try {
    res.json(await platformStats.dashboardStats());
  } catch (error) {
    console.error("Dashboard stats error:", error);
    res.status(500).json({ error: "Failed to fetch dashboard stats" });
  }
};

// ── Branding Request Review ──

/**
 * GET /api/superadmin/branding-requests
 * List all pending branding change requests.
 */
exports.listBrandingRequests = async (req, res) => {
  try {
    // `parseInt("abc")` produced NaN and `page=-1` a negative skip, both of
    // which the driver rejected as a 500.
    const { page, limit, skip } = input.paging(req.query, { defaultLimit: 50, maxLimit: 100 });
    const filter = {};
    const status = input.filterValue(req.query.status) || "pending";
    if (status !== "all") filter.status = status;

    const [requests, total] = await Promise.all([
      BrandingRequest.find(filter)
        .populate("organisationId", "name slug plan branding")
        .populate("requestedBy", "name email")
        .populate("reviewedBy", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      BrandingRequest.countDocuments(filter),
    ]);

    // The count was computed and then thrown away — the screen received a bare
    // array and had no way to know a second page existed. `requests` is kept at
    // the top level so existing callers that index the response still work.
    res.json({ requests, pagination: { total, page, pages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error("List branding requests error:", error);
    res.status(500).json({ error: "Failed to fetch branding requests" });
  }
};

/**
 * GET /api/superadmin/branding-requests/pending-count
 * Live count of pending branding requests (powers the sidebar badge).
 */
exports.brandingPendingCount = async (req, res) => {
  try {
    const count = await BrandingRequest.countDocuments({ status: "pending" });
    res.json({ count });
  } catch (error) {
    console.error("Branding pending count error:", error);
    res.status(500).json({ error: "Failed to fetch count" });
  }
};

/**
 * PATCH /api/superadmin/branding-requests/:id/approve
 * Approve a branding request and apply it to the organisation.
 */
exports.approveBrandingRequest = async (req, res) => {
  try {
    const request = await BrandingRequest.findById(req.params.id)
      .populate("requestedBy", "name email")
      .populate({ path: "organisationId", select: "name slug adminUserId", populate: { path: "adminUserId", select: "name email" } });
    if (!request) {
      return res.status(404).json({ error: "Request not found" });
    }
    if (request.status !== "pending") {
      return res.status(400).json({ error: "Request already reviewed" });
    }

    // Apply the requested branding to the organisation
    const updateFields = {};
    const rb = request.requestedBranding;
    if (rb.primaryColor) updateFields["branding.primaryColor"] = rb.primaryColor;
    if (rb.accentColor) updateFields["branding.accentColor"] = rb.accentColor;
    if (rb.backgroundColor) updateFields["branding.backgroundColor"] = rb.backgroundColor;
    if (rb.theme) updateFields["branding.theme"] = rb.theme;
    if (rb.tagline !== undefined) updateFields["branding.tagline"] = rb.tagline;
    if (rb.logo) updateFields["branding.logo"] = rb.logo;
    if (rb.logoDark) updateFields["branding.logoDark"] = rb.logoDark;
    if (rb.iconLogo) updateFields["branding.iconLogo"] = rb.iconLogo;
    if (rb.iconLogoDark) updateFields["branding.iconLogoDark"] = rb.iconLogoDark;
    if (rb.favicon) updateFields["branding.favicon"] = rb.favicon;
    if (rb.faviconUseIcon !== undefined)
      updateFields["branding.faviconUseIcon"] = rb.faviconUseIcon;
    if (rb.siteTitle !== undefined)
      updateFields["branding.siteTitle"] = rb.siteTitle;

    await Organisation.findByIdAndUpdate(request.organisationId._id || request.organisationId, {
      $set: updateFields,
    });

    request.status = "approved";
    request.reviewedBy = req.user._id;
    request.reviewNote = req.body.note || "";
    request.reviewedAt = new Date();
    await request.save();

    emitToSuperAdmins("brandingRequest:updated", { id: String(request._id), status: "approved" });
    notifyBrandingDecision(request, "approved"); // best-effort, non-blocking
    res.json({ message: "Branding request approved and applied", request });
  } catch (error) {
    console.error("Approve branding request error:", error);
    res.status(500).json({ error: "Failed to approve request" });
  }
};

/**
 * PATCH /api/superadmin/branding-requests/:id/reject
 * Reject a branding request.
 */
exports.rejectBrandingRequest = async (req, res) => {
  try {
    const request = await BrandingRequest.findById(req.params.id)
      .populate("requestedBy", "name email")
      .populate({ path: "organisationId", select: "name slug adminUserId", populate: { path: "adminUserId", select: "name email" } });
    if (!request) {
      return res.status(404).json({ error: "Request not found" });
    }
    if (request.status !== "pending") {
      return res.status(400).json({ error: "Request already reviewed" });
    }

    request.status = "rejected";
    request.reviewedBy = req.user._id;
    request.reviewNote = req.body.note || "";
    request.reviewedAt = new Date();
    await request.save();

    emitToSuperAdmins("brandingRequest:updated", { id: String(request._id), status: "rejected" });
    notifyBrandingDecision(request, "rejected"); // best-effort, non-blocking
    res.json({ message: "Branding request rejected", request });
  } catch (error) {
    console.error("Reject branding request error:", error);
    res.status(500).json({ error: "Failed to reject request" });
  }
};

/**
 * POST /api/contact (public — no auth)
 */
exports.submitContactQuery = async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ error: "All fields are required" });
    }
    if (!/\S+@\S+\.\S+/.test(email)) {
      return res.status(400).json({ error: "Invalid email address" });
    }
    const query = await ContactQuery.create({ name, email, subject, message, lastMessageAt: new Date() });
    emitToSuperAdmins("contactQuery:new", { id: String(query._id) });
    res.status(201).json({ message: "Message sent successfully", query });
  } catch (error) {
    console.error("Submit contact query error:", error);
    res.status(500).json({ error: "Failed to send message" });
  }
};

/**
 * GET /api/superadmin/contact-queries
 */
exports.listContactQueries = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const filter = {};
    if (status && status !== "all") filter.status = status;

    const [queries, total] = await Promise.all([
      ContactQuery.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
      ContactQuery.countDocuments(filter),
    ]);
    res.json({ queries, pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) } });
  } catch (error) {
    console.error("List contact queries error:", error);
    res.status(500).json({ error: "Failed to fetch contact queries" });
  }
};

/**
 * PATCH /api/superadmin/contact-queries/:id/status
 */
exports.updateContactQueryStatus = async (req, res) => {
  try {
    const { status, adminNote } = req.body;
    if (!["new", "read", "replied"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const query = await ContactQuery.findByIdAndUpdate(
      req.params.id,
      { status, ...(adminNote !== undefined && { adminNote }) },
      { new: true }
    );
    if (!query) return res.status(404).json({ error: "Query not found" });
    res.json({ message: "Status updated", query });
  } catch (error) {
    console.error("Update contact query error:", error);
    res.status(500).json({ error: "Failed to update query" });
  }
};
