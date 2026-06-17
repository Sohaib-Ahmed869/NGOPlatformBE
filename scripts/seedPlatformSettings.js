/**
 * Seed / populate the platform settings singleton (powers the public SaaS
 * marketing site). Idempotent + NON-destructive: only fills fields that are
 * still empty, so it never clobbers logos you've uploaded or edits you've made.
 *
 *   npm run seed:platform
 *
 * Demo logos are self-contained SVG data-URIs (always render, no S3 needed) so
 * you can see the dynamic light/dark/icon logos immediately; replace them any
 * time from SuperAdmin → Platform → Branding.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const PlatformSettings = require("../models/platformSettings");

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI not found in .env");
  process.exit(1);
}

// ── Self-contained SVG brand marks (data-URIs) ──
const wordmark = (textColor) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="184" height="40" viewBox="0 0 184 40">` +
  `<rect x="2" y="6" width="28" height="28" rx="8" fill="#047857"/>` +
  `<text x="16" y="26" text-anchor="middle" font-family="Outfit, Arial, sans-serif" font-size="16" font-weight="800" fill="#ffffff">N</text>` +
  `<text x="40" y="26" font-family="Outfit, Arial, sans-serif" font-size="18" font-weight="800" fill="${textColor}">NGO Platform</text>` +
  `</svg>`;
const iconMark = (size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 40">` +
  `<rect x="2" y="2" width="36" height="36" rx="10" fill="#047857"/>` +
  `<text x="20" y="28" text-anchor="middle" font-family="Outfit, Arial, sans-serif" font-size="22" font-weight="800" fill="#ffffff">N</text>` +
  `</svg>`;
const dataUri = (svg) => "data:image/svg+xml," + encodeURIComponent(svg);

const DEMO = {
  name: "NGO Platform",
  tagline: "Fundraising software built for charities",
  description:
    "The warm, all-in-one platform that helps charities raise funds, welcome donors and run campaigns — with their own branded portal.",
  contactEmail: "support@ngoplatform.com",
  contactPhone: "+61 2 8000 1234",
  address: "Sydney, NSW, Australia",
  socialLinks: {
    facebook: "https://facebook.com/ngoplatform",
    instagram: "https://instagram.com/ngoplatform",
    twitter: "https://x.com/ngoplatform",
    linkedin: "https://linkedin.com/company/ngoplatform",
  },
  branding: {
    logo: dataUri(wordmark("#ffffff")), // light wordmark — dark footer
    logoDark: dataUri(wordmark("#102A23")), // dark wordmark — light navbar
    iconLogo: dataUri(iconMark(40)), // light-bg-safe icon
    iconLogoDark: dataUri(iconMark(40)), // dark-bg-safe icon
    favicon: dataUri(iconMark(64)),
    primaryColor: "#102A23",
    accentColor: "#047857",
    backgroundColor: "#F3F8F5",
    theme: "modern-emerald",
  },
};

async function seed() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB");

    const s = await PlatformSettings.getSingleton();
    let filled = 0;
    const fill = (obj, key, val) => {
      if (!obj[key]) {
        obj[key] = val;
        filled += 1;
        return true;
      }
      return false;
    };

    // Top-level text (name/description/email/address already default — fill only if blank).
    ["name", "tagline", "description", "contactEmail", "contactPhone", "address"].forEach((k) => fill(s, k, DEMO[k]));

    Object.keys(DEMO.socialLinks).forEach((k) => fill(s.socialLinks, k, DEMO.socialLinks[k]));
    s.markModified("socialLinks");

    Object.keys(DEMO.branding).forEach((k) => fill(s.branding, k, DEMO.branding[k]));
    s.markModified("branding");

    await s.save();

    console.log(`\nPlatform settings seeded (${filled} empty field(s) filled; existing values kept).`);
    console.log(`  Name:    ${s.name}`);
    console.log(`  Tagline: ${s.tagline}`);
    console.log(`  Logos:   light=${s.branding.logo ? "set" : "-"} dark=${s.branding.logoDark ? "set" : "-"} icon=${s.branding.iconLogoDark ? "set" : "-"}`);
    console.log(`  Colours: ${s.branding.primaryColor} / ${s.branding.accentColor} / ${s.branding.backgroundColor}`);
    console.log("\nEdit any of this in SuperAdmin → Platform. Reload the marketing site to see changes.\n");
  } catch (error) {
    console.error("Seed failed:", error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

seed();
