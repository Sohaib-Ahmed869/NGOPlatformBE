// Platform operator ("Team") management — invite/role/status for SuperAdmin
// console users. See config/platformRoles.js for the role→capability table.
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const User = require("../models/user");
const writeAudit = require("../utils/writeAudit");
const { sendTemplateEmail } = require("../services/emailUtil");
const input = require("../utils/operatorInput");
const { getOrgIdentity } = require("../utils/orgIdentity");
const {
  ALL_ROLES,
  ROLE_CAPABILITIES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  MFA_POLICIES,
  mfaPolicyOf,
  mfaRequiredFor,
} = require("../config/platformRoles");

const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches leadConversion's manualProvision

const PUBLIC_FIELDS =
  "name email platformRole platformStatus twoFactorEnabled mfaPolicy mfaExempt lastLogin invitedAt invitedBy createdAt";

// Serialise one operator for the Team screen. PROJECTS explicitly rather than
// spreading the document: list() reads through `.select(PUBLIC_FIELDS)`, but the
// mutation handlers hold a FULL document, and spreading that would have put the
// password hash, 2FA secret and invite token on the wire. `mfaExempt` is a
// legacy input to mfaPolicyOf, not part of the contract.
const PUBLIC_KEYS = PUBLIC_FIELDS.split(" ").filter((k) => k && k !== "mfaExempt");
function withMfa(user) {
  const src = user.toObject ? user.toObject() : user;
  const out = { _id: user._id };
  for (const key of PUBLIC_KEYS) if (src[key] !== undefined) out[key] = src[key];
  // Both halves of the MFA picture: the policy that was chosen, and whether it
  // adds up to "required" once the role default is folded in — so no caller has
  // to re-implement the precedence rules.
  out.mfaPolicy = mfaPolicyOf(user);
  out.mfaRequired = mfaRequiredFor(user);
  return out;
}

function clientBase(req) {
  return process.env.CLIENT_URL || `${req.protocol}://${req.get("host")}`;
}

