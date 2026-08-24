/**
 * services/orgActivation.js — the ONE way a pending organisation goes live.
 *
 * Registration creates the org with isActive:false and stashes the admin
 * credentials in `pendingAdmin`. Exactly one function materialises that admin and
 * flips the org active, and it is called from three places:
 *
 *   1. the SaaS Stripe webhook            (invoice.paid / subscription.updated)
 *   2. POST /api/saas/register/confirm    (the browser, right after the card is
 *                                          confirmed — so activation does not
 *                                          depend on webhook delivery)
 *   3. scripts/diagnoseRegistration.js --activate   (repair an org left behind)
 *
 * It is idempotent: whichever caller gets there first wins and the others are
 * no-ops. Callers are responsible for proving the money moved — this function
 * trusts them.
 */
const crypto = require("crypto");
const Organisation = require("../models/organisation");
const User = require("../models/user");
const Lead = require("../models/lead");
const { sendEmail } = require("./emailUtil");
const { emitToSuperAdmins } = require("./socket");

/** The tenant's portal host, e.g. `acme.charities.ltd`. */
function portalHost(organisation) {
  const base = process.env.CLIENT_URL
    ? process.env.CLIENT_URL.replace(/^https?:\/\//, "")
    : process.env.CORS_DOMAIN || "localhost";
  return `${organisation.slug}.${base}`;
}

/** Protocol to use in emailed links — plain http for localhost, https otherwise. */
function portalScheme() {
  const base = process.env.CLIENT_URL || "";
  if (/^https:/.test(base)) return "https";
  if (/^http:/.test(base)) return "http";
  return "http";
}

/** The MAIN app's base URL (not a tenant subdomain) — where /reset-password/:token lives. */
function mainAppBaseUrl() {
  return process.env.CLIENT_URL || "http://localhost:5173";
}

/**
 * If this org came from a SuperAdmin Leads CRM activation/payment link, flip
 * the source Lead to "won" now that the org is genuinely live. Best-effort and
 * silent on failure — a Lead bookkeeping miss must never surface as (or be
 * mistaken for) an activation failure.
 *
 * @param {"activation_link"|"manual_provision_paid"} conversionMode which Leads
 *   flow this org came from — password-based pendingAdmin means the visitor
 *   completed self-serve Registration themselves (activation_link); a
 *   reset-token admin (pendingAdminNoPassword) means the operator already
 *   configured the org and only payment was outstanding (manual_provision_paid).
 */
async function flipSourceLead(organisation, conversionMode) {
  if (!organisation.sourceLeadId) return;
  try {
    const lead = await Lead.findById(organisation.sourceLeadId);
    if (!lead || lead.stage === "won") return;
    const from = lead.stage;
    lead.stage = "won";
    lead.convertedOrgId = organisation._id;
    lead.convertedAt = new Date();
    lead.conversionMode = conversionMode;
    lead.stageHistory.push({
      from,
      to: "won",
      note: conversionMode === "manual_provision_paid" ? "Payment completed" : "Completed self-serve registration",
      at: new Date(),
    });
    await lead.save();
    emitToSuperAdmins("lead:converted", { id: String(lead._id), organisationId: String(organisation._id) });
  } catch (err) {
    console.error("Failed to flip source lead to won:", err.message);
  }
}

/**
 * Activate an org after its first successful subscription payment: create the
 * admin User from `pendingAdmin` (if not already), flip the org active, and send
 * the welcome email.
 *
 * Idempotent and concurrency-safe — safe to call from invoice.paid AND
 * subscription.updated AND the browser confirm call, in any order, simultaneously.
 *
 * @returns {Promise<{activated: boolean, alreadyActive: boolean, adminEmail: string|null}>}
 */
async function activateOrgWithAdmin(organisation, { subscriptionId, customerId } = {}) {
  const wasActive = !!(organisation.isActive && organisation.adminUserId);

  const setActive = () => {
    organisation.isActive = true;
    organisation.subscriptionStatus = "active";
    if (subscriptionId) organisation.stripeSubscriptionId = subscriptionId;
    if (customerId) organisation.stripeCustomerId = customerId;
  };

  // Already has an admin → just ensure the active flags are set.
  if (organisation.adminUserId) {
    setActive();
    await organisation.save();
    if (!wasActive) emitToSuperAdmins("organisation:updated", { organisationId: String(organisation._id) });
    return { activated: !wasActive, alreadyActive: wasActive, adminEmail: null };
  }

  // SNAPSHOT the credentials as primitives before anything clears them.
  // `pendingAdmin`/`pendingAdminNoPassword` are nested paths, not subdocuments:
  // clearing them (below, and via $unset) empties the very object a
  // `const pending = organisation.pendingAdmin` reference points at. Reading
  // `pending.email` afterwards yielded undefined, which is why the welcome
  // email died with "No recipients defined".
  const pendingName = String(organisation.pendingAdmin?.name || "");
  const pendingEmail = String(organisation.pendingAdmin?.email || "").toLowerCase();
  const pendingHash = String(organisation.pendingAdmin?.passwordHash || "");

  // The SuperAdmin Leads "Convert" flow (charge now / send a payment link)
  // never collects a password up front — the admin sets one via a reset-token
  // email instead. Only consulted when there's no password-based pendingAdmin.
  const noPwName = String(organisation.pendingAdminNoPassword?.name || "");
  const noPwEmail = String(organisation.pendingAdminNoPassword?.email || "").toLowerCase();

  const usingPassword = !!(pendingEmail && pendingHash);
  const usingResetToken = !usingPassword && !!noPwEmail;

  if (!usingPassword && !usingResetToken) {
    setActive();
    await organisation.save();
    if (!wasActive) emitToSuperAdmins("organisation:updated", { organisationId: String(organisation._id) });
    return { activated: !wasActive, alreadyActive: wasActive, adminEmail: null };
  }

  const adminEmail = usingPassword ? pendingEmail : noPwEmail;
  const adminName = usingPassword ? pendingName : noPwName;

  // Only the reset-token path needs a token generated up front (the
  // password-based path already has its hash); computed outside the User
  // lookup below so a re-run (race loser) doesn't mint a second unused token.
  let resetToken = null;
  let resetPasswordToken = null;
  const resetPasswordExpires = Date.now() + 7 * 24 * 3600 * 1000;
  if (usingResetToken) {
    resetToken = crypto.randomBytes(32).toString("hex");
    resetPasswordToken = crypto.createHash("sha256").update(resetToken).digest("hex");
  }

  // Materialise the admin user (guard against a race / event re-run).
  let adminUser = await User.findOne({ email: adminEmail });
  if (!adminUser) {
    adminUser = await User.create(
      usingPassword
        ? { name: adminName, email: adminEmail, password: pendingHash, role: "admin", organisationId: organisation._id }
        : { name: adminName, email: adminEmail, role: "admin", organisationId: organisation._id, resetPasswordToken, resetPasswordExpires }
    );
  }

  // Claim the activation atomically: only the caller that actually transitions
  // adminUserId from unset → set sends the welcome email. Two concurrent callers
  // (webhook + browser confirm) therefore produce exactly one email.
  const claim = await Organisation.findOneAndUpdate(
    { _id: organisation._id, adminUserId: { $in: [null, undefined] } },
    {
      $set: {
        adminUserId: adminUser._id,
        isActive: true,
        subscriptionStatus: "active",
        ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
        ...(customerId ? { stripeCustomerId: customerId } : {}),
      },
      $unset: usingPassword ? { pendingAdmin: "" } : { pendingAdminNoPassword: "" },
    },
    { new: true }
  );

  if (!claim) {
    // Someone else won the race — they own the email. Make sure flags are set.
    await Organisation.updateOne(
      { _id: organisation._id },
      { $set: { isActive: true, subscriptionStatus: "active" } }
    );
    return { activated: false, alreadyActive: true, adminEmail };
  }

  // Keep the caller's in-memory doc consistent with what we just wrote.
  organisation.adminUserId = adminUser._id;
  organisation.isActive = true;
  organisation.subscriptionStatus = "active";
  if (usingPassword) organisation.pendingAdmin = undefined;
  else organisation.pendingAdminNoPassword = undefined;

  const scheme = portalScheme();
  const host = portalHost(claim);
  const emailBody = usingPassword
    ? `
    <h2>Welcome to the Platform, ${adminName}!</h2>
    <p>Your organisation <strong>${claim.name}</strong> has been set up successfully.</p>
    <p>Your portal is ready at: <a href="${scheme}://${host}">${scheme}://${host}</a></p>
    <h3>Your Admin Account</h3>
    <ul>
      <li><strong>Email:</strong> ${adminEmail}</li>
      <li><strong>Plan:</strong> ${claim.plan}</li>
      <li><strong>Billing:</strong> ${claim.billingCycle}</li>
    </ul>
    <p>Log in at <a href="${scheme}://${host}/admin/login">${scheme}://${host}/admin/login</a> to start setting up your portal.</p>
  `
    : `
    <h2>Welcome to the Platform, ${adminName}!</h2>
    <p>Your organisation <strong>${claim.name}</strong> has been set up and your payment received — you're all set.</p>
    <p>Your portal is ready at: <a href="${scheme}://${host}">${scheme}://${host}</a></p>
    <p>Before you log in, set your password:</p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${mainAppBaseUrl()}/reset-password/${resetToken}" style="background:#047857;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600;">Set your password</a>
    </div>
    <p>This link expires in 7 days.</p>
  `;
  const mail = await sendEmail(adminEmail, emailBody, `Welcome to ${claim.name} - Your Portal is Ready!`);
  if (!mail?.success) {
    // Never fail activation over an email — but make it loud, because a silent
    // failure here means a paying tenant has no idea their portal is ready.
    console.error(`Welcome email to ${adminEmail} FAILED for ${claim.slug}:`, mail?.error?.message || mail?.message);
  }

  console.log(`Organisation ${claim.slug} activated`);
  emitToSuperAdmins("organisation:updated", { organisationId: String(claim._id) });
  await flipSourceLead(claim, usingPassword ? "activation_link" : "manual_provision_paid");
  return { activated: true, alreadyActive: false, adminEmail };
}

module.exports = { activateOrgWithAdmin, portalHost, portalScheme };
