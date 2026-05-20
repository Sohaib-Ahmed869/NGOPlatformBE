/**
 * Seed Super Admin User
 *
 * Run:  node scripts/seedSuperAdmin.js
 *
 * Login credentials after seeding:
 *   Email:    superadmin@yopmail.com
 *   Password: kitkat123
 */

require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const User = require("../models/user");

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("MONGODB_URI not found in .env");
  process.exit(1);
}

async function seed() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB");

    const email = "superadmin@yopmail.com";
    const existing = await User.findOne({ email });

    if (existing) {
      console.log("Super admin already exists — updating role and password");
      existing.role = "superadmin";
      existing.password = await bcrypt.hash("kitkat123", 10);
      existing.name = "Super Admin";
      existing.organisationId = null;
      await existing.save();
      console.log("Super admin updated successfully");
    } else {
      const hashedPassword = await bcrypt.hash("kitkat123", 10);
      await User.create({
        name: "Super Admin",
        email,
        password: hashedPassword,
        role: "superadmin",
        organisationId: null,
      });
      console.log("Super admin created successfully");
    }

    console.log("\n  Email:    superadmin@yopmail.com");
    console.log("  Password: kitkat123\n");
  } catch (error) {
    console.error("Seed failed:", error.message);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

seed();
