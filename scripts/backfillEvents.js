/**
 * Backfill registrationMode on existing events.
 *
 * Events created before the events revamp have no registrationMode. We derive a
 * safe default so the public site behaves exactly as before:
 *   - has a registrationLink  -> "external" (shows the same link button)
 *   - no registrationLink     -> "none"     (info-only)
 *
 * Idempotent: only touches docs where registrationMode is missing/empty.
 *
 * Run:  npm run backfill:events
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Event = require("../models/event");

const MONGODB_URI = process.env.MONGODB_URI;

async function run() {
  if (!MONGODB_URI) {
    console.error("ERROR: MONGODB_URI not set in .env");
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log("✓ Connected to MongoDB\n");

  const missing = await Event.find({
    $or: [{ registrationMode: { $exists: false } }, { registrationMode: null }, { registrationMode: "" }],
  }).select("_id registrationLink");

  console.log(`Found ${missing.length} event(s) needing a registrationMode.\n`);

  let external = 0;
  let none = 0;
  for (const ev of missing) {
    const mode = ev.registrationLink && ev.registrationLink.trim() ? "external" : "none";
    await Event.updateOne({ _id: ev._id }, { $set: { registrationMode: mode } });
    mode === "external" ? external++ : none++;
  }

  console.log(`  ✓ external: ${external}`);
  console.log(`  ✓ none:     ${none}`);
  console.log("\n✅ Event backfill complete.");
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (e) => {
  console.error("\n❌ Backfill failed:", e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
