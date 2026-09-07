/**
 * Put each invented charity's brand on its portal.
 *
 * The sibling script for the real tenants (setAuCharityBranding.js) DOWNLOADS
 * logos off the charities' live websites, which is exactly the thing these two
 * exist to avoid. Here the marks are ours: authored in
 * renderDemoCharityLogos.js and committed as PNG under
 * scripts/assets/demo-charities/. This script only uploads them and writes the
 * branding block, so it needs no network beyond S3 and cannot go stale when
 * somebody else redesigns their website.
 *
 * Field convention (see FE Components/BrandLoader.jsx:27):
 *   logoDark      DARK mark, for LIGHT backgrounds — the public site, the topbar
 *   logo          LIGHT mark, for the DARK sidebar and the dark footer
 *   iconLogo      square mark, the collapsed sidebar and (faviconUseIcon) the tab
 *
 * Colours are each charity's theme preset verbatim, so what lands here is
 * identical to picking that theme in the Branding screen. Both accents clear
 * the 3.0 white-contrast floor in utils/contrast.js, so neither tenant triggers
 * the --tenant-accent-contrast ink swap and button labels stay white.
 *
 * Re-runnable: uploads fresh objects and overwrites the branding block. The
 * previous objects are left in the bucket — S3 is cheap and a rollback is
 * easier with them there.
 *
 * Run:  node scripts/setDemoCharityBranding.js              (both)
 *       node scripts/setDemoCharityBranding.js harbourlight (just one)
 *       npm run brand:demo-charities
 */

require("dotenv").config();
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { s3Client } = require("../config/s3");
const Organisation = require("../models/organisation");
const { selectFromArgv } = require("./demoCharities");

const MONGODB_URI = process.env.MONGODB_URI;
const BUCKET = process.env.S3_BUCKET_NAME;
const REGION = process.env.AWS_REGION;
if (!MONGODB_URI || !BUCKET) {
  console.error("ERROR: MONGODB_URI and S3_BUCKET_NAME must be set in .env");
  process.exit(1);
}

const ASSET_DIR = path.join(__dirname, "assets", "demo-charities");

// file suffix → branding field(s) it fills
const ASSETS = [
  { file: "wordmark.png", fields: ["logoDark"] },
  { file: "wordmark-light.png", fields: ["logo"] },
  { file: "icon.png", fields: ["iconLogo", "iconLogoDark"] },
];

async function putToS3(slug, filename, body) {
  const key = `${slug}/branding/${Date.now()}-${Math.round(Math.random() * 1e9)}.png`;
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: "image/png",
    ContentDisposition: "inline",
  }));
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}

async function run() {
  const charities = selectFromArgv();
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log(`Connected to ${mongoose.connection.name}\n`);

  for (const c of charities) {
    const org = await Organisation.findOne({ slug: c.slug });
    if (!org) {
      console.log(`SKIP ${c.slug} — no organisation with that slug. Run seed:demo-charities first.\n`);
      continue;
    }
    console.log(`── ${org.name} ${"─".repeat(Math.max(0, 50 - org.name.length))}`);

    const uploaded = {};
    let missing = false;
    for (const a of ASSETS) {
      const local = path.join(ASSET_DIR, `${c.slug}-${a.file}`);
      if (!fs.existsSync(local)) {
        console.log(`   ${a.file.padEnd(20)} MISSING at ${path.relative(process.cwd(), local)}`);
        missing = true;
        continue;
      }
      const buf = fs.readFileSync(local);
      const url = await putToS3(c.slug, a.file, buf);
      for (const f of a.fields) uploaded[f] = url;
      console.log(`   ${a.file.padEnd(20)} ${(buf.length / 1024).toFixed(1).padStart(6)}KB → ${a.fields.join(", ")}`);
    }
    if (missing) {
      console.log("   Re-render with: node scripts/renderDemoCharityLogos.js\n");
    }

    org.branding = {
      ...(org.branding ? org.branding.toObject?.() ?? org.branding : {}),
      ...uploaded,
      siteTitle: c.brand.siteTitle,
      tagline: c.brand.tagline,
      primaryColor: c.brand.primaryColor,
      accentColor: c.brand.accentColor,
      backgroundColor: c.brand.backgroundColor,
      theme: c.brand.theme,
      faviconUseIcon: true, // the tab follows iconLogo
    };
    org.markModified("branding");
    await org.save();

    console.log(`   colours    primary ${c.brand.primaryColor} · accent ${c.brand.accentColor} · bg ${c.brand.backgroundColor} (${c.brand.theme})`);
    console.log(`   title      ${c.brand.siteTitle} — "${c.brand.tagline}"\n`);
  }

  await mongoose.disconnect();
  console.log("Done. Open each portal's Branding screen to confirm the marks sit right.");
}

run().catch(async (e) => {
  console.error("\nFAILED:", e.message);
  console.error(e.stack);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