// Builds a link on the fixed "admin." subdomain (see TenantContext.jsx
// parseTenantFromHostname — "admin" is the hardcoded superadmin subdomain,
// same shape as leadConversion.js's `${slug}.${portalBase}` for tenants).
function adminLink(req, path) {
  const base = clientBase(req);
  const portalBase = process.env.CLIENT_URL
    ? process.env.CLIENT_URL.replace(/^https?:\/\//, "")
    : base.replace(/^https?:\/\//, "");
  const scheme = /^https:/.test(base) ? "https" : "http";
  return `${scheme}://admin.${portalBase}${path}`;
}

async function countActiveOwners(excludeId) {
  const filter = { role: "superadmin", platformRole: "owner", platformStatus: { $ne: "suspended" } };
  if (excludeId) filter._id = { $ne: excludeId };
  return User.countDocuments(filter);
}

// Admin has the same reach as Owner everywhere EXCEPT other Owner accounts —
// only an Owner may touch (or create) another Owner.
function ownerGuardError(req, roleInvolved) {
  if (roleInvolved === "owner" && req.user.platformRole !== "owner") {
    return "Only an Owner can manage Owner accounts";
  }
  return null;
}

/** GET /api/superadmin/users */
exports.list = async (req, res) => {
  try {
    const users = await User.find({ role: "superadmin" }).select(PUBLIC_FIELDS).sort({ createdAt: 1 });
    res.json({
      users: users.map(withMfa),
      roles: ALL_ROLES.map((key) => ({ key, label: ROLE_LABELS[key], description: ROLE_DESCRIPTIONS[key] })),
    });
  } catch (err) {
    console.error("List platform users error:", err);
    res.status(500).json({ error: "Failed to fetch team" });
  }
};

/**
 * GET /api/superadmin/users/tenant-admins
 *
 * The admin each ORGANISATION signs in with — a different population from the
 * platform operators in list() above. A tenant admin is `role: "admin"`, always
 * scoped to one organisation, and never carries a platformRole, a platformStatus
 * or an MFA policy, so none of the operator columns or mutations apply to it.
 *
 * The Team screen shows these on their own tab so an operator can answer "who
 * runs this tenant, and have they ever logged in?" without opening all 25
 * organisations one at a time.
 *
 * The operator mutations below all filter on `role: "superadmin"` and will not
 * accept one of these ids; the tenant-admin equivalents (suspend, force sign-out,
 * unlock, reset two-factor, send a password reset) live at the end of this file
 * and filter on `role: "admin"` for the same reason in reverse.
 *
 * Returns the whole set, like list() — this is bounded by the number of
 * organisations, and the screen sorts and pages it client-side.
 */
exports.listTenantAdmins = async (req, res) => {
  try {
    const admins = await User.find({ role: "admin" })
      .select(
        "name email lastLogin createdAt organisationId platformStatus " +
          "twoFactorEnabled mfaPolicy mfaExempt lockedUntil failedLoginAttempts",
      )
      .populate("organisationId", "name slug isActive")
      .sort({ createdAt: 1 })
      .lean();

    const now = new Date();

    res.json({
      users: admins.map((u) => {
        const org = u.organisationId;
        return {
          _id: u._id,
          name: u.name || "",
          email: u.email,
          lastLogin: u.lastLogin || null,
          createdAt: u.createdAt,
          // A tenant admin has no platformRole, but platformStatus is read by
          // loginAdmin for every staff role, so it is the field that actually
          // governs whether this person can sign in. Absent = never suspended.
          status: u.platformStatus === "suspended" ? "suspended" : "active",
          twoFactorEnabled: !!u.twoFactorEnabled,
          // Whether they have it ON is theirs to decide; whether they MUST is
          // the operator's. Both are shown, because "not enrolled" reads very
          // differently once it is also "required".
          mfaPolicy: mfaPolicyOf(u) === "required" ? "required" : "default",
          mfaRequired: mfaRequiredFor(u),
          // Only while it is still in force — an expired lockout is history,
          // not a state, and showing it would send operators chasing nothing.
          lockedUntil: u.lockedUntil && u.lockedUntil > now ? u.lockedUntil : null,
          // Null when the organisation has been deleted out from under the
          // admin row — the screen renders that as "no organisation" rather
          // than hiding the row, since an orphan is the thing worth seeing.
          organisation: org
            ? { _id: org._id, name: org.name, slug: org.slug || "", isActive: org.isActive !== false }
            : null,
        };
      }),
    });
  } catch (err) {
    console.error("List tenant admins error:", err);
    res.status(500).json({ error: "Failed to fetch tenant admins" });
  }
};

/** POST /api/superadmin/users — invite a new operator */
exports.invite = async (req, res) => {
  try {
    const b = req.body || {};
    const v = input.collect({
      name: input.text(b.name, "Name", { required: true, max: 120 }),
      email: input.text(b.email, "Email", { required: true, max: 200 }),
      platformRole: input.oneOf(b.platformRole, "Role", ALL_ROLES),
    });
    if (v.error) return res.status(400).json({ error: v.error });

    const guardErr = ownerGuardError(req, v.values.platformRole);
    if (guardErr) return res.status(403).json({ error: guardErr });

    const email = v.values.email.toLowerCase();
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: "A user with that email already exists" });

    const rawToken = crypto.randomBytes(32).toString("hex");
    const resetPasswordToken = crypto.createHash("sha256").update(rawToken).digest("hex");

    const user = await User.create({
      name: v.values.name,
      email,
      role: "superadmin",
      platformRole: v.values.platformRole,
      platformStatus: "invited",
      invitedBy: req.user._id,
      invitedAt: new Date(),
      resetPasswordToken,
      resetPasswordExpires: Date.now() + INVITE_EXPIRY_MS,
      organisationId: null,
    });

    const link = adminLink(req, `/accept-invite/${rawToken}`);
    await sendTemplateEmail("operator.invite", {
      to: email,
      data: {
        recipient: { name: v.values.name || "", email },
        invite: {
          url: link,
          role: ROLE_LABELS[v.values.platformRole],
          expiresIn: "7 days",
        },
        invitedBy: req.user.name || req.user.email,
      },
      meta: { userId: String(user._id), platformRole: v.values.platformRole },
    });

    await writeAudit(req, "sa_user.invited", {
      targetType: "user",
      targetId: String(user._id),
      meta: { email, platformRole: v.values.platformRole },
    });

    // Same shape as a row from list() — including the MFA fields — so the new
    // row the screen appends is complete (and safe to write to the cache).
    res.status(201).json({ user: withMfa(user) });
  } catch (err) {
    console.error("Invite platform user error:", err);
    res.status(500).json({ error: "Failed to send invite" });
  }
};

/** POST /api/superadmin/users/:id/resend-invite */
exports.resendInvite = async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, role: "superadmin" });
    if (!user) return res.status(404).json({ error: "User not found" });

    const guardErr = ownerGuardError(req, user.platformRole);
    if (guardErr) return res.status(403).json({ error: guardErr });
    if (user.platformStatus !== "invited") return res.status(400).json({ error: "This account has already been activated" });

    const rawToken = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    user.resetPasswordExpires = Date.now() + INVITE_EXPIRY_MS;
    await user.save();

    const link = adminLink(req, `/accept-invite/${rawToken}`);
    await sendTemplateEmail("operator.inviteResend", {
      to: user.email,
      data: {
        recipient: { name: user.name || "", email: user.email },
        invite: {
          url: link,
          role: ROLE_LABELS[user.platformRole] || "",
          expiresIn: "7 days",
        },
      },
      meta: { userId: String(user._id) },
    });

    await writeAudit(req, "sa_user.invite_resent", { targetType: "user", targetId: String(user._id), meta: { email: user.email } });
    res.json({ message: "Invite resent" });
  } catch (err) {
    console.error("Resend invite error:", err);
    res.status(500).json({ error: "Failed to resend invite" });
  }
};

