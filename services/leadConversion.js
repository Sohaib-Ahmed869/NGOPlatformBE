/**
 * services/leadConversion.js — the ways a SuperAdmin turns a Lead into a real
 * tenant, all from a Registration-like form pre-filled from the lead's own
 * answers (operator can correct any field before submitting).
 *
 *   (a) createActivationLink — emails the lead a pre-filled /register link and
 *       lets them complete the existing self-serve Stripe checkout end to end
 *       (their own org details AND their own payment). The Lead flips to "won"
 *       later, inside orgActivation.js, once the org actually goes live.
 *   (b) manualProvision — creates the Organisation + admin User directly, with
 *       no Stripe subscription, for comped/offline deals. Reuses the same
 *       page/donation-type seeding and isComp/trialEndsAt lifecycle fields the
 *       rest of the platform already uses.
 *   (c) createPendingPaidOrg — the operator has already decided the org's
 *       details (name/slug/admin/plan), so this creates the Organisation +
 *       Stripe subscription (mirrors registrationController.register) WITHOUT
 *       the customer re-entering anything. Two ways to finish paying it off:
 *         - chargeNow: the SuperAdmin console collects the card itself (Stripe
 *           Elements, right there in the Convert modal) and confirms.
 *         - sendPaymentLink: emails the customer a link into /register that —
 *           because the org+subscription already exist — skips straight to
 *           the Payment step (see RegistrationFlow.jsx's `resume` handling).
 *       Either way, activation (admin creation + isActive flip) happens the
 *       SAME way self-serve registration's does: orgActivation.js, triggered
 *       by the Stripe webhook or a confirm call — nothing new invented there,
 *       just a new admin-creation branch (pendingAdminNoPassword) it already
 *       knows how to handle.
 */
const crypto = require("crypto");
const Organisation = require("../models/organisation");
const User = require("../models/user");
const DonationType = require("../models/donationtypes");
const Plan = require("../models/plan");
const Coupon = require("../models/coupon");
const stripePrices = require("../config/stripePrices");
const { refreshRedemptions, hasRedemptionsLeft } = require("../utils/couponRedemptions");
const { stripe } = require("./platformStripe");
const { sendEmail } = require("./emailUtil");
const { seedPagesForOrg } = require("./pageService");
const { getThemeColors } = require("../config/themePresets");

// Same slug rules as controllers/saas/registrationController.js — duplicated
// rather than shared because the self-serve flow validates a client-typed
// slug, while this one generates and dedupes one server-side; keeping them
// as two small, obviously-equivalent lists is simpler than forcing one shape
// to serve both call sites.
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_SLUGS = ["admin", "www", "api", "app", "mail", "ftp", "localhost"];

function clientBaseUrl(req) {
  return process.env.CLIENT_URL || `${req.protocol}://${req.get("host")}`;
}

function fail(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  err.publicMessage = message;
  return err;
}

async function uniqueSlugFromName(orgName) {
  let base = String(orgName || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base || !SLUG_REGEX.test(base)) base = "org";

  let candidate = base;
  let n = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!RESERVED_SLUGS.includes(candidate) && !(await Organisation.exists({ slug: candidate }))) {
      return candidate;
    }
    candidate = `${base}-${n++}`;
  }
}

/** A client-supplied slug, validated + confirmed unique; falls back to auto-derived. */
async function resolveSlug(requestedSlug, orgName) {
  const s = String(requestedSlug || "").toLowerCase().trim();
  if (s && SLUG_REGEX.test(s) && !RESERVED_SLUGS.includes(s) && !(await Organisation.exists({ slug: s }))) {
    return s;
  }
  return uniqueSlugFromName(orgName);
}

/** Map the lead's richer budget bands onto Organisation.revenueRange's 3-tier enum. */
function toRevenueRange(annualBudgetRange) {
  if (annualBudgetRange === "5m_plus") return "5000000+";
  if (annualBudgetRange === "250k_1m" || annualBudgetRange === "1m_5m") return "500-5000000";
  return "0-500";
}

/**
 * The operator's form values, falling back to what the lead already told us —
 * the same field set Registration itself collects (org, admin, plan/billing,
 * vertical, revenue, theme, logo, coupon). Registration's password fields have
 * no equivalent here on purpose: nothing the lead submitted could ever prefill
 * a password, and every conversion path either lets the customer set their own
 * (activation link, self-serve payment step) or issues a "set your password"
 * reset-token email (manual provisioning) — the operator never handles one.
 */
