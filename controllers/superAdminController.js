const Organisation = require("../models/organisation");
const User = require("../models/user");
const BrandingRequest = require("../models/brandingRequest");
const ContactQuery = require("../models/contactQuery");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const stripePrices = require("../config/stripePrices");

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
    const validPlans = ["basic", "professional", "enterprise"];

    if (!validPlans.includes(plan)) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    const org = await Organisation.findById(req.params.id);
    if (!org) {
      return res.status(404).json({ error: "Organisation not found" });
    }

    // Update Stripe subscription if one exists
    if (org.stripeSubscriptionId) {
      try {
        const subscription = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
        const cycle = org.billingCycle || "monthly";
        const newPriceId = stripePrices[plan]?.[cycle];

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

    res.json({ message: "Organisation suspended", organisation: org });
  } catch (error) {
    console.error("Suspend org error:", error);
    res.status(500).json({ error: "Failed to suspend organisation" });
  }
};

/**
 * GET /api/superadmin/billing
 * Aggregate billing stats for the platform.
 */
exports.getBillingStats = async (req, res) => {
  try {
    const [totalOrgs, activeOrgs, planCounts, recentSignups, failedPayments] = await Promise.all([
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
    ]);

    const planCountsMap = {};
    planCounts.forEach((p) => { planCountsMap[p._id] = p.count; });

    res.json({
      totalOrganisations: totalOrgs,
      activeSubscriptions: activeOrgs,
      failedPayments,
      byPlan: {
        basic: planCountsMap.basic || 0,
        professional: planCountsMap.professional || 0,
        enterprise: planCountsMap.enterprise || 0,
      },
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
    const query = await ContactQuery.create({ name, email, subject, message });
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
