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
const Plan = require("../models/plan");
const Coupon = require("../models/coupon");
const stripePrices = require("../config/stripePrices");
const { refreshRedemptions, hasRedemptionsLeft } = require("../utils/couponRedemptions");
const { stripe } = require("./platformStripe");
const { sendTemplateEmail } = require("./emailUtil");
const { getThemeColors } = require("../config/themePresets");
const { provisionOrganisation, resolveSlug, seedOrgDefaults } = require("./tenantProvisioning");
const { isServiceError } = require("../utils/serviceError");
const { actorOf } = require("../utils/actor");

function clientBaseUrl(req) {
  return process.env.CLIENT_URL || `${req.protocol}://${req.get("host")}`;
}

function fail(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  err.publicMessage = message;
  return err;
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
    plan: String(body?.plan || lead.interestedPlan || "essentials"),
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
 * @returns {Promise<{link: string, emailStatus: "sent"|"failed"}>}
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
    sentBy: actorOf(req).id,
    openedAt: null,
  };
  const prevStage = lead.stage;
  if (lead.stage === "new") lead.stage = "contacted";
  if (lead.stage !== prevStage) {
    lead.stageHistory.push({
      from: prevStage,
      to: lead.stage,
      changedBy: actorOf(req).id,
      changedByName: actorOf(req).name,
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

  const mail = await sendTemplateEmail("lead.onboardingInvite", {
    to: fields.adminEmail,
    data: {
      recipient: { name: fields.adminName || "", email: fields.adminEmail },
      lead: { orgName: fields.orgName },
      onboarding: { url: link, expiresIn: "14 days" },
    },
    meta: { leadId: String(lead._id) },
  });
  if (!mail?.success) {
    console.error(`Activation link email to ${fields.adminEmail} FAILED:`, mail?.error?.message || mail?.message);
  }

  return { link, emailStatus: mail?.success ? "sent" : "failed" };
}

/**
 * (b) Provision the Organisation + admin User directly — no Stripe
 * subscription, no client-side wizard. For comped/offline/negotiated deals.
 * @returns {Promise<{organisation: object, adminUser: object, emailStatus: "sent"|"failed"}>}
 */
async function manualProvision(lead, body, req) {
  const fields = resolveFormFields(lead, body);
  if (!fields.orgName) throw fail(400, "Organisation name is required");
  if (!fields.adminName) throw fail(400, "Admin name is required");
  if (!/\S+@\S+\.\S+/.test(fields.adminEmail)) throw fail(400, "A valid admin email is required");

  const isMuslimCharity = fields.isMuslimCharity;
  let provisioned;
  try {
    provisioned = await provisionOrganisation(
      {
        orgName: fields.orgName,
        adminName: fields.adminName,
        adminEmail: fields.adminEmail,
        slug: fields.requestedSlug,
        plan: fields.plan,
        billingCycle: fields.billingCycle,
        revenueRange: fields.revenueRange,
        isMuslimCharity,
        theme: fields.theme,
        logoUrl: fields.logoUrl,
        extra: {
          contactPhone: lead.contactPhone || "",
          addressDetails: { country: lead.country || "" },
          website: lead.orgWebsite || "",
          sourceLeadId: lead._id,
        },
      },
      {
        isComp: body?.isComp !== false, // manual provisioning is comped by default
        compReason: String(body?.compReason || "").trim() || "Converted from lead (manual provisioning)",
        trialEndsAt: body?.trialEndsAt ? new Date(body.trialEndsAt) : null,
        credentials: "reset_token",
      },
    );
  } catch (err) {
    if (isServiceError(err)) throw fail(err.code === "EMAIL_IN_USE" ? 400 : err.status, err.message);
    throw err;
  }
  const { organisation, adminUser, resetToken } = provisioned;

  const base = clientBaseUrl(req);
  const setPasswordUrl = `${base}/reset-password/${resetToken}`;
  const portalBase = process.env.CLIENT_URL ? process.env.CLIENT_URL.replace(/^https?:\/\//, "") : base.replace(/^https?:\/\//, "");
  const scheme = /^https:/.test(base) ? "https" : "http";
  const mail = await sendTemplateEmail("lead.convertedWelcome", {
    to: fields.adminEmail,
    data: {
      recipient: { name: fields.adminName || "", email: fields.adminEmail },
      tenant: {
        name: organisation.name,
        // The set-password link IS the way in here — there is no password to
        // reveal, so the template's login button gives way to it.
        loginUrl: setPasswordUrl,
        portalUrl: `${scheme}://${organisation.slug}.${portalBase}`,
        adminEmail: fields.adminEmail,
      },
    },
    meta: { organisationId: String(organisation._id), leadId: String(lead._id) },
  });
  if (!mail?.success) {
    console.error(`Welcome email to ${fields.adminEmail} FAILED for ${organisation.slug}:`, mail?.error?.message || mail?.message);
  }
  const emailStatus = mail?.success ? "sent" : "failed";

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
    changedBy: actorOf(req).id,
    changedByName: actorOf(req).name,
    note: "Manually provisioned (comped)",
    at: new Date(),
  });
  await lead.save();

  return { organisation, adminUser, emailStatus };
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
      changedBy: actorOf(req).id,
      changedByName: actorOf(req).name,
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
  lead.activation = { tokenHash, tokenExpiresAt, sentAt: new Date(), sentBy: actorOf(req).id, openedAt: null };
  const prevStage = lead.stage;
  if (lead.stage === "new") lead.stage = "contacted";
  if (lead.stage !== prevStage) {
    lead.stageHistory.push({
      from: prevStage,
      to: lead.stage,
      changedBy: actorOf(req).id,
      changedByName: actorOf(req).name,
      note: "Payment link sent",
      at: new Date(),
    });
  }
  await lead.save();

  const base = clientBaseUrl(req);
  const link = `${base}/register?lead=${token}`;
  const mail = await sendTemplateEmail("lead.paymentPending", {
    to: organisation.contactEmail,
    data: {
      recipient: {
        name: organisation.pendingAdminNoPassword?.name || "",
        email: organisation.contactEmail,
      },
      tenant: { name: organisation.name },
      billing: {
        plan: organisation.plan || "",
        amount: 0,
        currency: "AUD",
        payUrl: link,
      },
    },
    meta: { organisationId: String(organisation._id), leadId: String(lead._id) },
  });
  if (!mail?.success) {
    console.error(`Payment link email to ${organisation.contactEmail} FAILED:`, mail?.error?.message || mail?.message);
  }

  return { link, organisation, emailStatus: mail?.success ? "sent" : "failed" };
}

module.exports = { createActivationLink, manualProvision, beginChargeNow, sendPaymentLink };
