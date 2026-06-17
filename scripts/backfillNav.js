/**
 * Backfill navbar labels & ordering for organisations seeded BEFORE the
 * navbar restructure (see config/pageTemplates.js).
 *
 * Why this is needed: seedPagesForOrg() writes navLabel/navOrder with
 * $setOnInsert, so existing tenants keep the labels they were first seeded with
 * even after the template defaults change. Structural fields (navParentKey,
 * path) DO sync automatically — only the editable label/order need a backfill.
 *
 * This script is conservative and idempotent:
 *   1. Renames only happen where the stored label still equals the OLD default
 *      — any label an admin customised is left untouched.
 *   2. navOrder is realigned only for the pages that were regrouped (their
 *      stored order is now stale child order under a new parent).
 *   3. On-page content (hero titles, the Get Involved card) is updated only
 *      where it still equals the OLD default — so any copy an admin edited in
 *      the CMS is left untouched.
 *
 * New labels are read from the live templates, so they stay correct if the
 * templates are renamed again later.
 *
 * Run:  npm run backfill:nav
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Page = require("../models/page");
const { getTemplate } = require("../config/pageTemplates");

const MONGODB_URI = process.env.MONGODB_URI;

// key → the OLD label to replace. The NEW label is pulled from the template.
// Only docs whose current navLabel still matches the old value are renamed,
// so customised labels survive.
const RENAMES = {
  about: "About Us",
  initiatives: "Our Initiatives",
  giving: "Islamic Giving",
  ramadan: "Ramadan Donations",
  teamHope: "Team Hope",
  contact: "Contact Us",
};

// Pages that were moved under a new/different parent — their stored navOrder is
// stale (it was their old top-level order). Reset these to the template order so
// the dropdowns read in the intended sequence.
const REORDER_KEYS = ["programs", "events", "p2p-campaigns", "teamHope", "getInvolved", "contact"];

// On-page hero titles that mirrored the old nav names. Updated only where the
// stored content still equals `from`, so CMS-edited copy is preserved.
const CONTENT_EDITS = [
  { key: "giving", path: "content.hero.title", from: "Islamic Giving", to: "Ways to Give" },
  { key: "teamHope", path: "content.hero.title", from: "Team Hope", to: "Volunteer" },
];

// Same idea, but for a value inside a content array (matched + set via the
// positional $[el] filter).
const CONTENT_ARRAY_EDITS = [
  { key: "getInvolved", arrayPath: "content.cards", field: "title", from: "Volunteer with Team Hope", to: "Volunteer" },
];

async function run() {
  if (!MONGODB_URI) {
    console.error("ERROR: MONGODB_URI not set in .env");
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log("✓ Connected to MongoDB\n");

  // ── 1. Rename labels (only where still the old default) ──────────────
  console.log("Renaming menu labels (skipping any an admin customised)…");
  let renamed = 0;
  for (const [key, oldLabel] of Object.entries(RENAMES)) {
    const tpl = getTemplate(key);
    const newLabel = tpl?.navLabel;
    if (!newLabel || newLabel === oldLabel) continue;
    const res = await Page.updateMany(
      { key, navLabel: oldLabel },
      { $set: { navLabel: newLabel } },
    );
    const n = res.modifiedCount ?? res.nModified ?? 0;
    renamed += n;
    console.log(`  • ${key}: "${oldLabel}" → "${newLabel}"  (${n} page${n === 1 ? "" : "s"})`);
  }

  // ── 2. Realign order for regrouped pages ─────────────────────────────
  console.log("\nRealigning order for regrouped pages…");
  let reordered = 0;
  for (const key of REORDER_KEYS) {
    const tpl = getTemplate(key);
    if (!tpl || typeof tpl.navOrder !== "number") continue;
    const res = await Page.updateMany(
      { key, navOrder: { $ne: tpl.navOrder } },
      { $set: { navOrder: tpl.navOrder } },
    );
    const n = res.modifiedCount ?? res.nModified ?? 0;
    reordered += n;
    console.log(`  • ${key}: navOrder → ${tpl.navOrder}  (${n} page${n === 1 ? "" : "s"})`);
  }

  // ── 3. Update on-page content (only where still the old default) ──────
  console.log("\nUpdating on-page content (skipping any an admin edited)…");
  let content = 0;
  for (const e of CONTENT_EDITS) {
    const res = await Page.updateMany(
      { key: e.key, [e.path]: e.from },
      { $set: { [e.path]: e.to } },
    );
    const n = res.modifiedCount ?? res.nModified ?? 0;
    content += n;
    console.log(`  • ${e.key} ${e.path}: "${e.from}" → "${e.to}"  (${n} page${n === 1 ? "" : "s"})`);
  }
  for (const e of CONTENT_ARRAY_EDITS) {
    const res = await Page.updateMany(
      { key: e.key, [`${e.arrayPath}.${e.field}`]: e.from },
      { $set: { [`${e.arrayPath}.$[el].${e.field}`]: e.to } },
      { arrayFilters: [{ [`el.${e.field}`]: e.from }] },
    );
    const n = res.modifiedCount ?? res.nModified ?? 0;
    content += n;
    console.log(`  • ${e.key} ${e.arrayPath}[].${e.field}: "${e.from}" → "${e.to}"  (${n} page${n === 1 ? "" : "s"})`);
  }

  console.log(`\n✅ Backfill complete — ${renamed} label(s) renamed, ${reordered} order(s) realigned, ${content} content field(s) updated.`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (e) => {
  console.error("\n❌ Backfill failed:", e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
