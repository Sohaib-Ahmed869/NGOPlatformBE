/**
 * One-time backfill for the SuperAdmin Team/roles feature: every existing
 * `User{role:"superadmin"}` created before `platformRole`/`platformStatus`
 * existed gets promoted to Owner/Active.
 *
 *   npm run migrate:platform-roles
 *
 * Must be run right after deploying this change — middleware/requireCapability
 * fails closed on a missing platformRole, so an un-migrated existing operator
 * is locked out of every capability-gated route until this runs. Idempotent:
 * only touches rows missing platformRole, safe to re-run.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/user");

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI not found in .env");
  process.exit(1);
}

async function migrate() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB");

    const result = await User.updateMany(
      { role: "superadmin", platformRole: { $exists: false } },
      { $set: { platformRole: "owner", platformStatus: "active" } }
    );

    console.log(`Promoted ${result.modifiedCount} existing super admin(s) to Owner. ✔`);
  } catch (error) {
    console.error("Migration failed:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

migrate();
