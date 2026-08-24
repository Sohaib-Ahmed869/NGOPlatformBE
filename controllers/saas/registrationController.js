const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { stripe } = require("../../services/platformStripe");
const Organisation = require("../../models/organisation");
const User = require("../../models/user");
const Lead = require("../../models/lead");
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
    const { orgName, slug, adminName, adminEmail, adminPassword, plan, billingCycle, revenueRange, theme, logoUrl, isMuslimCharity, leadToken } = req.body;

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

    // Came in via a Leads CRM activation link? Link the two records so
    // orgActivation.js can flip the source Lead to "won" once this org
    // actually goes live. Best-effort — an invalid/expired token just means no
    // link, never a registration failure.
    let sourceLeadId = null;
    if (leadToken) {
      try {
        const tokenHash = crypto.createHash("sha256").update(String(leadToken)).digest("hex");
        const lead = await Lead.findOne({ "activation.tokenHash": tokenHash });
        if (lead) sourceLeadId = lead._id;
      } catch (e) {
        console.error("Failed to resolve leadToken:", e.message);
      }
    }

    const { getThemeColors } = require("../../config/themePresets");
    const selectedTheme = getThemeColors(theme);

    // Create Organisation (inactive until payment completes). The admin
    // credentials are stashed in `pendingAdmin` so the webhook can materialise
    // the admin User once the first invoice is paid (in-house checkout).
    const organisation = await Organisation.create({
      name: orgName,
      slug,
      plan,
      billingCycle,
      revenueRange,
      subscriptionStatus: "pending",
      isActive: false,
      isMuslimCharity: !!isMuslimCharity,
      sourceLeadId,
      pendingAdmin: {
        name: adminName,
        email: adminEmail.toLowerCase(),
        passwordHash: hashedPassword,
      },
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

    // Resolve the Stripe price ID from the DYNAMIC plan (SuperAdmin-managed),
    // falling back to the static config for legacy/seeded plans.
    const Plan = require("../../models/plan");
    const planDoc = await Plan.findOne({ code: plan, isActive: true });
    const priceId = planDoc?.stripePriceIds?.[billingCycle] || stripePrices[plan]?.[billingCycle];
    if (!priceId) {
      return res.status(400).json({ error: "Invalid plan or billing cycle" });
    }

    // Optional discount coupon (validated against the Coupon collection).
    let discounts;
    if (req.body.couponCode) {
      try {
        const Coupon = require("../../models/coupon");
        const { refreshRedemptions, hasRedemptionsLeft } = require("../../utils/couponRedemptions");
        const coupon = await Coupon.findOne({ code: String(req.body.couponCode).toUpperCase().trim(), isActive: true });
        const okPlan = coupon && (!coupon.planCodes?.length || coupon.planCodes.includes(plan));
        const okExpiry = coupon && (!coupon.redeemBy || new Date(coupon.redeemBy) > new Date());
        // Read the count back from Stripe first — the stored mirror is never
        // incremented by anything here, so an exhausted coupon used to sail
        // through this check and only fail (or over-discount) at Stripe.
        let okRedemptions = false;
        if (coupon) {
          const used = coupon.maxRedemptions ? await refreshRedemptions(coupon) : 0;
          okRedemptions = hasRedemptionsLeft(coupon, used);
        }
        if (coupon && coupon.stripeCouponId && okPlan && okExpiry && okRedemptions) {
          discounts = [{ coupon: coupon.stripeCouponId }];
        }
      } catch (e) {
        console.error("Coupon apply failed:", e.message);
      }
    }

    // Create a Subscription with an INCOMPLETE first invoice so we can collect
    // the card in-house (Stripe Elements) — returns the invoice PaymentIntent's
    // client secret instead of redirecting to hosted Checkout.
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      ...(discounts ? { coupon: discounts[0].coupon } : {}),
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.payment_intent"],
      metadata: {
        type: "saas_subscription",
        orgId: organisation._id.toString(),
        plan,
        billingCycle,
      },
    });

    organisation.stripeSubscriptionId = subscription.id;
    await organisation.save();

    const clientSecret = subscription.latest_invoice?.payment_intent?.client_secret;
    if (!clientSecret) {
      return res.status(500).json({ error: "Could not initialise payment. Please try again." });
    }

    res.json({
      clientSecret,
      subscriptionId: subscription.id,
      slug,
      orgId: organisation._id.toString(),
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
};

/**
 * POST /api/saas/register/confirm   { slug }  (or { orgId })
 *
 * Browser-driven activation, called by /register/success as soon as the card is
 * confirmed. The SaaS webhook does the same job, but webhook delivery is not
 * guaranteed to be timely — and in local development Stripe cannot reach
 * localhost at all — which left paid organisations stuck on "Setting up your
 * organisation…" until the 60s poll gave up.
 *
 * This is NOT an activation oracle. It ignores everything the client says about
 * payment and instead re-reads the org's OWN stored subscription from Stripe with
 * the platform secret key; the org is activated only if Stripe itself reports the
 * first invoice as paid. So the worst a caller can do is trigger the activation
 * that the webhook was going to perform anyway.
 */
exports.confirmRegistration = async (req, res) => {
  try {
    const { slug, orgId } = req.body || {};
    if (!slug && !orgId) {
      return res.status(400).json({ error: "slug or orgId is required" });
    }

    const org = orgId
      ? await Organisation.findById(orgId)
      : await Organisation.findOne({ slug: String(slug).toLowerCase().trim() });
    if (!org) {
      return res.status(404).json({ error: "Organisation not found" });
    }

    // Already live — the webhook (or a previous call) got there first.
    if (org.isActive && org.adminUserId) {
      return res.json({ isActive: true, slug: org.slug, name: org.name, source: "already-active" });
    }

    if (!org.stripeSubscriptionId) {
      return res.status(409).json({ isActive: false, error: "No subscription for this organisation yet." });
    }

    // Ask Stripe — never the client — whether the money actually moved.
    let subscription;
    try {
      subscription = await stripe.subscriptions.retrieve(org.stripeSubscriptionId, {
        expand: ["latest_invoice.payment_intent"],
      });
    } catch (e) {
      console.error("confirmRegistration: Stripe lookup failed:", e.message);
      return res.status(502).json({ isActive: false, error: "Could not verify the payment with Stripe." });
    }

    const invoice = subscription.latest_invoice;
    const intent = invoice?.payment_intent;

    // TWO conditions, both required. A paid invoice alone is not enough: a
    // cancelled subscription keeps its last paid invoice forever, so checking
    // only `invoice.paid` would let a cancelled tenant be switched back on.
    const subscriptionLive = ["active", "trialing"].includes(subscription.status);
    const invoicePaid = invoice?.paid === true || intent?.status === "succeeded" || subscription.status === "trialing";

    if (!subscriptionLive) {
      return res.status(409).json({
        isActive: false,
        error: "This subscription is no longer active. Please start a new subscription.",
        subscriptionStatus: subscription.status,
      });
    }

    if (!invoicePaid) {
      return res.status(402).json({
        isActive: false,
        error: "Payment has not completed yet.",
        subscriptionStatus: subscription.status,
        invoiceStatus: invoice?.status || null,
        paymentIntentStatus: intent?.status || null,
      });
    }

    const { activateOrgWithAdmin } = require("../../services/orgActivation");
    await activateOrgWithAdmin(org, {
      subscriptionId: subscription.id,
      customerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id,
    });

    res.json({ isActive: true, slug: org.slug, name: org.name, source: "confirm" });
  } catch (error) {
    console.error("Confirm registration error:", error);
    res.status(500).json({ error: "Failed to confirm registration" });
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
 * GET /api/saas/register/check-email?email=xxx
 * Check if an admin email is already in use (an account exists).
 */
exports.checkEmail = async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }
    const normalized = String(email).trim().toLowerCase();
    if (!/\S+@\S+\.\S+/.test(normalized)) {
      return res.status(400).json({ error: "Invalid email" });
    }
    const existing = await User.findOne({ email: normalized });
    res.json({ available: !existing });
  } catch (error) {
    console.error("Check email error:", error);
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

    // Public payment info — only publishable material, never secrets.
    const fullOrg = await Organisation.findById(org._id).select("payment paypal override");
    // WHICH Stripe account confirms this tenant's donations is decided on the
    // server, once, and handed to the browser — rather than letting the client
    // guess from an env var. That guess was the bug: the server would fall back
    // to the platform account while the page mounted Elements with a build-time
    // key from a different account (or a different test/live mode), and the
    // payment failed at confirmation with an unrelated-looking error.
    //
    // `publishableKey` is therefore the EFFECTIVE key — the tenant's own when
    // they've connected Stripe, the platform's only when the operator allows
    // that fallback, and "" when neither applies (the checkout then says card
    // payments aren't set up instead of silently failing).
    const { getDonationSource, getDonationPublishableKey } = require("../../services/tenantStripe");
    const donationSource = getDonationSource(fullOrg);
    const donationKey = getDonationPublishableKey(fullOrg);
    const payment = {
      // Unchanged meaning: the tenant's OWN account is connected and switched on.
      enabled: !!(fullOrg?.payment?.enabled && fullOrg?.payment?.publishableKey),
      publishableKey: donationKey,
      source: donationSource, // "tenant" | "platform" | "none"
      // NOT `!!publishableKey`: the key is legitimately empty when the platform
      // account is running on STRIPE_SECRET_KEY, and in that case the browser
      // supplies the matching VITE_STRIPE_PUBLISHABLE_KEY itself. Only "none" —
      // no tenant account and the operator has closed the fallback — actually
      // means cards can't be taken.
      canAcceptCards: donationSource !== "none",
    };
    // Public PayPal info — client id is public (the buttons load with it).
    const paypal = {
      enabled: !!(fullOrg?.paypal?.enabled && fullOrg?.paypal?.clientId),
      clientId: fullOrg?.paypal?.clientId || "",
      mode: fullOrg?.paypal?.mode || "sandbox",
    };

    // Resolved plan entitlements (feature flags + metered limits, with any
    // per-tenant override merged) — the single source both the admin portal and
    // the public site read to gate features.
    let entitlements = { features: {}, limits: {} };
    try {
      const { getEffectiveEntitlements } = require("../../utils/effectiveLimits");
      entitlements = await getEffectiveEntitlements({
        _id: org._id,
        plan: org.plan,
        override: fullOrg?.override,
      });
    } catch (e) {
      console.error("Failed to resolve entitlements for org", slug, e.message);
    }

    // Site config: which pages exist + nav structure (drives the public navbar
    // and route gating). Auto-seeds defaults for orgs created before the CMS
    // feature existed. Plan gating is folded into `enabled` HERE so the existing
    // PageGate/navbar/footer/⌘K cascade (which all read page.enabled) follows
    // the plan with no extra client logic: a page whose controlling plan flag is
    // OFF is forced enabled:false + showInNav:false (tenant toggle can't re-enable
    // beyond what the plan allows).
    let pages = [];
    try {
      const { getNavPages } = require("../../services/pageService");
      const { PAGE_TO_FLAG } = require("../../config/featureCatalog");
      const raw = await getNavPages(org._id);
      pages = raw.map((p) => {
        const obj = p.toObject ? p.toObject() : p;
        const flag = PAGE_TO_FLAG[obj.key];
        const planAllows = !flag || entitlements.features[flag] !== false;
        return planAllows ? obj : { ...obj, enabled: false, showInNav: false };
      });
    } catch (e) {
      console.error("Failed to load site pages for org", slug, e.message);
    }

    res.json({ ...org.toObject(), pages, payment, paypal, entitlements });
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

/**
 * GET /api/saas/plans/public
 * Public list of sellable plans (SuperAdmin-managed) for the pricing /
 * registration pages — safe projection (no Stripe IDs).
 */
exports.getPublicPlans = async (req, res) => {
  try {
    const Plan = require("../../models/plan");
    const plans = await Plan.find({ isActive: true, isPublic: true })
      .sort({ sortOrder: 1, "price.monthly": 1 })
      .select("code name description currency price features color limits featureFlags isPopular sortOrder")
      .lean();
    res.json(plans);
  } catch (err) {
    console.error("getPublicPlans error:", err);
    res.status(500).json({ error: "Failed to load plans" });
  }
};
