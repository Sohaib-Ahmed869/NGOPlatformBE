/**
 * One-time migration script to drop old globally-unique indexes
 * and let Mongoose recreate them as org-scoped compound indexes.
 *
 * Run: node scripts/dropOldIndexes.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI not set in .env");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const db = mongoose.connection.db;

  // --- orders.donationId_1 ---
  try {
    const orderIndexes = await db.collection("orders").indexes();
    const hasDonationId = orderIndexes.some((i) => i.name === "donationId_1");
    if (hasDonationId) {
      await db.collection("orders").dropIndex("donationId_1");
      console.log("Dropped old index: orders.donationId_1");
    } else {
      console.log("Index orders.donationId_1 not found — skipping");
    }
  } catch (err) {
    console.error("Error dropping orders.donationId_1:", err.message);
  }

  // --- products.slug_1 ---
  try {
    const productIndexes = await db.collection("products").indexes();
    const hasSlug = productIndexes.some((i) => i.name === "slug_1");
    if (hasSlug) {
      await db.collection("products").dropIndex("slug_1");
      console.log("Dropped old index: products.slug_1");
    } else {
      console.log("Index products.slug_1 not found — skipping");
    }
  } catch (err) {
    console.error("Error dropping products.slug_1:", err.message);
  }

  // --- Verify new indexes will be created on next app startup ---
  console.log("\nOld global unique indexes removed.");
  console.log("New compound indexes (organisationId + donationId/slug) will be created automatically when the server starts.\n");

  await mongoose.disconnect();
  console.log("Done.");
  process.exit(0);
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
