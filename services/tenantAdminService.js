/**
 * services/tenantAdminService.js — what a platform operator can do FOR (or TO)
 * a charity's own admin account: list, suspend/reactivate, force logout,
 * unlock, reset two-factor, send a password reset, require two-factor.
 *
 * Shared by the SuperAdmin console (controllers/superAdminUserController.js)
 * and the integration API (controllers/integration/tenantController.js).
 * Failures throw ServiceError; nothing here writes a response.
 *
 * Every lookup filters on `role: "admin"`. That is the guard, not decoration:
 * without it these actions would be a second, unguarded way to suspend a
 * platform OPERATOR — bypassing the owner guard and last-active-owner check
 * that protect the operator table.
 */
const crypto = require("crypto");
const User = require("../models/user");
const writeAudit = require("../utils/writeAudit");
const input = require("../utils/operatorInput");
const { sendTemplateEmail } = require("./emailUtil");
const { getOrgIdentity } = require("../utils/orgIdentity");
const { mfaPolicyOf, mfaRequiredFor } = require("../config/platformRoles");
const { ServiceError } = require("../utils/serviceError");

const LIST_FIELDS = "name email lastLogin createdAt organisationId platformStatus twoFactorEnabled mfaPolicy mfaExempt lockedUntil failedLoginAttempts";

const activeLock = (u) => (u.lockedUntil && u.lockedUntil > new Date() ? u.lockedUntil : null);

/**
 * Everything a row needs, in the console's shape. Projected explicitly — a full
 * document carries the password hash and 2FA secret.
 */
function tenantAdminState(u) {
  return {
    _id: u._id,
    status: u.platformStatus === "suspended" ? "suspended" : "active",
    twoFactorEnabled: !!u.twoFactorEnabled,
    // Whether they have it ON is theirs to decide; whether they MUST is the operator's.
    mfaPolicy: mfaPolicyOf(u) === "required" ? "required" : "default",
    mfaRequired: mfaRequiredFor(u),
    // Only while it is still in force — an expired lockout is history, not a state.
    lockedUntil: activeLock(u),
    lastLogin: u.lastLogin || null,
  };
}

/**
 * Every tenant admin, optionally for one organisation.
 * @param {object} [opts]
 * @param {import("mongoose").Types.ObjectId|string} [opts.organisationId]
 * @returns {Promise<object[]>} lean users with `organisationId` populated
 */
async function listTenantAdmins({ organisationId } = {}) {
  const filter = { role: "admin" };
  if (organisationId) filter.organisationId = organisationId;
  return User.find(filter).select(LIST_FIELDS).populate("organisationId", "name slug isActive").sort({ createdAt: 1 }).lean();
}

/**
 * Load a tenant admin, or throw 404. With `organisationId`, an admin of a
 * DIFFERENT tenant is also a 404 — the integration routes are tenant-scoped,
 * and an id from another tenant must not act across that boundary.
 */
async function findTenantAdmin(id, { organisationId } = {}) {
  if (!input.isObjectId(String(id || ""))) throw new ServiceError(400, "VALIDATION_ERROR", "That admin id is not valid", { field: "user_id" });
  const filter = { _id: id, role: "admin" };
  if (organisationId) filter.organisationId = organisationId;
  const user = await User.findOne(filter);
  if (!user) throw new ServiceError(404, "TENANT_ADMIN_NOT_FOUND", "Tenant admin not found", { user_id: String(id) });
  return user;
}

const auditExtra = (user, meta = {}) => ({
  organisationId: user.organisationId || undefined,
  targetType: "user",
  targetId: String(user._id),
  meta: { email: user.email, ...meta },
});

/**
 * Suspend or reactivate. Suspending bumps `tokenVersion`, which makes it
 * immediate: loginAdmin refuses a suspended account, but a token already in
 * their browser is good for 30 days. Reactivating bumps it too, so a stale tab
 * can't come back holding pre-suspension state, and clears any lockout.
 *
 * This does NOT touch the organisation — the charity's site and donors are
 * unaffected. Stopping the whole tenant is the tenant-status action.
 */
async function setStatus(user, status, req, { reason = "" } = {}) {
  const v = input.oneOf(status, "Status", ["active", "suspended"]);
  if (v.error) throw new ServiceError(400, "VALIDATION_ERROR", v.error, { field: "status" });

  user.platformStatus = v.value;
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  if (v.value === "active") {
    // Reactivating someone who is also locked out is a support call we'd take twice.
    user.lockedUntil = null;
    user.failedLoginAttempts = 0;
  }
  await user.save();
  await writeAudit(req, v.value === "suspended" ? "tenant_admin.suspended" : "tenant_admin.reactivated", auditExtra(user, reason ? { reason } : {}));
  return { user, message: v.value === "suspended" ? "Admin suspended and signed out" : "Admin reactivated" };
}

