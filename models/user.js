// models/User.js
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,

      minlength: 6,
    },
    role: {
      type: String,
      enum: ["superadmin", "admin", "donor"],
      default: "donor",
    },
    // Only meaningful when role === "superadmin" — which capability group this
    // platform operator has (see config/platformRoles.js). Undefined on every
    // other role.
    platformRole: {
      type: String,
      enum: ["owner", "admin", "support", "billing", "tenant_manager"],
    },
    platformStatus: {
      type: String,
      enum: ["invited", "active", "suspended"],
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    invitedAt: { type: Date, default: null },
    // Per-operator MFA requirement, set from the Team screen. "default" follows
    // the role (see MFA_REQUIRED_ROLES); "required" forces enrolment on a role
    // that wouldn't normally need it; "exempt" is the escape hatch for a shared
    // dev/test login. Read through mfaRequiredFor() in config/platformRoles.js.
    mfaPolicy: { type: String, enum: ["default", "required", "exempt"], default: "default" },
    // Legacy form of `mfaPolicy: "exempt"`, still honoured on old documents.
    mfaExempt: { type: Boolean, default: false },
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      default: null,
    },
    defaultPaymentMethod: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PaymentMethod",
    },
    // Stripe customer for this donor on their tenant's Stripe account — used to
    // save reusable cards (SetupIntent) and charge them at checkout. Created
    // lazily the first time the donor saves a card.
    stripeCustomerId: { type: String, default: "" },
    firstName: String,
    lastName: String,
    phone: {
      type: String,
      default: "+61", 
    },    
    country: String,
    language: String,
    currency: String,
    profileImage: String,
    address: {
      street: String,
      city: String,
      state: String,
      postalCode: String,
    },

    notifications: {
      emailNotifications: { type: Boolean, default: true },
      donationReceipts: { type: Boolean, default: true },
      monthlyNewsletter: { type: Boolean, default: true },
      impactUpdates: { type: Boolean, default: true },
    },

    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: String,
    // Admin / super-admin login lockout (see controllers/userController.loginAdmin)
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    passwordLastChanged: { type: Date, default: Date.now },
    tokenVersion: { type: Number, default: 0 },
    resetCode: String,
    current_status: {
      type: String,
      enum: ["online", "offline"],
      default: "offline",
    },
    lastLogin: Date,
    dateOfBirth: Date,
    resetPasswordToken: String,
    resetPasswordExpires: Date,
    // Platform-operator "forgot password" flow — email a 6-digit code, verify
    // it, then hand back a short-lived ticket for the actual reset call. Kept
    // separate from resetPasswordToken/Expires above (the admin-invite link
    // flow) since a code and a link have different shapes and lifecycles —
    // see controllers/superAdminUserController.js.
    passwordReset: {
      codeHash: { type: String, default: null },
      codeExpiresAt: { type: Date, default: null },
      attempts: { type: Number, default: 0 },
      lastSentAt: { type: Date, default: null },
      sendCount: { type: Number, default: 0 },
      windowStartedAt: { type: Date, default: null },
      ticketHash: { type: String, default: null },
      ticketExpiresAt: { type: Date, default: null },
    },
    isTemporaryPassword: {
      type: Boolean,
      default: false
    },
    authProvider: {
      type: String,
      enum: ["local", "google"],
      default: "local",
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true,
    },
  },

  {
    timestamps: true,
  }
);

// A donor row is created per organisation, so this collection grows fastest of
// all. `email` already has its own unique index; these cover the two shapes the
// app actually queries by: staff lookups for assignment dropdowns, and
// org-scoped listings ordered newest-first.
userSchema.index({ organisationId: 1, role: 1 });
userSchema.index({ organisationId: 1, createdAt: -1 });

module.exports = mongoose.model("User", userSchema);
