/**
 * services/tenantProvisioning.js — create a live Organisation and its owner
 * (admin) User in one step, with no card payment.
 *
 * This is the operator path, not self-serve checkout: self-serve registration
 * (controllers/saas/registrationController.js) needs the customer's card in a
 * browser, which a server-to-server caller can never supply. Used by:
 *   - services/leadConversion.js manualProvision  (SuperAdmin Leads → Convert)
 *   - POST /api/integration/tenants                (Calcite Hyper)
 *
 * Seeds the same defaults self-serve signup does (website pages + donation
 * types). The tenant carries no Stripe subscription: it is comped, on a trial
 * window, or invoiced outside Stripe.
 */
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const Organisation = require("../models/organisation");
const User = require("../models/user");
const Plan = require("../models/plan");
const DonationType = require("../models/donationtypes");
const { seedPagesForOrg } = require("./pageService");
const { getThemeColors } = require("../config/themePresets");
const { LEGACY_PLAN_CODES } = require("./tenantLifecycle");
const { ServiceError } = require("../utils/serviceError");

// Same rule as controllers/saas/registrationController.js: a slug becomes a DNS
// label in <slug>.<domain>, so no leading/trailing or doubled hyphens.
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_SLUGS = ["admin", "www", "api", "app", "mail", "ftp", "localhost"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

async function uniqueSlugFromName(orgName) {
  let base = String(orgName || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  if (!base || base.length < 3 || !SLUG_REGEX.test(base)) base = base && SLUG_REGEX.test(base) ? `${base}-org` : "org";

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

/**
 * Resolve the slug to use.
 * strict:true  — a requested slug must be valid and free, or this throws.
 * strict:false — an unusable requested slug silently falls back to one derived
 *                from the name (the Leads convert modal's long-standing behaviour).
 */
async function resolveSlug(requestedSlug, orgName, { strict = false } = {}) {
  const s = String(requestedSlug || "").toLowerCase().trim();
  if (!s) return uniqueSlugFromName(orgName);
  const problem =
    s.length < 3 || s.length > 63
      ? "Slug must be 3–63 characters"
      : !SLUG_REGEX.test(s)
        ? "Slug must be lowercase letters, numbers and single hyphens between them"
        : RESERVED_SLUGS.includes(s)
          ? "This slug is reserved"
          : null;
  if (problem) {
    if (strict) throw new ServiceError(400, "INVALID_SLUG", problem, { field: "slug" });
    return uniqueSlugFromName(orgName);
  }
  if (await Organisation.exists({ slug: s })) {
    if (strict) throw new ServiceError(409, "SLUG_TAKEN", `The slug "${s}" is already in use`, { field: "slug" });
    return uniqueSlugFromName(orgName);
  }
  return s;
}

async function seedOrgDefaults(organisationId, isMuslimCharity) {
  try {
    await seedPagesForOrg(organisationId);
  } catch (e) {
    console.error("Failed to seed pages for provisioned org:", e.message);
  }
  try {
    const defaultTypes = isMuslimCharity
      ? ["Zakat ul Maal", "Zakat ul Fitr", "Sadaqah", "Sadaqah Jariyah", "Lillah", "Fidya & Kaffarah", "General Donation"]
      : ["General Donation", "Education Fund", "Water Fund", "Food Fund", "Emergency Fund", "Healthcare Fund"];
    await DonationType.insertMany(
      defaultTypes.map((donationType, order) => ({ organisationId, donationType, order })),
      { ordered: false },
    );
  } catch (e) {
    console.error("Failed to seed donation types for provisioned org:", e.message);
  }
}

/** A random password that satisfies any sane policy (upper, lower, digit, symbol). */
function generatePassword() {
  const body = crypto.randomBytes(18).toString("base64url"); // 24 chars
  return `${body}A9!`;
}

/**
 * @param {object} f
 * @param {string} f.orgName
 * @param {string} f.adminName
 * @param {string} f.adminEmail
 * @param {string} [f.slug]
 * @param {string} [f.plan="essentials"]
 * @param {"monthly"|"annual"} [f.billingCycle="monthly"]
 * @param {string} [f.revenueRange]
 * @param {boolean} [f.isMuslimCharity=false]
 * @param {string} [f.theme="default"]
 * @param {string} [f.logoUrl]
 * @param {object} [f.extra]            extra Organisation fields (contactPhone, website, sourceLeadId…)
 * @param {object} opts
 * @param {boolean} [opts.isComp=true]
 * @param {string}  [opts.compReason]
 * @param {Date|null} [opts.trialEndsAt]
 * @param {"reset_token"|"password"|"generate"} [opts.credentials="reset_token"]
 *        reset_token — no password; a 7-day set-password token is issued
 *        password    — use opts.password
 *        generate    — mint a password, returned once, AND issue a set-password token
 * @param {string}  [opts.password]
 * @param {boolean} [opts.strictSlug=false]
 * @param {boolean} [opts.validatePlan=false]  refuse unknown/archived plan codes
 * @returns {Promise<{organisation, adminUser, resetToken:string|null, generatedPassword:string|null}>}
 */
async function provisionOrganisation(f, opts = {}) {
  const orgName = String(f.orgName || "").trim();
  const adminName = String(f.adminName || "").trim();
  const adminEmail = String(f.adminEmail || "").trim().toLowerCase();
  if (!orgName) throw new ServiceError(400, "VALIDATION_ERROR", "Organisation name is required", { field: "organization_name" });
  if (orgName.length > 200) throw new ServiceError(400, "VALIDATION_ERROR", "Organisation name must be 200 characters or fewer", { field: "organization_name" });
  if (!adminName) throw new ServiceError(400, "VALIDATION_ERROR", "Admin name is required", { field: "first_name" });
  if (!EMAIL_RE.test(adminEmail) || adminEmail.length > 254) {
    throw new ServiceError(400, "VALIDATION_ERROR", "A valid admin email is required", { field: "email" });
  }

  const credentials = opts.credentials || "reset_token";
  if (credentials === "password") {
    const pw = typeof opts.password === "string" ? opts.password : "";
    if (pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) {
      throw new ServiceError(400, "VALIDATION_ERROR", `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters`, { field: "password" });
    }
  }

  const plan = String(f.plan || "essentials").toLowerCase().trim();
  const billingCycle = f.billingCycle === "annual" ? "annual" : "monthly";
  if (opts.validatePlan) {
    const planDoc = await Plan.findOne({ code: plan });
    if (!planDoc && !LEGACY_PLAN_CODES.includes(plan)) throw new ServiceError(404, "PLAN_NOT_FOUND", `No plan "${plan}"`, { plan_code: plan });
    if (planDoc && planDoc.isActive === false) throw new ServiceError(409, "PLAN_ARCHIVED", `"${plan}" is archived and can't be assigned`, { plan_code: plan });
  }

  // users.email is unique across the WHOLE platform, not per tenant.
  if (await User.exists({ email: adminEmail })) {
    throw new ServiceError(409, "EMAIL_IN_USE", "An account with this email already exists", { field: "email" });
  }

  const slug = await resolveSlug(f.slug, orgName, { strict: !!opts.strictSlug });
  const isMuslimCharity = !!f.isMuslimCharity;
  const isComp = opts.isComp !== false;
  const theme = getThemeColors(f.theme || "default");

  let organisation;
  try {
    organisation = await Organisation.create({
      name: orgName,
      slug,
      plan,
      billingCycle,
      ...(f.revenueRange ? { revenueRange: f.revenueRange } : {}),
      subscriptionStatus: "active",
      isActive: true,
      isMuslimCharity,
      isComp,
      compReason: isComp ? String(opts.compReason || "").trim() || "Provisioned without card billing" : "",
      trialEndsAt: opts.trialEndsAt || null,
      contactEmail: adminEmail,
      branding: {
        theme: f.theme || "default",
        primaryColor: theme.primaryColor,
        accentColor: theme.accentColor,
        backgroundColor: theme.backgroundColor,
        logo: f.logoUrl || "",
      },
      ...(f.extra || {}),
    });
  } catch (err) {
    if (err && err.code === 11000) throw new ServiceError(409, "SLUG_TAKEN", `The slug "${slug}" is already in use`, { field: "slug" });
    throw err;
  }

  let resetToken = null;
  let generatedPassword = null;
  const userDoc = { name: adminName, email: adminEmail, role: "admin", organisationId: organisation._id };
  if (credentials === "password") {
    userDoc.password = await bcrypt.hash(opts.password, 10);
  } else {
    if (credentials === "generate") {
      generatedPassword = generatePassword();
      userDoc.password = await bcrypt.hash(generatedPassword, 10);
    }
    // Same mechanism as userController.forgotPassword — for a provisioned admin
    // "reset" is really "set for the first time".
    resetToken = crypto.randomBytes(32).toString("hex");
    userDoc.resetPasswordToken = crypto.createHash("sha256").update(resetToken).digest("hex");
    userDoc.resetPasswordExpires = Date.now() + 7 * 24 * 3600 * 1000;
  }

  let adminUser;
  try {
    adminUser = await User.create(userDoc);
  } catch (err) {
    // The org row is seconds old and nothing references it yet — remove it
    // rather than leave a live tenant with no owner behind.
    await Organisation.deleteOne({ _id: organisation._id }).catch(() => {});
    if (err && err.code === 11000) throw new ServiceError(409, "EMAIL_IN_USE", "An account with this email already exists", { field: "email" });
    throw err;
  }

  organisation.adminUserId = adminUser._id;
  await organisation.save();
  await seedOrgDefaults(organisation._id, isMuslimCharity);

  return { organisation, adminUser, resetToken, generatedPassword };
}

module.exports = { provisionOrganisation, resolveSlug, uniqueSlugFromName, seedOrgDefaults, SLUG_REGEX, RESERVED_SLUGS };