function resolveFormFields(lead, body) {
  return {
    orgName: String(body?.orgName || lead.orgName || "").trim(),
    adminName: String(body?.adminName || lead.contactName || "").trim(),
    adminEmail: String(body?.adminEmail || lead.contactEmail || "").trim().toLowerCase(),
    plan: String(body?.plan || lead.interestedPlan || "basic"),
    billingCycle: ["monthly", "annual"].includes(body?.billingCycle) ? body.billingCycle : lead.interestedBillingCycle || "monthly",
    requestedSlug: body?.slug,
    isMuslimCharity: typeof body?.isMuslimCharity === "boolean" ? body.isMuslimCharity : lead.verticalType === "muslim",
    revenueRange: ["0-500", "500-5000000", "5000000+"].includes(body?.revenueRange) ? body.revenueRange : toRevenueRange(lead.annualBudgetRange),
    theme: String(body?.theme || "default"),
    logoUrl: String(body?.logoUrl || "").trim(),
    couponCode: String(body?.couponCode || "").trim(),
  };
}

/**
 * (a) Send the lead an activation link into the existing self-serve Registration
 * flow, pre-filled from the operator's (corrected) form — they complete BOTH
 * their org details review and their own payment.
 * @returns {Promise<{link: string}>}
 */
async function createActivationLink(lead, body, req) {
  const fields = resolveFormFields(lead, body);
  if (!fields.orgName) throw fail(400, "Organisation name is required");
  if (!fields.adminName) throw fail(400, "Contact name is required");
  if (!/\S+@\S+\.\S+/.test(fields.adminEmail)) throw fail(400, "A valid contact email is required");

  // Persist any operator corrections onto the lead itself — the prefill
  // endpoint reads straight off these fields, so this is the only place that
  // needs to know about the override. revenueRange/theme/coupon have no home
  // on the Lead schema (they're Organisation/Stripe concepts the lead form
  // never asked about) — those ride along as link query params instead,
  // straight into the same fields RegistrationFlow.jsx already renders.
  lead.orgName = fields.orgName;
  lead.contactName = fields.adminName;
  lead.contactEmail = fields.adminEmail;
  lead.interestedPlan = fields.plan;
  lead.interestedBillingCycle = fields.billingCycle;
  lead.verticalType = fields.isMuslimCharity ? "muslim" : "general";

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const tokenExpiresAt = new Date(Date.now() + 14 * 24 * 3600 * 1000);

  lead.activation = {
    tokenHash,
    tokenExpiresAt,
    sentAt: new Date(),
    sentBy: req.user?._id || null,
    openedAt: null,
  };
  const prevStage = lead.stage;
  if (lead.stage === "new") lead.stage = "contacted";
  if (lead.stage !== prevStage) {
    lead.stageHistory.push({
      from: prevStage,
      to: lead.stage,
      changedBy: req.user?._id || null,
      changedByName: req.user?.name || req.user?.email || "",
      note: "Activation link sent",
      at: new Date(),
    });
  }
  await lead.save();

  const base = clientBaseUrl(req);
  const params = new URLSearchParams({ lead: token });
  if (fields.plan) params.set("plan", fields.plan);
  if (fields.billingCycle) params.set("billing", fields.billingCycle);
  if (fields.revenueRange) params.set("revenue", fields.revenueRange);
  params.set("charity", fields.isMuslimCharity ? "muslim" : "general");
  if (fields.theme && fields.theme !== "default") params.set("theme", fields.theme);
  if (fields.couponCode) params.set("coupon", fields.couponCode.toUpperCase());
  const link = `${base}/register?${params.toString()}`;

  const html = `
    <h2>Let's get ${fields.orgName} set up</h2>
    <p>Hi ${fields.adminName},</p>
    <p>Thanks for your interest — here's your link to finish setting up your organisation's portal. Your details are already filled in.</p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${link}" style="background:#047857;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600;">Continue setup</a>
    </div>
    <p>This link expires in 14 days. If you have any questions, just reply to this email.</p>
  `;
  const mail = await sendEmail(fields.adminEmail, html, `Let's get ${fields.orgName} set up`);
  if (!mail?.success) {
    console.error(`Activation link email to ${fields.adminEmail} FAILED:`, mail?.error?.message || mail?.message);
  }

  return { link };
}