/**
 * PATCH /api/superadmin/users/:id/invite — { name, email }
 *
 * Fix a typo in a PENDING invite. Only while the account is still `invited`:
 * once someone has accepted, the email is their identity (and their login), so
 * it isn't ours to rewrite from this screen.
 *
 * Saving ALWAYS rotates the invite token, so the link already sitting in
 * someone's inbox dies the moment this returns — otherwise correcting a
 * mistyped address would leave a working invite pointing at the wrong mailbox.
 * A fresh link is emailed to whatever the address now is.
 */
exports.updateInvite = async (req, res) => {
  try {
    const b = req.body || {};
    const v = input.collect({
      name: input.text(b.name, "Name", { required: true, max: 120 }),
      email: input.text(b.email, "Email", { required: true, max: 200 }),
    });
    if (v.error) return res.status(400).json({ error: v.error });

    const user = await User.findOne({ _id: req.params.id, role: "superadmin" });
    if (!user) return res.status(404).json({ error: "User not found" });

    const guardErr = ownerGuardError(req, user.platformRole);
    if (guardErr) return res.status(403).json({ error: guardErr });

    if (user.platformStatus !== "invited") {
      return res.status(400).json({ error: "Only a pending invite can be edited — this account has already been activated" });
    }

    const email = v.values.email.toLowerCase();
    if (email !== user.email) {
      const clash = await User.findOne({ email, _id: { $ne: user._id } });
      if (clash) return res.status(409).json({ error: "A user with that email already exists" });
    }

    const from = { name: user.name, email: user.email };
    const rawToken = crypto.randomBytes(32).toString("hex");

    user.name = v.values.name;
    user.email = email;
    // Rotating the hash is what kills the old link — the previous token can no
    // longer be found, so /accept-invite/:token 400s for it from here on.
    user.resetPasswordToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    user.resetPasswordExpires = Date.now() + INVITE_EXPIRY_MS;
    await user.save();

    const link = adminLink(req, `/accept-invite/${rawToken}`);
    await sendTemplateEmail("operator.inviteResend", {
      to: user.email,
      data: {
        recipient: { name: user.name || "", email: user.email },
        invite: { url: link, role: ROLE_LABELS[user.platformRole] || "", expiresIn: "7 days" },
      },
      meta: { userId: String(user._id) },
    });

    await writeAudit(req, "sa_user.invite_updated", {
      targetType: "user",
      targetId: String(user._id),
      meta: { from, to: { name: user.name, email: user.email }, linkRotated: true },
    });

    res.json({ user: withMfa(user) });
  } catch (err) {
    console.error("Update invite error:", err);
    res.status(500).json({ error: "Failed to update the invite" });
  }
};

/** PATCH /api/superadmin/users/:id/role */
exports.changeRole = async (req, res) => {
  try {
    const v = input.oneOf(req.body?.platformRole, "Role", ALL_ROLES);
    if (v.error) return res.status(400).json({ error: v.error });

    if (String(req.params.id) === String(req.user._id)) {
      return res.status(400).json({ error: "You can't change your own role" });
    }

    const user = await User.findOne({ _id: req.params.id, role: "superadmin" });
    if (!user) return res.status(404).json({ error: "User not found" });

    const guardErr = ownerGuardError(req, user.platformRole) || ownerGuardError(req, v.value);
    if (guardErr) return res.status(403).json({ error: guardErr });

    if (user.platformRole === "owner" && v.value !== "owner") {
      const remaining = await countActiveOwners(user._id);
      if (remaining < 1) return res.status(400).json({ error: "There must be at least one Owner" });
    }

    const from = user.platformRole;
    user.platformRole = v.value;
    await user.save();

    await writeAudit(req, "sa_user.role_changed", {
      targetType: "user",
      targetId: String(user._id),
      meta: { email: user.email, from, to: v.value },
    });

    // Return the MFA fields too: a role change can flip whether MFA is required
    // for anyone on the "default" policy, and the Team screen shows that.
    res.json({ user: withMfa(user) });
  } catch (err) {
    console.error("Change role error:", err);
    res.status(500).json({ error: "Failed to change role" });
  }
};

/**
 * PATCH /api/superadmin/users/:id/mfa-policy — { policy: "default"|"required"|"exempt" }
 *
 * Whether MFA is mandatory for THIS operator, overriding the role default.
 * Enforcement happens at sign-in (userController.login returns
 * `mfaSetupRequired`), so a change lands on their next session — use "Sign out
 * everywhere" alongside it if it needs to bite immediately.
 */
