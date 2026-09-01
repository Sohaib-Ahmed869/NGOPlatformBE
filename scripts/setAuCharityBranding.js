/**
 * Apply each Australian charity tenant's real brand to its portal.
 *
 * Colours are measured, not guessed:
 *   OzHarvest    ink #201D0C   — the fill in their own logo SVG (.st0{fill:#201d0c})
 *                               and the dominant colour on ozharvest.org
 *                accent #FADF01 — the signature yellow, sampled from the live site
 *   Human Appeal accent #48B848 — sampled from their header logo artwork
 *                ink #1D1D1B   — the near-black their site sets on body copy
 *
 * Field convention (see Components/BrandLoader.jsx:27):
 *   logoDark  = DARK mark, for LIGHT backgrounds
 *   logo      = LIGHT mark, for the DARK sidebar
 * OzHarvest publish only a dark monochrome mark, so the reversed cut is
 * generated here by swapping the single fill in their SVG to white. That is a
 * stand-in for the official reversed asset — ask for their media kit at handover.
 *
 * Both accents are pale enough that a white button label fails WCAG
 * (yellow 1.34:1, green 2.55:1 against white). utils/contrast.js catches this
 * and swaps in each charity's own ink via --tenant-accent-contrast, so no
 * manual correction is needed here.
 *
 * Re-runnable: uploads fresh assets and overwrites the branding block.
 *
 * Run:  node scripts/setAuCharityBranding.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const path = require("path");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { s3Client } = require("../config/s3");
const Organisation = require("../models/organisation");

const MONGODB_URI = process.env.MONGODB_URI;
const BUCKET = process.env.S3_BUCKET_NAME;
const REGION = process.env.AWS_REGION;
if (!MONGODB_URI || !BUCKET) {
  console.error("ERROR: MONGODB_URI and S3_BUCKET_NAME must be set in .env");
  process.exit(1);
}

const CONTENT_TYPE = { ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp",
  ".ico": "image/x-icon", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

const BRANDS = {
  ozharvest: {
    siteTitle: "OzHarvest",
    tagline: "Australia's leading food rescue organisation",
    primaryColor: "#201D0C",
    accentColor: "#FADF01",
    backgroundColor: "#FFFBF5",
    theme: "warm-amber", // closest preset; explicit colours above are what render
    assets: {
      logoDark: { url: "https://www.ozharvest.org/assets/images/main-logo.svg", name: "ozharvest-logo.svg" },
      iconLogo: { url: "https://www.ozharvest.org/apple-touch-icon.png", name: "ozharvest-icon.png" },
    },
    // Their mark is one flat fill, so a reversed cut is a single substitution.
    reverseFrom: "logoDark",
    reverse: { find: /fill:\s*#201d0c/gi, replace: "fill:#FFFFFF", name: "ozharvest-logo-reversed.svg" },
  },
  humanappeal: {
    siteTitle: "Human Appeal Australia",
    tagline: "Continuing with you to the road of goodness",
    primaryColor: "#1D1D1B",
    accentColor: "#48B848",
    backgroundColor: "#F5F5F5",
    theme: "nature-meadow",
    assets: {
      logoDark: {
        url: "https://cdn-ileoklk.nitrocdn.com/sTmSNJjyBiSfcuXtxRYHjiouGHqifJSn/assets/images/optimized/rev-0f9222c/www.humanappeal.org.au/wp-content/uploads/2025/12/header-logo-300x95-x60.png",
        name: "humanappeal-logo.png",
      },
      // Their declared 192x192 site icon. Without a square mark the collapsed
      // sidebar falls back to the 189x60 wordmark and squashes it.
      iconLogo: {
        url: "https://cdn-ileoklk.nitrocdn.com/sTmSNJjyBiSfcuXtxRYHjiouGHqifJSn/assets/images/optimized/rev-0f9222c/www.humanappeal.org.au/wp-content/uploads/2026/07/cropped-images-192x192.jpeg",
        name: "humanappeal-icon.jpeg",
      },
    },
    // The mark is mid-green on transparent — it reads on both grounds, so the
    // same file serves the dark sidebar. No reversed cut needed.
    sameForDark: true,
  },
};

async function download(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function putToS3(slug, filename, body) {
  const ext = path.extname(filename).toLowerCase();
  const key = `${slug}/branding/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: CONTENT_TYPE[ext] || "application/octet-stream",
    ContentDisposition: "inline",
  }));
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}

async function run() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log(`Connected to ${mongoose.connection.name}\n`);

  for (const [slug, brand] of Object.entries(BRANDS)) {
    const org = await Organisation.findOne({ slug });
    if (!org) { console.log(`SKIP ${slug} — no organisation with that slug.\n`); continue; }
    console.log(`── ${org.name} ${"─".repeat(Math.max(0, 50 - org.name.length))}`);

    const uploaded = {};
    const raw = {};
    for (const [field, a] of Object.entries(brand.assets)) {
      try {
        const buf = await download(a.url);
        raw[field] = buf;
        uploaded[field] = await putToS3(slug, a.name, buf);
        console.log(`   ${field.padEnd(10)} ${(buf.length / 1024).toFixed(1)}KB → ${uploaded[field].split("/").pop()}`);
      } catch (e) {
        console.log(`   ${field.padEnd(10)} FAILED (${e.message}) — leaving unset`);
      }
    }

    // Reversed cut for the dark sidebar.
    if (brand.reverse && raw[brand.reverseFrom]) {
      const src = raw[brand.reverseFrom].toString("utf8");
      if (brand.reverse.find.test(src)) {
        const out = Buffer.from(src.replace(brand.reverse.find, brand.reverse.replace), "utf8");
        uploaded.logo = await putToS3(slug, brand.reverse.name, out);
        console.log(`   logo       reversed cut generated → ${uploaded.logo.split("/").pop()}`);
      } else {
        console.log(`   logo       could not generate reversed cut — fill pattern not found`);
      }
    } else if (brand.sameForDark && uploaded.logoDark) {
      uploaded.logo = uploaded.logoDark;
      console.log(`   logo       reuses the same mark (reads on dark)`);
    }
    if (uploaded.iconLogo) uploaded.iconLogoDark = uploaded.iconLogo;

    org.branding = {
      ...(org.branding ? org.branding.toObject?.() ?? org.branding : {}),
      ...uploaded,
      siteTitle: brand.siteTitle,
      tagline: brand.tagline,
      primaryColor: brand.primaryColor,
      accentColor: brand.accentColor,
      backgroundColor: brand.backgroundColor,
      theme: brand.theme,
      faviconUseIcon: true, // favicon follows iconLogo
    };
    org.markModified("branding");
    await org.save();

    console.log(`   colours    primary ${brand.primaryColor} · accent ${brand.accentColor} · bg ${brand.backgroundColor}`);
    console.log(`   title      ${brand.siteTitle} — "${brand.tagline}"\n`);
  }

  await mongoose.disconnect();
  console.log("Done. Check each portal's Branding screen to confirm the marks sit right.");
}

run().catch(async (e) => {
  console.error("\nFAILED:", e.message);
  console.error(e.stack);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
