/**
 * Seed default website pages for every existing organisation.
 *
 * Idempotent: creates missing Page documents from config/pageTemplates.js and
 * keeps structural fields (path, navParentKey) in sync, without touching any
 * content/toggles an admin has already edited.
 *
 * Run:  npm run seed:pages
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Organisation = require("../models/organisation");
const { seedPagesForOrg } = require("../services/pageService");
const { PAGE_TEMPLATES } = require("../config/pageTemplates");

const MONGODB_URI = process.env.MONGODB_URI;

async function run() {
  if (!MONGODB_URI) {
    console.error("ERROR: MONGODB_URI not set in .env");
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log("✓ Connected to MongoDB\n");

  const orgs = await Organisation.find({}).select("_id name slug").lean();
  console.log(`Found ${orgs.length} organisation(s). Seeding ${PAGE_TEMPLATES.length} pages each...\n`);

  for (const org of orgs) {
    try {
      await seedPagesForOrg(org._id);
      console.log(`  ✓ ${org.slug || org.name} (${org._id})`);
    } catch (e) {
      console.error(`  ✗ ${org.slug || org.name}: ${e.message}`);
    }
  }

  console.log("\n✅ Page seeding complete.");
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (e) => {
  console.error("\n❌ Seeding failed:", e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
