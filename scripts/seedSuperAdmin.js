/**
 * Seed / bootstrap the Super Admin user.
 *
 * Credentials are NOT hardcoded. Set them via env, or let the script generate a
 * strong one-time password and print it once:
 *
 *   SUPERADMIN_EMAIL=you@example.com SUPERADMIN_PASSWORD=... npm run seed:superadmin
 *   # or simply:  npm run seed:superadmin   (generates + prints a random password)
 *
 * Idempotent: if the super admin already exists, its role is ensured and the
 * password is left UNCHANGED unless SUPERADMIN_PASSWORD is provided (so re-running
 * never silently locks you out).
 */
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const User = require("../models/user");

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("MONGODB_URI not found in .env");
  process.exit(1);
}

function generatePassword() {
  return crypto
    .randomBytes(18)
    .toString("base64")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 20);
}

async function seed() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB");

    const email = (process.env.SUPERADMIN_EMAIL || "superadmin@yopmail.com").toLowerCase();
    const envPassword = process.env.SUPERADMIN_PASSWORD;

    const existing = await User.findOne({ email });

    if (existing) {
      existing.role = "superadmin";
      existing.organisationId = null;
      existing.failedLoginAttempts = 0;
      existing.lockedUntil = null;
      if (envPassword) {
        existing.password = await bcrypt.hash(envPassword, 10);
        console.log("Super admin already exists — password updated from SUPERADMIN_PASSWORD.");
      } else {
        console.log("Super admin already exists — role ensured, password left unchanged.");
      }
      await existing.save();
    } else {
      const password = envPassword || generatePassword();
      const hashedPassword = await bcrypt.hash(password, 10);
      await User.create({
        name: "Super Admin",
        email,
        password: hashedPassword,
        role: "superadmin",
        organisationId: null,
      });
      console.log("\nSuper admin created.");
      console.log("  Email:    " + email);
      if (envPassword) {
        console.log("  Password: (from SUPERADMIN_PASSWORD env)");
      } else {
        console.log("  Password: " + password);
        console.log("  ^ SAVE THIS NOW — it will not be shown again.\n");
      }
    }
  } catch (error) {
    console.error("Seed failed:", error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

seed();
