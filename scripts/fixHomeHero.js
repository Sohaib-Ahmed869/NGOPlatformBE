/**
 * One-off: the Home hero was reverted to its bespoke <Hero/> component (which
 * also renders the stats), so the `hero` and `statsBand` blocks are removed from
 * Home's section list. The page's `content.hero` (used by the bespoke Hero) is
 * left untouched. Idempotent.
 *
 * Run:  npm run fix:home-hero
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Page = require("../models/page");

const DROP = new Set(["hero", "statsBand"]);
const MONGODB_URI = process.env.MONGODB_URI;

async function run() {
  if (!MONGODB_URI) {
    console.error("ERROR: MONGODB_URI not set in .env");
    process.exit(1);
  }
  await mongoose.connect(MONGODB_URI);
  console.log("✓ Connected to MongoDB\n");

  const docs = await Page.find({ key: "home" });
  let updated = 0;
  for (const d of docs) {
    let changed = false;
    for (const field of ["content", "draftContent"]) {
      const c = d[field];
      if (c && Array.isArray(c.sections)) {
        const filtered = c.sections.filter((s) => !DROP.has(s.type));
        if (filtered.length !== c.sections.length) {
          c.sections = filtered;
          d.markModified(field);
          changed = true;
        }
      }
    }
    if (changed) {
      await d.save();
      updated++;
      console.log(`  ✓ ${d.organisationId} — ${d.content.sections.length} block(s) remain`);
    }
  }

  console.log(`\n✅ Done — ${updated} home page(s) cleaned.`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (e) => {
  console.error("\n❌ Failed:", e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