/** End every session without touching the account (lost laptop, departed staff). */
async function forceLogout(user, req, { reason = "" } = {}) {
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();
  await writeAudit(req, "tenant_admin.force_logout", auditExtra(user, reason ? { reason } : {}));
  return { user, message: "Signed out of all sessions" };
}

/** Clear the five-failed-attempts lockout (see loginAdmin). */
async function unlock(user, req, { reason = "" } = {}) {
  user.lockedUntil = null;
  user.failedLoginAttempts = 0;
  await user.save();
  await writeAudit(req, "tenant_admin.unlocked", auditExtra(user, reason ? { reason } : {}));
  return { user, message: "Lockout cleared" };
}

/**
 * Turn two-factor OFF so the admin can enrol a new authenticator ("new phone,
 * old codes gone"). The most dangerous action here — it removes a factor from
 * someone else's account — so it is audited by name.
 */
async function resetMfa(user, req, { reason = "" } = {}) {
  if (!user.twoFactorEnabled) throw new ServiceError(409, "MFA_NOT_ENABLED", "Two-factor isn't switched on for this admin");
  user.twoFactorEnabled = false;
  user.twoFactorSecret = undefined;
  // Anything holding a session from before the secret was removed signs in again.
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();
  await writeAudit(req, "tenant_admin.mfa_reset", auditExtra(user, reason ? { reason } : {}));
  return { user, message: "Two-factor removed — they can enrol again on next sign-in" };
}

/**
 * Email the ordinary reset link rather than setting a password. An operator who
 * can type a charity admin's new password knows their credentials; a link only
 * their inbox can open keeps the account theirs. The link points at the
 * TENANT's portal — `/reset-password` is a tenant route.
 */
async function sendPasswordReset(user, req) {
  if (user.platformStatus === "suspended") {
    throw new ServiceError(409, "TENANT_ADMIN_SUSPENDED", "Reactivate this admin before sending a reset link");
  }

  const identity = await getOrgIdentity(user.organisationId);
  const base = (identity.portalUrl || process.env.CLIENT_URL || "").replace(/\/+$/, "");
  if (!base) throw new ServiceError(409, "NO_PORTAL_ADDRESS", "This organisation has no portal address to send them to");

  const resetToken = crypto.randomBytes(32).toString("hex");
  user.resetPasswordToken = crypto.createHash("sha256").update(resetToken).digest("hex");
  user.resetPasswordExpires = Date.now() + 3600000; // 1 hour, same as forgotPassword
  await user.save();

  const result = await sendTemplateEmail("account.passwordReset", {
    to: user.email,
    organisationId: user.organisationId,
    data: {
      recipient: { name: user.name || "", email: user.email },
      reset: { url: `${base}/reset-password/${resetToken}`, expiresIn: "1 hour" },
    },
    meta: { userId: String(user._id), sentBy: req?.user?.email || req?.integration?.actorLabel || "", tenantAdminReset: true },
  });
  if (!result.success) throw new ServiceError(502, "EMAIL_SEND_FAILED", "The reset email couldn't be sent — check the SMTP settings.");

  await writeAudit(req, "tenant_admin.password_reset_sent", auditExtra(user));
  return { user, message: `Reset link sent to ${user.email}` };
}

/**
 * Whether this admin MUST use two-factor ("default" = not required). It cannot
 * switch two-factor ON — that needs their authenticator. Requiring it makes
 * loginAdmin return `mfaSetupRequired` and the portal holds them on enrolment.
 */
async function setMfaPolicy(user, policy, req, { reason = "" } = {}) {
  const v = input.oneOf(policy, "Two-factor policy", ["default", "required"]);
  if (v.error) throw new ServiceError(400, "VALIDATION_ERROR", v.error, { field: "mfa_policy" });

  user.mfaPolicy = v.value;
  // The legacy boolean outranks mfaPolicy inside mfaPolicyOf(), so a stale
  // `true` would silently defeat "required" on an old document.
  if (v.value === "required") user.mfaExempt = false;
  await user.save();
  await writeAudit(req, "tenant_admin.mfa_policy", auditExtra(user, { mfaPolicy: v.value, ...(reason ? { reason } : {}) }));

  const message =
    v.value === "required"
      ? user.twoFactorEnabled
        ? "Two-factor is now required"
        : "Two-factor required — they'll be asked to set it up at their next sign-in"
      : "Two-factor is no longer required";
  return { user, message };
}

module.exports = {
  tenantAdminState,
  listTenantAdmins,
  findTenantAdmin,
  setStatus,
  forceLogout,
  unlock,
  resetMfa,
  sendPasswordReset,
  setMfaPolicy,
};
