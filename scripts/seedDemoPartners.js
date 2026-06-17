/**
 * Clear the placeholder logos on the Our Partners page and seed a set of
 * fully-detailed demo partners (approved + published) so the wall looks
 * populated with the new card design.
 *
 * - Demo partners are tagged source="seed-demo" so re-running replaces them
 *   (never duplicates) and they're easy to find/remove in Admin → Partners.
 * - Real submissions (source="website") are left untouched.
 * - Logos are self-contained SVG monograms (data-URI) — always render, no
 *   external dependency. Replace any with a real logo via the admin later.
 *
 * Run from BE root:  node scripts/seedDemoPartners.js [slug]   (default calcite)
 */
require("dotenv").config();
const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI;
const Organisation = require("../models/organisation");
const Page = require("../models/page");
const PartnerInquiry = require("../models/partnerInquiry");

const SLUG = process.argv[2] || "calcite";

// Clean gradient monogram badge → data-URI SVG (renders anywhere, no network).
function monogram(initials, c1, c2, rx = 44) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>` +
    `</linearGradient></defs>` +
    `<rect x="16" y="16" width="168" height="168" rx="${rx}" fill="url(#g)"/>` +
    `<text x="100" y="100" dy=".34em" text-anchor="middle" ` +
    `font-family="'Segoe UI',Arial,Helvetica,sans-serif" font-size="82" font-weight="700" ` +
    `fill="#ffffff" letter-spacing="1">${initials}</text></svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

// org, initials, gradient, type, website, contact, phone, blurb
const DEMO = [
  ["Crescent Relief Foundation", "CR", ["#0EA5A4", "#14B8A6"], "in-kind", "crescentrelief.org", "Imran Khalid", "+61 2 8000 1201"],
  ["Noor Education Trust", "NE", ["#6366F1", "#818CF8"], "community", "nooreducation.org", "Sana Mahmood", "+61 2 8000 1202", 100],
  ["Sadaqah Welfare Fund", "SW", ["#F43F5E", "#FB7185"], "corporate", "sadaqahwelfare.org", "Yusuf Adeyemi", "+61 2 8000 1203"],
  ["Helping Hands Alliance", "HH", ["#F59E0B", "#FBBF24"], "community", "helpinghands.org", "Aisha Siddiqui", "+61 2 8000 1204", 100],
  ["Ummah Health Initiative", "UH", ["#10B981", "#34D399"], "corporate", "ummahhealth.org", "Bilal Rahman", "+61 2 8000 1205"],
  ["Green Crescent Society", "GC", ["#0EA5E9", "#38BDF8"], "ambassador", "greencrescent.org", "Layla Hassan", "+61 2 8000 1206", 100],
  ["Baitul Maal Foundation", "BM", ["#8B5CF6", "#A78BFA"], "in-kind", "baitulmaal.org", "Omar Farooq", "+61 2 8000 1207"],
];

(async () => {
  if (!MONGODB_URI) {
    console.error("ERROR: MONGODB_URI not set in .env");
    process.exit(1);
  }
  await mongoose.connect(MONGODB_URI);

  const org = await Organisation.findOne({ slug: SLUG }).select("name slug").lean();
  if (!org) {
    console.error(`No organisation with slug "${SLUG}"`);
    await mongoose.connection.close();
    process.exit(1);
  }
  const organisationId = org._id;

  /* 1) Clear the placeholder manual logos on the Our Partners page. */
  const page = await Page.findOne({ organisationId, key: "partners" });
  if (page) {
    let cleared = 0;
    const clear = (content) => {
      if (!content || !Array.isArray(content.sections)) return;
      content.sections.forEach((s) => {
        if (s && s.type === "logosStrip" && Array.isArray(s.data?.items) && s.data.items.length) {
          cleared += s.data.items.length;
          s.data.items = [];
          s.data.source = "approved"; // wall now shows the approved partners only
        }
      });
    };
    clear(page.content);
    if (page.draftContent) clear(page.draftContent);
    page.markModified("content");
    if (page.draftContent) page.markModified("draftContent");
    await page.save();
    console.log(`[${SLUG}] cleared ${cleared} placeholder logo(s); logosStrip source → "approved".`);
  } else {
    console.log(`[${SLUG}] no saved partners page (defaults apply) — nothing to clear.`);
  }

  /* 2) Replace any previously-seeded demo partners (idempotent). */
  const del = await PartnerInquiry.deleteMany({ organisationId, source: "seed-demo" });
  if (del.deletedCount) console.log(`[${SLUG}] removed ${del.deletedCount} previously-seeded demo partner(s).`);

  /* 3) Insert the demo partners (approved + published), ordered after real ones. */
  const docs = DEMO.map(([orgName, initials, [c1, c2], type, domain, contact, phone, rx], i) => ({
    organisationId,
    name: contact,
    organisationName: orgName,
    publicName: orgName,
    email: `partnerships@${domain}`,
    phone,
    website: `https://${domain}`,
    partnershipType: type,
    message: `${orgName} is proud to partner with ${org.name} to extend support to communities in need.`,
    adminNotes: "Seeded demo partner — safe to delete.",
    consentToList: true,
    status: "approved",
    showOnWebsite: true,
    displayOrder: i + 2, // real partners keep order 1
    logoUrl: monogram(initials, c1, c2, rx ?? 44),
    source: "seed-demo",
  }));
  await PartnerInquiry.insertMany(docs);
  console.log(`[${SLUG}] seeded ${docs.length} demo partners.`);

  /* 4) Show what the public wall will render now. */
  const live = await PartnerInquiry.find({ organisationId, status: "approved", showOnWebsite: true })
    .sort({ displayOrder: 1, createdAt: 1 })
    .select("organisationName name publicName logoUrl publicLogoUrl website displayOrder source")
    .lean();
  console.log(`\nWall will show ${live.length} partner(s):`);
  live.forEach((p) =>
    console.log(
      `  #${p.displayOrder ?? 0}  ${p.publicName || p.organisationName || p.name}  ` +
        `[${p.source}]  logo=${(p.publicLogoUrl || p.logoUrl || "").slice(0, 24)}…  site=${p.website || "-"}`,
    ),
  );

  await mongoose.connection.close();
  console.log("\nDone. Reload the public Our Partners page (cached content may need one refresh).");
})().catch(async (e) => {
  console.error("Seed error:", e);
  try {
    await mongoose.connection.close();
  } catch {}
  process.exit(1);
});
