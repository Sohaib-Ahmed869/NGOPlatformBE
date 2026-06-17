const Organisation = require("../models/organisation");
const User = require("../models/user");
const BrandingRequest = require("../models/brandingRequest");
const ContactQuery = require("../models/contactQuery");
const Plan = require("../models/plan");
const PlatformAuditLog = require("../models/platformAuditLog");
const PlatformInvoice = require("../models/platformInvoice");
const writeAudit = require("../utils/writeAudit");
const { getEffectiveLimits } = require("../utils/effectiveLimits");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { emitToSuperAdmins } = require("./../services/socket");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const stripePrices = require("../config/stripePrices");
const planPricing = require("../config/planPricing");

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

/**
 * GET /api/superadmin/organisations
 * List all organisations with pagination, search, and filter.
 */
exports.listOrganisations = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, plan, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { slug: { $regex: search, $options: "i" } },
      ];
    }
    if (plan) filter.plan = plan;
    if (status) filter.subscriptionStatus = status;

    const [organisations, total] = await Promise.all([
      Organisation.find(filter)
        .populate("adminUserId", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Organisation.countDocuments(filter),
    ]);

    res.json({
      organisations,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("List organisations error:", error);
    res.status(500).json({ error: "Failed to fetch organisations" });
  }
};

/**
 * PATCH /api/superadmin/organisations/:id/plan
 * Change an organisation's plan.
 */
exports.changePlan = async (req, res) => {
  try {
    const { plan } = req.body;

    // Prefer a dynamic Plan; fall back to the legacy static tiers so this keeps
    // working before the Plan collection has been seeded.
    const planDoc = await Plan.findOne({ code: plan });
    const legacyPlans = ["basic", "professional", "enterprise"];
    if (!planDoc && !legacyPlans.includes(plan)) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    const org = await Organisation.findById(req.params.id);
    if (!org) {
      return res.status(404).json({ error: "Organisation not found" });
    }

    const fromPlan = org.plan;

    // Update Stripe subscription if one exists
    if (org.stripeSubscriptionId) {
      try {
        const subscription = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
        const cycle = org.billingCycle || "monthly";
        // Dynamic plan price IDs take precedence over the legacy .env config.
        const newPriceId = planDoc?.stripePriceIds?.[cycle] || stripePrices[plan]?.[cycle];

        if (newPriceId && subscription.items?.data?.length > 0) {
          await stripe.subscriptions.update(org.stripeSubscriptionId, {
            items: [{
              id: subscription.items.data[0].id,
              price: newPriceId,
            }],
            proration_behavior: "create_prorations",
          });
        }
      } catch (stripeErr) {
        console.error("Stripe plan update failed (DB will still update):", stripeErr.message);
      }
    }

    org.plan = plan;
    await org.save();

    await writeAudit(req, "subscription.plan_changed", {
      organisationId: org._id,
      targetType: "organisation",
      targetId: String(org._id),
      meta: { from: fromPlan, to: plan },
    });

    res.json({ message: "Plan updated", organisation: org });
  } catch (error) {
    console.error("Change plan error:", error);
    res.status(500).json({ error: "Failed to change plan" });
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

    // Cancel Stripe subscription if one exists
    if (org.stripeSubscriptionId) {
      try {
        await stripe.subscriptions.cancel(org.stripeSubscriptionId);
      } catch (stripeErr) {
        console.error("Stripe cancellation failed (DB will still update):", stripeErr.message);
      }
    }

    org.isActive = false;
    org.subscriptionStatus = "cancelled";
    await org.save();

    await writeAudit(req, "org.suspended", {
      organisationId: org._id,
      targetType: "organisation",
      targetId: String(org._id),
      meta: { name: org.name, slug: org.slug },
    });

    res.json({ message: "Organisation suspended", organisation: org });
  } catch (error) {
    console.error("Suspend org error:", error);
    res.status(500).json({ error: "Failed to suspend organisation" });
  }
};

/**
 * GET /api/superadmin/organisations/:id
 * Full tenant detail: org + owner, effective entitlement limits, the dynamic
 * plan, and the last 20 operator audit entries for this org.
 */
exports.getOrganisationDetail = async (req, res) => {
  try {
    const org = await Organisation.findById(req.params.id).populate("adminUserId", "name email");
    if (!org) return res.status(404).json({ error: "Organisation not found" });

    const [effectiveLimits, plan, audit, invoices] = await Promise.all([
      getEffectiveLimits(org),
      Plan.findOne({ code: org.plan }).select("code name price color limits"),
      PlatformAuditLog.find({ organisationId: org._id }).sort({ createdAt: -1 }).limit(20),
      PlatformInvoice.find({ organisationId: org._id }).sort({ createdAt: -1 }).limit(10),
    ]);

    res.json({ organisation: org, plan, effectiveLimits, audit, invoices });
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
    const org = await Organisation.findById(req.params.id);
    if (!org) return res.status(404).json({ error: "Organisation not found" });

    if (action === "suspend") {
      if (org.stripeSubscriptionId) {
        try {
          await stripe.subscriptions.cancel(org.stripeSubscriptionId);
        } catch (e) {
          console.error("Stripe cancel failed (DB still updates):", e.message);
        }
      }
      org.isActive = false;
      org.subscriptionStatus = "cancelled";
    } else if (action === "reactivate") {
      org.isActive = true;
      org.subscriptionStatus = "active";
    } else {
      return res.status(400).json({ error: "Invalid action" });
    }

    await org.save();
    await writeAudit(req, action === "suspend" ? "org.suspended" : "org.reactivated", {
      organisationId: org._id,
      targetType: "organisation",
      targetId: String(org._id),
    });
    res.json({ message: `Organisation ${action}d`, organisation: org });
  } catch (err) {
    console.error("Update status error:", err);
    res.status(500).json({ error: "Failed to update status" });
  }
};

/**
 * POST /api/superadmin/organisations/:id/comp  { isComp, reason }
 */
exports.compOrg = async (req, res) => {
  try {
    const { isComp, reason } = req.body;
    if (isComp && !reason) return res.status(400).json({ error: "A reason is required" });
    const org = await Organisation.findById(req.params.id);
    if (!org) return res.status(404).json({ error: "Organisation not found" });

    org.isComp = !!isComp;
    org.compReason = isComp ? reason : "";
    await org.save();
    await writeAudit(req, isComp ? "org.comped" : "org.uncomped", {
      organisationId: org._id,
      targetType: "organisation",
      targetId: String(org._id),
      meta: { reason },
    });
    res.json({ message: "Updated", organisation: org });
  } catch (err) {
    console.error("Comp org error:", err);
    res.status(500).json({ error: "Failed to update comp status" });
  }
};

/**
 * PUT /api/superadmin/organisations/:id/override  { limits, pricing, reason }
 */
exports.setOverride = async (req, res) => {
  try {
    const { limits, pricing, reason } = req.body;
    if (!reason) return res.status(400).json({ error: "A reason is required" });
    const org = await Organisation.findById(req.params.id);
    if (!org) return res.status(404).json({ error: "Organisation not found" });

    const cleanLimits = {};
    if (limits && typeof limits === "object") {
      for (const k of Object.keys(limits)) {
        const v = limits[k];
        cleanLimits[k] =
          typeof v === "boolean" ? v : v === "" || v === null || v === undefined ? null : Number(v);
      }
    }

    org.override = {
      limits: Object.keys(cleanLimits).length ? cleanLimits : null,
      pricing: {
        monthly: pricing && pricing.monthly !== "" && pricing.monthly != null ? Number(pricing.monthly) : null,
        annual: pricing && pricing.annual !== "" && pricing.annual != null ? Number(pricing.annual) : null,
      },
      reason,
      setBy: req.user._id,
      setAt: new Date(),
    };
    await org.save();
    await writeAudit(req, "org.override_set", {
      organisationId: org._id,
      targetType: "organisation",
      targetId: String(org._id),
      meta: { limits: cleanLimits, pricing, reason },
    });
    res.json({ message: "Override saved", organisation: org });
  } catch (err) {
    console.error("Set override error:", err);
    res.status(500).json({ error: "Failed to set override" });
  }
};

/**
 * DELETE /api/superadmin/organisations/:id/override
 */
exports.clearOverride = async (req, res) => {
  try {
    const org = await Organisation.findById(req.params.id);
    if (!org) return res.status(404).json({ error: "Organisation not found" });
    org.override = undefined;
    await org.save();
    await writeAudit(req, "org.override_cleared", {
      organisationId: org._id,
      targetType: "organisation",
      targetId: String(org._id),
    });
    res.json({ message: "Override cleared", organisation: org });
  } catch (err) {
    console.error("Clear override error:", err);
    res.status(500).json({ error: "Failed to clear override" });
  }
};

/**
 * POST /api/superadmin/organisations/:id/trial  { trialEndsAt }
 */
exports.setTrial = async (req, res) => {
  try {
    const { trialEndsAt } = req.body;
    const org = await Organisation.findById(req.params.id);
    if (!org) return res.status(404).json({ error: "Organisation not found" });
    org.trialEndsAt = trialEndsAt ? new Date(trialEndsAt) : null;
    await org.save();
    await writeAudit(req, "org.trial_set", {
      organisationId: org._id,
      targetType: "organisation",
      targetId: String(org._id),
      meta: { trialEndsAt: org.trialEndsAt },
    });
    res.json({ message: "Trial updated", organisation: org });
  } catch (err) {
    console.error("Set trial error:", err);
    res.status(500).json({ error: "Failed to update trial" });
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
    const admin = org.adminUserId;
    if (!admin) return res.status(400).json({ error: "This organisation has no admin user to act as" });

    const sessionId = crypto.randomUUID();
    const token = jwt.sign(
      {
        id: String(admin._id),
        orgId: String(org._id),
        slug: org.slug,
        role: admin.role || "admin",
        name: admin.name || "",
        email: admin.email || "",
        support_session: true,
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
      meta: { sessionId, reason: req.body?.reason || "", actingAs: admin.email },
    });

    res.json({ token, slug: org.slug, orgId: String(org._id), sessionId, expiresIn: 3600 });
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
    const { status, organisationId, page = 1, limit = 30 } = req.query;
    const filter = {};
    if (status && status !== "all") filter.status = status;
    if (organisationId) filter.organisationId = organisationId;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [invoices, total, paidAgg] = await Promise.all([
      PlatformInvoice.find(filter)
        .populate("organisationId", "name slug")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      PlatformInvoice.countDocuments(filter),
      PlatformInvoice.aggregate([
        { $match: { status: "paid" } },
        { $group: { _id: null, total: { $sum: "$amountPaid" } } },
      ]),
    ]);

    res.json({
      invoices,
      totalCollected: paidAgg[0]?.total || 0,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    console.error("List invoices error:", err);
    res.status(500).json({ error: "Failed to fetch invoices" });
  }
};

/**
 * GET /api/superadmin/billing
 * Aggregate billing stats for the platform.
 */
exports.getBillingStats = async (req, res) => {
  try {
    const [totalOrgs, activeOrgs, planCounts, recentSignups, failedPayments, planDocs] = await Promise.all([
      Organisation.countDocuments(),
      Organisation.countDocuments({ isActive: true, subscriptionStatus: "active" }),
      Organisation.aggregate([
        { $match: { isActive: true, subscriptionStatus: "active" } },
        { $group: { _id: "$plan", count: { $sum: 1 } } },
      ]),
      Organisation.find()
        .populate("adminUserId", "name email")
        .sort({ createdAt: -1 })
        .limit(10)
        .select("name slug plan subscriptionStatus createdAt"),
      Organisation.countDocuments({ subscriptionStatus: "past_due" }),
      Plan.find({ isActive: true }).sort({ sortOrder: 1 }).select("code name price color"),
    ]);

    const countByCode = {};
    planCounts.forEach((p) => { countByCode[p._id] = p.count; });

    // Per-plan breakdown from the dynamic Plan collection; fall back to the
    // legacy static tiers before the Plan collection has been seeded.
    let plans;
    if (planDocs.length) {
      plans = planDocs.map((p) => ({
        code: p.code,
        name: p.name,
        color: p.color || "#10b981",
        monthly: p.price?.monthly || 0,
        annual: p.price?.annual || 0,
        count: countByCode[p.code] || 0,
      }));
    } else {
      plans = [
        ["basic", "Basic", "#06b6d4"],
        ["professional", "Professional", "#10b981"],
        ["enterprise", "Enterprise", "#f59e0b"],
      ].map(([code, name, color]) => ({
        code,
        name,
        color,
        monthly: planPricing[code]?.monthly || 0,
        annual: planPricing[code]?.annual || 0,
        count: countByCode[code] || 0,
      }));
    }

    const mrr = plans.reduce((sum, p) => sum + p.count * p.monthly, 0);
    const byPlan = {};
    plans.forEach((p) => { byPlan[p.code] = p.count; });

    res.json({
      totalOrganisations: totalOrgs,
      activeSubscriptions: activeOrgs,
      failedPayments,
      mrr,
      plans,
      byPlan, // back-compat for any older consumer
      recentSignups,
    });
  } catch (error) {
    console.error("Billing stats error:", error);
    res.status(500).json({ error: "Failed to fetch billing stats" });
  }
};

// ── Branding Request Review ──

/**
 * GET /api/superadmin/branding-requests
 * List all pending branding change requests.
 */
exports.listBrandingRequests = async (req, res) => {
  try {
    const { status = "pending", page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const filter = {};
    if (status !== "all") filter.status = status;

    const [requests, total] = await Promise.all([
      BrandingRequest.find(filter)
        .populate("organisationId", "name slug plan branding")
        .populate("requestedBy", "name email")
        .populate("reviewedBy", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      BrandingRequest.countDocuments(filter),
    ]);

    res.json(requests);
  } catch (error) {
    console.error("List branding requests error:", error);
    res.status(500).json({ error: "Failed to fetch branding requests" });
  }
};

/**
 * PATCH /api/superadmin/branding-requests/:id/approve
 * Approve a branding request and apply it to the organisation.
 */
exports.approveBrandingRequest = async (req, res) => {
  try {
    const request = await BrandingRequest.findById(req.params.id);
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

    await Organisation.findByIdAndUpdate(request.organisationId, {
      $set: updateFields,
    });

    request.status = "approved";
    request.reviewedBy = req.user._id;
    request.reviewNote = req.body.note || "";
    request.reviewedAt = new Date();
    await request.save();

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
    const request = await BrandingRequest.findById(req.params.id);
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