/**
 * (b) Provision the Organisation + admin User directly — no Stripe
 * subscription, no client-side wizard. For comped/offline/negotiated deals.
 * @returns {Promise<{organisation: object, adminUser: object}>}
 */
async function manualProvision(lead, body, req) {
  const fields = resolveFormFields(lead, body);
  if (!fields.orgName) throw fail(400, "Organisation name is required");
  if (!fields.adminName) throw fail(400, "Admin name is required");
  if (!/\S+@\S+\.\S+/.test(fields.adminEmail)) throw fail(400, "A valid admin email is required");

  const existingUser = await User.findOne({ email: fields.adminEmail });
  if (existingUser) throw fail(400, "An account with this email already exists");

  const slug = await resolveSlug(fields.requestedSlug, fields.orgName);
  const isMuslimCharity = fields.isMuslimCharity;
  const isComp = body?.isComp !== false; // manual provisioning is comped by default
  const compReason = String(body?.compReason || "").trim() || "Converted from lead (manual provisioning)";
  const trialEndsAt = body?.trialEndsAt ? new Date(body.trialEndsAt) : null;
  const theme = getThemeColors(fields.theme);

  const organisation = await Organisation.create({
    name: fields.orgName,
    slug,
    plan: fields.plan,
    billingCycle: fields.billingCycle,
    revenueRange: fields.revenueRange,
    subscriptionStatus: "active",
    isActive: true,
    isMuslimCharity,
    isComp,
    compReason: isComp ? compReason : "",
    trialEndsAt,
    contactEmail: fields.adminEmail,
    contactPhone: lead.contactPhone || "",
    addressDetails: { country: lead.country || "" },
    website: lead.orgWebsite || "",
    sourceLeadId: lead._id,
    branding: {
      theme: fields.theme,
      primaryColor: theme.primaryColor,
      accentColor: theme.accentColor,
      backgroundColor: theme.backgroundColor,
      logo: fields.logoUrl,
    },
  });

  // Reset-password token, same mechanism as userController.forgotPassword —
  // this admin never had a password to begin with, so "reset" is really
  // "set for the first time".
  const resetToken = crypto.randomBytes(32).toString("hex");
  const resetPasswordToken = crypto.createHash("sha256").update(resetToken).digest("hex");
  const resetPasswordExpires = Date.now() + 7 * 24 * 3600 * 1000;

  const adminUser = await User.create({
    name: fields.adminName,
    email: fields.adminEmail,
    role: "admin",
    organisationId: organisation._id,
    resetPasswordToken,
    resetPasswordExpires,
  });

  organisation.adminUserId = adminUser._id;
  await organisation.save();

  await seedOrgDefaults(organisation._id, isMuslimCharity);

  const base = clientBaseUrl(req);
  const setPasswordUrl = `${base}/reset-password/${resetToken}`;
  const portalBase = process.env.CLIENT_URL ? process.env.CLIENT_URL.replace(/^https?:\/\//, "") : base.replace(/^https?:\/\//, "");
  const scheme = /^https:/.test(base) ? "https" : "http";
  const html = `
    <h2>Welcome to the Platform, ${fields.adminName}!</h2>
    <p>Your organisation <strong>${organisation.name}</strong> has been set up.</p>
    <p>Your portal is ready at: <a href="${scheme}://${organisation.slug}.${portalBase}">${scheme}://${organisation.slug}.${portalBase}</a></p>
    <p>Before you log in, set your password:</p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${setPasswordUrl}" style="background:#047857;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600;">Set your password</a>
    </div>
    <p>This link expires in 7 days.</p>
  `;
  const mail = await sendEmail(fields.adminEmail, html, `Welcome to ${organisation.name} — set up your account`);
  if (!mail?.success) {
    console.error(`Welcome email to ${fields.adminEmail} FAILED for ${organisation.slug}:`, mail?.error?.message || mail?.message);
  }

  const prevStage = lead.stage;
  lead.orgName = fields.orgName;
  lead.contactName = fields.adminName;
  lead.contactEmail = fields.adminEmail;
  lead.verticalType = isMuslimCharity ? "muslim" : "general";
  lead.stage = "won";
  lead.convertedOrgId = organisation._id;
  lead.convertedAt = new Date();
  lead.conversionMode = "manual_provision";
  lead.stageHistory.push({
    from: prevStage,
    to: "won",
    changedBy: req.user?._id || null,
    changedByName: req.user?.name || req.user?.email || "",
    note: "Manually provisioned (comped)",
    at: new Date(),
  });
  await lead.save();

  return { organisation, adminUser };
}

async function seedOrgDefaults(organisationId, isMuslimCharity) {
  try {
    await seedPagesForOrg(organisationId);
  } catch (e) {
    console.error("Failed to seed pages for converted lead org:", e.message);
  }
  try {
    const defaultTypes = isMuslimCharity
      ? ["Zakat ul Maal", "Zakat ul Fitr", "Sadaqah", "Sadaqah Jariyah", "Lillah", "Fidya & Kaffarah", "General Donation"]
      : ["General Donation", "Education Fund", "Water Fund", "Food Fund", "Emergency Fund", "Healthcare Fund"];
    await DonationType.insertMany(
      defaultTypes.map((donationType, order) => ({ organisationId, donationType, order })),
      { ordered: false }
    );
  } catch (e) {
    console.error("Failed to seed donation types for converted lead org:", e.message);
  }
}

/** Resolve a Stripe Price id the same way registrationController.register does. */
async function resolveStripePriceId(plan, billingCycle) {
  const planDoc = await Plan.findOne({ code: plan, isActive: true });
  return planDoc?.stripePriceIds?.[billingCycle] || stripePrices[plan]?.[billingCycle];
}

/**
 * (c) Create the Organisation + Stripe customer/subscription for an
 * operator-configured deal that still needs real payment — shared by "charge
 * now" (Elements in the console) and "send a payment link" (emailed). Mirrors
 * registrationController.register's Stripe piece exactly, minus the client
 * having typed anything: isActive stays false until orgActivation.js sees the
 * money move (webhook or a confirm call), same as self-serve.
 * @returns {Promise<{organisation: object, clientSecret: string}>}
 */
async function createPendingPaidOrg(lead, body, req) {
  const fields = resolveFormFields(lead, body);
  if (!fields.orgName) throw fail(400, "Organisation name is required");
  if (!fields.adminName) throw fail(400, "Admin name is required");
  if (!/\S+@\S+\.\S+/.test(fields.adminEmail)) throw fail(400, "A valid admin email is required");

  const existingUser = await User.findOne({ email: fields.adminEmail });
  if (existingUser) throw fail(400, "An account with this email already exists");

  const priceId = await resolveStripePriceId(fields.plan, fields.billingCycle);
  if (!priceId) throw fail(400, "Invalid plan or billing cycle");

  const slug = await resolveSlug(fields.requestedSlug, fields.orgName);
  const isMuslimCharity = fields.isMuslimCharity;
  const theme = getThemeColors(fields.theme);

  const organisation = await Organisation.create({
    name: fields.orgName,
    slug,
    plan: fields.plan,
    billingCycle: fields.billingCycle,
    revenueRange: fields.revenueRange,
    subscriptionStatus: "pending",
    isActive: false,
    isMuslimCharity,
    contactEmail: fields.adminEmail,
    contactPhone: lead.contactPhone || "",
    addressDetails: { country: lead.country || "" },
    website: lead.orgWebsite || "",
    sourceLeadId: lead._id,
    pendingAdminNoPassword: { name: fields.adminName, email: fields.adminEmail },
    branding: {
      theme: fields.theme,
      primaryColor: theme.primaryColor,
      accentColor: theme.accentColor,
      backgroundColor: theme.backgroundColor,
      logo: fields.logoUrl,
    },
  });

  // Seeded immediately (regardless of payment status), same as self-serve
  // registration — an admin who hasn't paid yet still has somewhere to land
  // the moment they do, with no seeding step deferred onto activation.
  await seedOrgDefaults(organisation._id, isMuslimCharity);

  const customer = await stripe.customers.create({
    email: fields.adminEmail,
    name: fields.orgName,
    metadata: { orgSlug: slug, orgId: organisation._id.toString() },
  });
  organisation.stripeCustomerId = customer.id;
  await organisation.save();

  // Optional discount coupon — same validation registrationController.register
  // runs (plan whitelist, expiry, live-from-Stripe redemption count) so a
  // stale local mirror can't let an exhausted or plan-mismatched code through.
  let stripeCouponId;
  if (fields.couponCode) {
    try {
      const coupon = await Coupon.findOne({ code: fields.couponCode.toUpperCase(), isActive: true });
      const okPlan = coupon && (!coupon.planCodes?.length || coupon.planCodes.includes(fields.plan));
      const okExpiry = coupon && (!coupon.redeemBy || new Date(coupon.redeemBy) > new Date());
      let okRedemptions = false;
      if (coupon) {
        const used = coupon.maxRedemptions ? await refreshRedemptions(coupon) : 0;
        okRedemptions = hasRedemptionsLeft(coupon, used);
      }
      if (coupon && coupon.stripeCouponId && okPlan && okExpiry && okRedemptions) stripeCouponId = coupon.stripeCouponId;
    } catch (e) {
      console.error("Coupon apply failed:", e.message);
    }
  }

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: priceId }],
    ...(stripeCouponId ? { coupon: stripeCouponId } : {}),
    payment_behavior: "default_incomplete",
    payment_settings: { save_default_payment_method: "on_subscription" },
    expand: ["latest_invoice.payment_intent"],
    metadata: { type: "saas_subscription", orgId: organisation._id.toString(), plan: fields.plan, billingCycle: fields.billingCycle },
  });
  organisation.stripeSubscriptionId = subscription.id;
  await organisation.save();

  const clientSecret = subscription.latest_invoice?.payment_intent?.client_secret;
  if (!clientSecret) throw fail(500, "Could not initialise payment. Please try again.");

  return { organisation, clientSecret };
}