exports.setMfaPolicy = async (req, res) => {
  try {
    const v = input.oneOf(req.body?.policy, "MFA policy", MFA_POLICIES);
    if (v.error) return res.status(400).json({ error: v.error });

    // Same rule as role/status: nobody edits their own security settings from
    // this screen — otherwise an Owner can quietly exempt themselves.
    if (String(req.params.id) === String(req.user._id)) {
      return res.status(400).json({ error: "You can't change your own MFA requirement" });
    }

    const user = await User.findOne({ _id: req.params.id, role: "superadmin" });
    if (!user) return res.status(404).json({ error: "User not found" });

    const guardErr = ownerGuardError(req, user.platformRole);
    if (guardErr) return res.status(403).json({ error: guardErr });

    const from = mfaPolicyOf(user);
    if (from === v.value) return res.json({ user: withMfa(user) });

    user.mfaPolicy = v.value;
    // Retire the legacy flag as soon as the policy is set explicitly, so the
    // two can't drift apart.
    user.mfaExempt = v.value === "exempt";
    await user.save();

    await writeAudit(req, "sa_user.mfa_policy_changed", {
      targetType: "user",
      targetId: String(user._id),
      meta: { email: user.email, from, to: v.value, enrolled: !!user.twoFactorEnabled },
    });

    res.json({ user: withMfa(user) });
  } catch (err) {
    console.error("Change MFA policy error:", err);
    res.status(500).json({ error: "Failed to update the MFA requirement" });
  }
};

/** PATCH /api/superadmin/users/:id/status — { status: "active" | "suspended" } */
exports.changeStatus = async (req, res) => {
  try {
    const v = input.oneOf(req.body?.status, "Status", ["active", "suspended"]);
    if (v.error) return res.status(400).json({ error: v.error });

    if (String(req.params.id) === String(req.user._id)) {
      return res.status(400).json({ error: "You can't change your own status" });
    }

    const user = await User.findOne({ _id: req.params.id, role: "superadmin" });
    if (!user) return res.status(404).json({ error: "User not found" });

    const guardErr = ownerGuardError(req, user.platformRole);
    if (guardErr) return res.status(403).json({ error: guardErr });

    if (v.value === "suspended" && user.platformRole === "owner") {
      const remaining = await countActiveOwners(user._id);
      if (remaining < 1) return res.status(400).json({ error: "There must be at least one active Owner" });
    }

    user.platformStatus = v.value;
    if (v.value === "suspended") user.tokenVersion = (user.tokenVersion || 0) + 1; // kills any already-issued token
    await user.save();

    await writeAudit(req, v.value === "suspended" ? "sa_user.suspended" : "sa_user.reactivated", {
      targetType: "user",
      targetId: String(user._id),
      meta: { email: user.email },
    });

    res.json({ user: { _id: user._id, platformStatus: user.platformStatus } });
  } catch (err) {
    console.error("Change status error:", err);
    res.status(500).json({ error: "Failed to change status" });
  }
};

/** POST /api/superadmin/users/:id/force-logout */
exports.forceLogout = async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, role: "superadmin" });
    if (!user) return res.status(404).json({ error: "User not found" });

    const guardErr = ownerGuardError(req, user.platformRole);
    if (guardErr) return res.status(403).json({ error: guardErr });

    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    await writeAudit(req, "sa_user.force_logout", { targetType: "user", targetId: String(user._id), meta: { email: user.email } });
    res.json({ message: "Signed out of all sessions" });
  } catch (err) {
    console.error("Force logout error:", err);
    res.status(500).json({ error: "Failed to sign out user" });
  }
};

// ── Public accept-invite flow (no auth — the token IS the credential) ──────

/** GET /api/superadmin/users/accept-invite/:token */
exports.getInvite = async (req, res) => {
  try {
    const hashed = crypto.createHash("sha256").update(req.params.token).digest("hex");
    const user = await User.findOne({
      resetPasswordToken: hashed,
      resetPasswordExpires: { $gt: Date.now() },
      role: "superadmin",
      platformStatus: "invited",
    })
      .select("name email platformRole invitedBy mfaPolicy mfaExempt")
      .populate("invitedBy", "name email");
    if (!user) return res.status(400).json({ error: "This invite link is invalid or has expired" });
    res.json({
      name: user.name,
      email: user.email,
      platformRole: user.platformRole,
      roleLabel: ROLE_LABELS[user.platformRole],
      roleDescription: ROLE_DESCRIPTIONS[user.platformRole] || "",
      // The nav sections this person will actually be able to open. Shown on
      // the invite page so "you've been made a Billing Operator" means
      // something to someone who has never seen the console.
      capabilities: ROLE_CAPABILITIES[user.platformRole] || [],
      invitedByName: user.invitedBy?.name || user.invitedBy?.email || "",
      mfaRequired: mfaRequiredFor(user),
    });
  } catch (err) {
    console.error("Get invite error:", err);
    res.status(500).json({ error: "Failed to load invite" });
  }
};

