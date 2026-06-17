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
    const { orgName, slug, adminName, adminEmail, adminPassword, plan, billingCycle, revenueRange, theme, logoUrl, isMuslimCharity } = req.body;

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
      isMuslimCharity: !!isMuslimCharity,
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

    // Seed default website pages for the new org (best-effort). The Islamic
    // giving pages are seeded enabled only when isMuslimCharity is set.
    try {
      await require("../../services/pageService").seedPagesForOrg(organisation._id);
    } catch (e) {
      console.error("Failed to seed pages for new org:", e.message);
    }

    // Seed a default set of donation types, tailored to the charity type
    // (Islamic categories for Muslim charities, general causes otherwise).
    try {
      const DonationType = require("../../models/donationtypes");
      const defaultTypes = isMuslimCharity
        ? ["Zakat ul Maal", "Zakat ul Fitr", "Sadaqah", "Sadaqah Jariyah", "Lillah", "Fidya & Kaffarah", "General Donation"]
        : ["General Donation", "Education Fund", "Water Fund", "Food Fund", "Emergency Fund", "Healthcare Fund"];
      await DonationType.insertMany(
        defaultTypes.map((donationType, order) => ({ organisationId: organisation._id, donationType, order })),
        { ordered: false },
      );
    } catch (e) {
      console.error("Failed to seed donation types for new org:", e.message);
    }

    // Look up the Stripe price ID
    const priceId = stripePrices[plan]?.[billingCycle];
    if (!priceId) {
      return res.status(400).json({ error: "Invalid plan or billing cycle" });
    }

    // Optional discount coupon (validated against the Coupon collection).
    let discounts;
    if (req.body.couponCode) {
      try {
        const Coupon = require("../../models/coupon");
        const coupon = await Coupon.findOne({ code: String(req.body.couponCode).toUpperCase().trim(), isActive: true });
        const okPlan = coupon && (!coupon.planCodes?.length || coupon.planCodes.includes(plan));
        const okExpiry = coupon && (!coupon.redeemBy || new Date(coupon.redeemBy) > new Date());
        const okRedemptions = coupon && (!coupon.maxRedemptions || coupon.timesRedeemed < coupon.maxRedemptions);
        if (coupon && coupon.stripeCouponId && okPlan && okExpiry && okRedemptions) {
          discounts = [{ coupon: coupon.stripeCouponId }];
        }
      } catch (e) {
        console.error("Coupon apply failed:", e.message);
      }
    }

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      line_items: [{ price: priceId, quantity: 1 }],
      ...(discounts ? { discounts } : {}),
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
      "name slug plan billingCycle subscriptionStatus branding design contactEmail contactPhone address addressDetails socialLinks website bankDetails eventAudiences isMuslimCharity"
    );

    if (!org) {
      return res.status(404).json({ error: "Organisation not found" });
    }

    // Site config: which pages exist + nav structure (drives the public
    // navbar and route gating). Auto-seeds defaults for orgs created before
    // the CMS feature existed.
    let pages = [];
    try {
      const { getNavPages } = require("../../services/pageService");
      pages = await getNavPages(org._id);
    } catch (e) {
      console.error("Failed to load site pages for org", slug, e.message);
    }

    // Public payment info — only the publishable key + enabled flag (never secrets).
    const fullOrg = await Organisation.findById(org._id).select("payment paypal");
    const payment = {
      enabled: !!(fullOrg?.payment?.enabled && fullOrg?.payment?.publishableKey),
      publishableKey: fullOrg?.payment?.publishableKey || "",
    };
    // Public PayPal info — client id is public (the buttons load with it).
    const paypal = {
      enabled: !!(fullOrg?.paypal?.enabled && fullOrg?.paypal?.clientId),
      clientId: fullOrg?.paypal?.clientId || "",
      mode: fullOrg?.paypal?.mode || "sandbox",
    };

    res.json({ ...org.toObject(), pages, payment, paypal });
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
