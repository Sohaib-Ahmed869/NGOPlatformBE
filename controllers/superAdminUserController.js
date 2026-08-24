// Platform operator ("Team") management — invite/role/status for SuperAdmin
// console users. See config/platformRoles.js for the role→capability table.
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const User = require("../models/user");
const writeAudit = require("../utils/writeAudit");
const { sendEmail } = require("../services/emailUtil");
const input = require("../utils/operatorInput");
const { ALL_ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS } = require("../config/platformRoles");

const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches leadConversion's manualProvision

const PUBLIC_FIELDS =
  "name email platformRole platformStatus twoFactorEnabled lastLogin invitedAt invitedBy createdAt";

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
    res.json({ users, roles: ALL_ROLES.map((key) => ({ key, label: ROLE_LABELS[key], description: ROLE_DESCRIPTIONS[key] })) });
  } catch (err) {
    console.error("List platform users error:", err);
    res.status(500).json({ error: "Failed to fetch team" });
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
    const html = `
      <h2>You've been invited to the platform team</h2>
      <p>${req.user.name || req.user.email} invited you as <strong>${ROLE_LABELS[v.values.platformRole]}</strong>.</p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${link}" style="background:#047857;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600;">Set up your account</a>
      </div>
      <p>This link expires in 7 days.</p>
    `;
    await sendEmail(email, html, "You're invited to the platform team");

    await writeAudit(req, "sa_user.invited", {
      targetType: "user",
      targetId: String(user._id),
      meta: { email, platformRole: v.values.platformRole },
    });

    res.status(201).json({ user: { _id: user._id, name: user.name, email: user.email, platformRole: user.platformRole, platformStatus: user.platformStatus } });
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
    const html = `
      <h2>Your platform team invite</h2>
      <div style="text-align:center;margin:24px 0;">
        <a href="${link}" style="background:#047857;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600;">Set up your account</a>
      </div>
      <p>This link expires in 7 days.</p>
    `;
    await sendEmail(user.email, html, "Your platform team invite");

    await writeAudit(req, "sa_user.invite_resent", { targetType: "user", targetId: String(user._id), meta: { email: user.email } });
    res.json({ message: "Invite resent" });
  } catch (err) {
    console.error("Resend invite error:", err);
    res.status(500).json({ error: "Failed to resend invite" });
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

    res.json({ user: { _id: user._id, platformRole: user.platformRole } });
  } catch (err) {
    console.error("Change role error:", err);
    res.status(500).json({ error: "Failed to change role" });
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
    }).select("name email platformRole");
    if (!user) return res.status(400).json({ error: "This invite link is invalid or has expired" });
    res.json({ name: user.name, email: user.email, platformRole: user.platformRole, roleLabel: ROLE_LABELS[user.platformRole] });
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