/** POST /api/superadmin/users/accept-invite/:token — { password } */
exports.acceptInvite = async (req, res) => {
  try {
    const v = input.text(req.body?.password, "Password", { required: true, max: 200 });
    if (v.error) return res.status(400).json({ error: v.error });
    if (v.value.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    const hashed = crypto.createHash("sha256").update(req.params.token).digest("hex");
    const user = await User.findOne({
      resetPasswordToken: hashed,
      resetPasswordExpires: { $gt: Date.now() },
      role: "superadmin",
      platformStatus: "invited",
    });
    if (!user) return res.status(400).json({ error: "This invite link is invalid or has expired" });

    user.password = await bcrypt.hash(v.value, 10);
    user.platformStatus = "active";
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    await writeAudit(req, "sa_user.invite_accepted", { targetType: "user", targetId: String(user._id), meta: { email: user.email } });
    res.json({ message: "Account activated — you can now log in" });
  } catch (err) {
    console.error("Accept invite error:", err);
    res.status(500).json({ error: "Failed to activate account" });
  }
};

// ── Public forgot-password flow (no auth — a locked-out operator by
// definition can't authenticate) ────────────────────────────────────────────
// email -> 6-digit code -> verify -> short-lived ticket -> set new password.
// Every response at the request step is IDENTICAL whether or not the email
// belongs to a real operator account, so this can't be used to enumerate who
// has platform access. The verify/reset steps are inherently scoped to a flow
// the caller already started (they typed this email on the previous screen),
// so those give specific feedback the same way any OTP flow does.

const RESET_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes to use a code
const RESET_TICKET_TTL_MS = 10 * 60 * 1000; // 10 minutes to finish the reset after verifying
const RESET_CODE_MAX_ATTEMPTS = 5; // wrong guesses before a code is burned
const RESET_RESEND_COOLDOWN_MS = 45 * 1000; // between sends to the SAME account
const RESET_MAX_SENDS_PER_HOUR = 5; // sends to the SAME account

// A light in-memory IP throttle on top of the per-account limits above —
// blunts a script hammering this endpoint with random addresses to fish for
// valid operator emails. Not a substitute for the per-account limits (it
// resets on deploy and isn't shared across instances if this ever runs on
// more than one), just a free extra layer.
const ipHits = new Map(); // ip -> { count, windowStart }
const IP_WINDOW_MS = 10 * 60 * 1000;
const IP_MAX_PER_WINDOW = 20;
function ipRateLimited(req) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const hit = ipHits.get(ip);
  if (!hit || now - hit.windowStart > IP_WINDOW_MS) {
    ipHits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  hit.count += 1;
  return hit.count > IP_MAX_PER_WINDOW;
}

const SENT_MESSAGE = "If that email belongs to a platform operator account, we've sent a verification code.";
const CODE_ERROR = "That code is invalid or has expired.";
const SESSION_EXPIRED = "This reset session has expired. Start again.";

// Constant-time compare of two hex digests — never == / === a secret hash,
// same reasoning as the bootstrap-secret check in superAdminController.js.
function hashesMatch(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** POST /api/superadmin/auth/forgot-password — { email } */
exports.forgotPassword = async (req, res) => {
  try {
    // Rate-limited or malformed input still gets the generic reply — an
    // attacker learns nothing new from a different response either way.
    if (ipRateLimited(req)) return res.json({ message: SENT_MESSAGE });

    const v = input.text(req.body?.email, "Email", { required: true, max: 250 });
    if (v.error || !/\S+@\S+\.\S+/.test(v.value)) return res.json({ message: SENT_MESSAGE });
    const email = v.value.toLowerCase();

    const user = await User.findOne({ email, role: "superadmin", platformStatus: "active" });
    if (user) {
      const now = Date.now();
      const pr = user.passwordReset || {};
      const sentRecently = pr.lastSentAt && now - new Date(pr.lastSentAt).getTime() < RESET_RESEND_COOLDOWN_MS;
      const windowFresh = pr.windowStartedAt && now - new Date(pr.windowStartedAt).getTime() < 60 * 60 * 1000;
      const sendCount = windowFresh ? pr.sendCount || 0 : 0;

      if (!sentRecently && sendCount < RESET_MAX_SENDS_PER_HOUR) {
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");

        user.passwordReset = {
          codeHash: sha256(code),
          codeExpiresAt: new Date(now + RESET_CODE_TTL_MS),
          attempts: 0,
          lastSentAt: new Date(now),
          sendCount: sendCount + 1,
          windowStartedAt: windowFresh ? pr.windowStartedAt : new Date(now),
          ticketHash: null,
          ticketExpiresAt: null,
        };
        await user.save();

        await sendTemplateEmail("operator.passwordResetCode", {
          to: email,
          data: {
            recipient: { name: user.name || "", email },
            reset: { code, expiresIn: "10 minutes" },
          },
          meta: { userId: String(user._id) },
        });
        await writeAudit(req, "sa_user.password_reset_requested", { targetType: "user", targetId: String(user._id), meta: { email } });
      }
    }

    res.json({ message: SENT_MESSAGE });
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};

/** POST /api/superadmin/auth/forgot-password/verify — { email, code } */
exports.verifyResetCode = async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code = String(req.body?.code || "").trim();
    if (!email || !/^\d{6}$/.test(code)) return res.status(400).json({ error: CODE_ERROR });

    const user = await User.findOne({ email, role: "superadmin", platformStatus: "active" });
    const pr = user?.passwordReset;
    const validWindow = pr?.codeHash && pr.codeExpiresAt && new Date(pr.codeExpiresAt).getTime() > Date.now();
    if (!user || !validWindow) return res.status(400).json({ error: CODE_ERROR });

    if ((pr.attempts || 0) >= RESET_CODE_MAX_ATTEMPTS) {
      user.passwordReset.codeHash = null; // burned — a fresh request is required
      user.markModified("passwordReset");
      await user.save();
      return res.status(400).json({ error: "Too many attempts. Request a new code." });
    }

    if (!hashesMatch(sha256(code), pr.codeHash)) {
      user.passwordReset.attempts = (pr.attempts || 0) + 1;
      user.markModified("passwordReset");
      await user.save();
      const attemptsRemaining = Math.max(RESET_CODE_MAX_ATTEMPTS - user.passwordReset.attempts, 0);
      return res.status(400).json({ error: CODE_ERROR, attemptsRemaining });
    }

    // Correct — burn the code (single-use) and hand back a short-lived
    // ticket scoped only to the final "set new password" call, so the
    // frontend never has to resubmit the code itself.
    const rawTicket = crypto.randomBytes(32).toString("hex");
    user.passwordReset = {
      codeHash: null,
      codeExpiresAt: null,
      attempts: 0,
      lastSentAt: pr.lastSentAt,
      sendCount: pr.sendCount,
      windowStartedAt: pr.windowStartedAt,
      ticketHash: sha256(rawTicket),
      ticketExpiresAt: new Date(Date.now() + RESET_TICKET_TTL_MS),
    };
    await user.save();

    await writeAudit(req, "sa_user.password_reset_code_verified", { targetType: "user", targetId: String(user._id), meta: { email } });
    res.json({ ticket: rawTicket });
  } catch (err) {
    console.error("Verify reset code error:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};

/** POST /api/superadmin/auth/forgot-password/reset — { email, ticket, password } */
exports.resetPasswordWithCode = async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const ticket = String(req.body?.ticket || "").trim();
    const v = input.text(req.body?.password, "Password", { required: true, max: 200 });
    if (v.error) return res.status(400).json({ error: v.error });
    if (v.value.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (!email || !ticket) return res.status(400).json({ error: SESSION_EXPIRED });

    const user = await User.findOne({ email, role: "superadmin", platformStatus: "active" });
    const pr = user?.passwordReset;
    const validTicket = pr?.ticketHash && pr.ticketExpiresAt && new Date(pr.ticketExpiresAt).getTime() > Date.now();
    if (!user || !validTicket || !hashesMatch(sha256(ticket), pr.ticketHash)) {
      return res.status(400).json({ error: SESSION_EXPIRED });
    }

    user.password = await bcrypt.hash(v.value, 10);
    user.passwordReset = undefined;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    user.passwordLastChanged = new Date();
    user.tokenVersion = (user.tokenVersion || 0) + 1; // kills every already-issued session
    await user.save();

    await writeAudit(req, "sa_user.password_reset_completed", { targetType: "user", targetId: String(user._id), meta: { email } });
    res.json({ message: "Password updated — you can now sign in" });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};

/* -- tenant admins: operations ---------------------------------------------
 *
 * The operator mutations above all filter on `role: "superadmin"` and will not
 * accept a tenant admin's id — deliberately, because the two populations are
 * not the same kind of account. These are the tenant-admin equivalents, and
 * they are a deliberately SMALL set: the five things a platform operator
 * actually gets asked to do for a charity whose admin cannot get in, plus the
 * one thing they get asked to do when a charity should no longer be able to.
 *
 * What is NOT here, on purpose: no role change (a tenant admin has exactly one
 * role), no re-invite (the account is created by activation, not by invite),
 * and no delete (removing the only admin orphans the organisation — suspend it
 * or delete the organisation from its own screen).
 */

/**
 * Load a tenant admin by id, or answer 404.
 *
 * The `role: "admin"` filter is the guard, not decoration: without it these
 * routes would be a second, unguarded way to suspend a platform OPERATOR —
 * bypassing ownerGuardError() and the last-active-owner check that protect the
 * operator table.
 */
async function findTenantAdmin(req, res) {
  const user = await User.findOne({ _id: req.params.id, role: "admin" });
  if (!user) {
    res.status(404).json({ error: "Tenant admin not found" });
    return null;
  }
  return user;
}

/** Everything the row needs after a mutation, so the screen can merge in place. */
const tenantAdminState = (u) => ({
  _id: u._id,
  status: u.platformStatus === "suspended" ? "suspended" : "active",
  twoFactorEnabled: !!u.twoFactorEnabled,
  mfaPolicy: mfaPolicyOf(u) === "required" ? "required" : "default",
  mfaRequired: mfaRequiredFor(u),
  lockedUntil: u.lockedUntil && u.lockedUntil > new Date() ? u.lockedUntil : null,
  lastLogin: u.lastLogin || null,
});

/**
 * PATCH /api/superadmin/users/tenant-admins/:id/status  { status }
 *
 * Suspending bumps `tokenVersion`, which is what makes it immediate rather than
 * eventual: loginAdmin already refuses a suspended account, but the token
 * already in their browser is good for 30 days, and middleware/authMiddleware.js
 * only started checking for this alongside these endpoints.
 *
 * This does NOT touch the organisation. A suspended admin cannot sign in; the
 * charity's public site, donation pages and donors are unaffected. Stopping the
 * whole tenant is a different, louder action and lives on the organisation.
 */
exports.setTenantAdminStatus = async (req, res) => {
  try {
    const v = input.oneOf(req.body?.status, "Status", ["active", "suspended"]);
    if (v.error) return res.status(400).json({ error: v.error });

    const user = await findTenantAdmin(req, res);
    if (!user) return;

    user.platformStatus = v.value;
    // Both directions bump it. On suspend it kills live sessions; on
    // reactivate it retires any token minted before the suspension, so a stale
    // tab cannot come back to life holding pre-suspension state.
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    if (v.value === "active") {
      // Reactivating someone who is also locked out and still unable to sign in
      // is a support call we would only take twice.
      user.lockedUntil = null;
      user.failedLoginAttempts = 0;
    }
    await user.save();

    await writeAudit(req, v.value === "suspended" ? "tenant_admin.suspended" : "tenant_admin.reactivated", {
      organisationId: user.organisationId || undefined,
      targetType: "user",
      targetId: String(user._id),
      meta: { email: user.email },
    });

    res.json({
      user: tenantAdminState(user),
      message: v.value === "suspended" ? "Admin suspended and signed out" : "Admin reactivated",
    });
  } catch (err) {
    console.error("Set tenant admin status error:", err);
    res.status(500).json({ error: "Failed to change status" });
  }
};

/**
 * POST /api/superadmin/users/tenant-admins/:id/force-logout
 * Ends every session without touching the account — for a lost laptop, or a
 * staff member who has left and whose replacement uses the same login.
 */
exports.forceLogoutTenantAdmin = async (req, res) => {
  try {
    const user = await findTenantAdmin(req, res);
    if (!user) return;

    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    await writeAudit(req, "tenant_admin.force_logout", {
      organisationId: user.organisationId || undefined,
      targetType: "user",
      targetId: String(user._id),
      meta: { email: user.email },
    });
    res.json({ user: tenantAdminState(user), message: "Signed out of all sessions" });
  } catch (err) {
    console.error("Force logout tenant admin error:", err);
    res.status(500).json({ error: "Failed to sign out this admin" });
  }
};

/**
 * POST /api/superadmin/users/tenant-admins/:id/unlock
 * Clears the five-failed-attempts lockout (see loginAdmin). The alternative for
 * the charity is waiting fifteen minutes, which is exactly when they phone.
 */
exports.unlockTenantAdmin = async (req, res) => {
  try {
    const user = await findTenantAdmin(req, res);
    if (!user) return;

    user.lockedUntil = null;
    user.failedLoginAttempts = 0;
    await user.save();

    await writeAudit(req, "tenant_admin.unlocked", {
      organisationId: user.organisationId || undefined,
      targetType: "user",
      targetId: String(user._id),
      meta: { email: user.email },
    });
    res.json({ user: tenantAdminState(user), message: "Lockout cleared" });
  } catch (err) {
    console.error("Unlock tenant admin error:", err);
    res.status(500).json({ error: "Failed to clear the lockout" });
  }
};

/**
 * POST /api/superadmin/users/tenant-admins/:id/reset-2fa
 *
 * Turns two-factor OFF so the admin can sign in with their password and enrol a
 * new authenticator. This is the "new phone, old codes gone" call, and it is
 * the single most dangerous thing on this screen — it removes a factor from
 * someone else's account — so it is audited by name and the console asks twice.
 */
exports.resetTenantAdminMfa = async (req, res) => {
  try {
    const user = await findTenantAdmin(req, res);
    if (!user) return;

    if (!user.twoFactorEnabled) {
      return res.status(400).json({ error: "Two-factor isn't switched on for this admin" });
    }

    user.twoFactorEnabled = false;
    user.twoFactorSecret = undefined;
    // The old secret is gone, so anything holding a session from before it was
    // removed should be made to sign in again under the new arrangement.
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    await writeAudit(req, "tenant_admin.mfa_reset", {
      organisationId: user.organisationId || undefined,
      targetType: "user",
      targetId: String(user._id),
      meta: { email: user.email },
    });
    res.json({ user: tenantAdminState(user), message: "Two-factor removed — they can enrol again on next sign-in" });
  } catch (err) {
    console.error("Reset tenant admin MFA error:", err);
    res.status(500).json({ error: "Failed to reset two-factor" });
  }
};

/**
 * POST /api/superadmin/users/tenant-admins/:id/password-reset
 *
 * Sends the ordinary reset email rather than setting a password here. An
 * operator who can type a charity admin's new password knows their credentials;
 * a link that only their inbox can open keeps the account theirs, and the reset
 * screen already exists on their own portal.
 *
 * The link points at the TENANT's portal, not the platform's — `/reset-password`
 * is a tenant route, and a link to the wrong host is a support ticket.
 */
exports.sendTenantAdminPasswordReset = async (req, res) => {
  try {
    const user = await findTenantAdmin(req, res);
    if (!user) return;

    if (user.platformStatus === "suspended") {
      return res.status(400).json({ error: "Reactivate this admin before sending a reset link" });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = crypto.createHash("sha256").update(resetToken).digest("hex");
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hour, same as forgotPassword
    await user.save();

    const identity = await getOrgIdentity(user.organisationId);
    const base = (identity.portalUrl || process.env.CLIENT_URL || "").replace(/\/+$/, "");
    if (!base) {
      return res.status(400).json({ error: "This organisation has no portal address to send them to" });
    }

    const result = await sendTemplateEmail("account.passwordReset", {
      to: user.email,
      organisationId: user.organisationId,
      data: {
        recipient: { name: user.name || "", email: user.email },
        reset: { url: `${base}/reset-password/${resetToken}`, expiresIn: "1 hour" },
      },
      meta: { userId: String(user._id), sentBy: req.user?.email || "", tenantAdminReset: true },
    });

    if (!result.success) {
      return res.status(502).json({ error: "The reset email couldn't be sent — check the SMTP settings." });
    }

    await writeAudit(req, "tenant_admin.password_reset_sent", {
      organisationId: user.organisationId || undefined,
      targetType: "user",
      targetId: String(user._id),
      meta: { email: user.email },
    });
    res.json({ message: `Reset link sent to ${user.email}` });
  } catch (err) {
    console.error("Tenant admin password reset error:", err);
    res.status(500).json({ error: "Failed to send the reset link" });
  }
};

/**
 * PATCH /api/superadmin/users/tenant-admins/:id/mfa-policy  { mfaPolicy }
 *
 * Whether this admin MUST use two-factor. Only two values here, unlike the
 * operator version: a tenant admin has no platformRole, so there is no role
 * table for "default" to follow — it simply means "not required", and a third
 * "exempt" option would be a second word for the same thing.
 *
 * Note what this does NOT do: it cannot switch two-factor ON for someone. That
 * needs their authenticator, which is the point of the factor. Requiring it
 * makes loginAdmin hand back `mfaSetupRequired`, and the tenant admin portal
 * holds them on the enrolment screen until they have scanned the QR code.
 */
exports.setTenantAdminMfaPolicy = async (req, res) => {
  try {
    const v = input.oneOf(req.body?.mfaPolicy, "Two-factor policy", ["default", "required"]);
    if (v.error) return res.status(400).json({ error: v.error });

    const user = await findTenantAdmin(req, res);
    if (!user) return;

    user.mfaPolicy = v.value;
    // The legacy boolean outranks mfaPolicy inside mfaPolicyOf(), so leaving a
    // stale `true` here would silently defeat "required" on an old document.
    if (v.value === "required") user.mfaExempt = false;
    await user.save();

    await writeAudit(req, "tenant_admin.mfa_policy", {
      organisationId: user.organisationId || undefined,
      targetType: "user",
      targetId: String(user._id),
      meta: { email: user.email, mfaPolicy: v.value },
    });

    res.json({
      user: tenantAdminState(user),
      message:
        v.value === "required"
          ? user.twoFactorEnabled
            ? "Two-factor is now required"
            : "Two-factor required — they'll be asked to set it up at their next sign-in"
          : "Two-factor is no longer required",
    });
  } catch (err) {
    console.error("Set tenant admin MFA policy error:", err);
    res.status(500).json({ error: "Failed to change the two-factor policy" });
  }
};