/** (c-i) "Charge now" — the operator collects the card in the Convert modal. */
async function beginChargeNow(lead, body, req) {
  const { organisation, clientSecret } = await createPendingPaidOrg(lead, body, req);

  const prevStage = lead.stage;
  lead.orgName = organisation.name;
  lead.contactName = organisation.pendingAdminNoPassword?.name || lead.contactName;
  lead.contactEmail = organisation.pendingAdminNoPassword?.email || lead.contactEmail;
  lead.interestedPlan = organisation.plan;
  lead.interestedBillingCycle = organisation.billingCycle;
  lead.verticalType = organisation.isMuslimCharity ? "muslim" : "general";
  if (lead.stage === "new") lead.stage = "contacted";
  if (lead.stage !== prevStage) {
    lead.stageHistory.push({
      from: prevStage,
      to: lead.stage,
      changedBy: req.user?._id || null,
      changedByName: req.user?.name || req.user?.email || "",
      note: "Charging card for manual provisioning",
      at: new Date(),
    });
  }
  await lead.save();

  return { organisation, clientSecret };
}

/** (c-ii) "Send a payment link" — emails the customer straight to the Payment step. */
async function sendPaymentLink(lead, body, req) {
  const { organisation } = await createPendingPaidOrg(lead, body, req);

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const tokenExpiresAt = new Date(Date.now() + 14 * 24 * 3600 * 1000);

  lead.orgName = organisation.name;
  lead.contactName = organisation.pendingAdminNoPassword?.name || lead.contactName;
  lead.contactEmail = organisation.pendingAdminNoPassword?.email || lead.contactEmail;
  lead.interestedPlan = organisation.plan;
  lead.interestedBillingCycle = organisation.billingCycle;
  lead.verticalType = organisation.isMuslimCharity ? "muslim" : "general";
  lead.activation = { tokenHash, tokenExpiresAt, sentAt: new Date(), sentBy: req.user?._id || null, openedAt: null };
  const prevStage = lead.stage;
  if (lead.stage === "new") lead.stage = "contacted";
  if (lead.stage !== prevStage) {
    lead.stageHistory.push({
      from: prevStage,
      to: lead.stage,
      changedBy: req.user?._id || null,
      changedByName: req.user?.name || req.user?.email || "",
      note: "Payment link sent",
      at: new Date(),
    });
  }
  await lead.save();

  const base = clientBaseUrl(req);
  const link = `${base}/register?lead=${token}`;
  const html = `
    <h2>${organisation.name} is ready — just payment left</h2>
    <p>Hi ${organisation.pendingAdminNoPassword?.name || ""},</p>
    <p>Your organisation's portal is fully configured. Complete payment to activate it:</p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${link}" style="background:#047857;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600;">Complete payment</a>
    </div>
    <p>This link expires in 14 days. If you have any questions, just reply to this email.</p>
  `;
  const mail = await sendEmail(organisation.contactEmail, html, `${organisation.name} is ready — just payment left`);
  if (!mail?.success) {
    console.error(`Payment link email to ${organisation.contactEmail} FAILED:`, mail?.error?.message || mail?.message);
  }

  return { link, organisation };
}

module.exports = { createActivationLink, manualProvision, beginChargeNow, sendPaymentLink };
