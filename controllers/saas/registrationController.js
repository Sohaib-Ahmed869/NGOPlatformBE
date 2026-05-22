const bcrypt = require("bcrypt");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const Organisation = require("../../models/organisation");
const User = require("../../models/user");
const stripePrices = require("../../config/stripePrices");
const { sendEmail } = require("../../services/emailUtil");

/**
 * POST /api/saas/register/upload-logo
 * Upload a logo during registration (before org is created).
 * Returns the S3 URL to be passed along with the registration request.
 */
exports.uploadRegistrationLogo = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No logo file uploaded" });
    }
    res.json({ logoUrl: req.file.location });
  } catch (error) {
    console.error("Logo upload error:", error);
    res.status(500).json({ error: "Failed to upload logo" });
  }
};

/**
 * POST /api/saas/register
 * Register a new organisation and create a Stripe Checkout Session for SaaS subscription.
 */
exports.register = async (req, res) => {
  try {
    const { orgName, slug, adminName, adminEmail, adminPassword, plan, billingCycle, revenueRange, theme, logoUrl } = req.body;

    // Validate required fields
    if (!orgName || !slug || !adminName || !adminEmail || !adminPassword || !plan || !billingCycle) {
      return res.status(400).json({ error: "All fields are required" });
    }

    // Validate slug format (lowercase alphanumeric + hyphens)
    const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    if (!slugRegex.test(slug)) {
      return res.status(400).json({ error: "Slug must be lowercase alphanumeric with hyphens only" });
    }

    // Reserved slugs
    const reserved = ["admin", "www", "api", "app", "mail", "ftp", "localhost"];
    if (reserved.includes(slug)) {
      return res.status(400).json({ error: "This subdomain is reserved" });
    }

    // Check slug uniqueness
    const existingOrg = await Organisation.findOne({ slug });
    if (existingOrg) {
      return res.status(400).json({ error: "This subdomain is already taken" });
    }

    // Check if email already used
    const existingUser = await User.findOne({ email: adminEmail.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ error: "An account with this email already exists" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    const { getThemeColors } = require("../../config/themePresets");
    const selectedTheme = getThemeColors(theme);

    // Create Organisation (inactive until payment completes)
    const organisation = await Organisation.create({
      name: orgName,
      slug,
      plan,
      billingCycle,
      revenueRange,
      subscriptionStatus: "pending",
      isActive: false,
      branding: {
        theme: theme || "default",
        primaryColor: selectedTheme.primaryColor,
        accentColor: selectedTheme.accentColor,
        backgroundColor: selectedTheme.backgroundColor,
        logo: logoUrl || "",
      },
    });

    // Create Stripe customer
    const customer = await stripe.customers.create({
      email: adminEmail,
      name: orgName,
      metadata: { orgSlug: slug, orgId: organisation._id.toString() },
    });

    // Update org with Stripe customer ID
    organisation.stripeCustomerId = customer.id;
    await organisation.save();

    // Look up the Stripe price ID
    const priceId = stripePrices[plan]?.[billingCycle];
    if (!priceId) {
      return res.status(400).json({ error: "Invalid plan or billing cycle" });
    }

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.CLIENT_URL}/register/success?session_id={CHECKOUT_SESSION_ID}&slug=${slug}`,
      cancel_url: `${process.env.CLIENT_URL}/plans`,
      metadata: {
        type: "saas_subscription",
        orgId: organisation._id.toString(),
        plan,
        billingCycle,
        adminName,
        adminEmail,
        hashedPassword,
      },
    });

    res.json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
};

/**
 * GET /api/saas/register/check-slug?slug=xxx
 * Check if a subdomain slug is available.
 */
exports.checkSlug = async (req, res) => {
  try {
    const { slug } = req.query;

    if (!slug) {
      return res.status(400).json({ error: "Slug is required" });
    }

    const reserved = ["admin", "www", "api", "app", "mail", "ftp", "localhost"];
    if (reserved.includes(slug)) {
      return res.json({ available: false, reason: "This subdomain is reserved" });
    }

    const existing = await Organisation.findOne({ slug: slug.toLowerCase() });
    res.json({ available: !existing });
  } catch (error) {
    console.error("Check slug error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * GET /api/saas/organisations/status?slug=xxx
 * Check if an organisation is active (used by registration success page for polling).
 */
exports.getStatus = async (req, res) => {
  try {
    const { slug } = req.query;

    if (!slug) {
      return res.status(400).json({ error: "Slug is required" });
    }

    const org = await Organisation.findOne({ slug });
    if (!org) {
      return res.status(404).json({ error: "Organisation not found" });
    }

    res.json({
      isActive: org.isActive,
      slug: org.slug,
      name: org.name,
      subscriptionStatus: org.subscriptionStatus,
    });
  } catch (error) {
    console.error("Get status error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * GET /api/saas/organisations/slug/:slug
 * Get public org info by slug (used by TenantContext on frontend).
 */
exports.getBySlug = async (req, res) => {
  try {
    const { slug } = req.params;

    const org = await Organisation.findOne({ slug, isActive: true }).select(
      "name slug plan billingCycle subscriptionStatus branding contactEmail contactPhone address website bankDetails"
    );

    if (!org) {
      return res.status(404).json({ error: "Organisation not found" });
    }

    res.json(org);
  } catch (error) {
    console.error("Get by slug error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * GET /api/saas/plans
 * Return plan limits config (public endpoint for pricing page).
 */
exports.getPlans = async (req, res) => {
  const planLimits = require("../../config/planLimits");
  res.json(planLimits);
};
