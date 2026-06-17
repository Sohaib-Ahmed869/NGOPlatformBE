/**
 * scripts/seedBrandingRequests.js  — DEMO / DEV DATA
 *
 * Seeds branding-change requests exactly as the tenant portal would create them
 * (Admin → Portal Branding → "Request change"): requestedBy = the org's admin,
 * a partial `requestedBranding`, and a `currentBranding` snapshot. Mostly pending
 * (the SuperAdmin "Branding Requests" inbox defaults to pending), plus one
 * approved and one rejected for variety.
 *
 * Idempotent: re-running replaces the seeded requests (matched by their exact
 * `message`). Does not touch other branding requests.
 *
 *   node scripts/seedBrandingRequests.js     (or: npm run seed:branding)
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Organisation = require("../models/organisation");
const User = require("../models/user");
const BrandingRequest = require("../models/brandingRequest");

const REQUESTS = [
  {
    slug: "calcite",
    status: "pending",
    message: "We've refreshed our visual identity for 2026 — please apply our new green/gold palette and tagline.",
    requestedBranding: { primaryColor: "#0B3D2E", accentColor: "#E0A83C", backgroundColor: "#FBF8F2", theme: "heritage", tagline: "Empowering communities, one project at a time" },
  },
  {
    slug: "hopegive",
    status: "pending",
    message: "Switching our accent to our new brand blue and adding our tagline to the header.",
    requestedBranding: { accentColor: "#2563EB", tagline: "Give hope. Change lives." },
  },
  {
    slug: "shahid-afridi-foundation",
    status: "pending",
    message: "Aligning the portal with our foundation's green branding and our motto.",
    requestedBranding: { primaryColor: "#0A5C36", accentColor: "#16A34A", tagline: "Hope Not Out" },
  },
  {
    slug: "matw2",
    status: "approved",
    reviewNote: "Looks great — navy applied to the portal.",
    message: "Please update our primary colour to match our website navy.",
    requestedBranding: { primaryColor: "#1E3A5F", tagline: "Muslims Around The World" },
  },
  {
    slug: "testcharity",
    status: "rejected",
    reviewNote: "These colours don't meet accessibility contrast guidelines — please pick a more legible palette and resubmit.",
    message: "Can you make it bright pink with a green accent on a black background?",
    requestedBranding: { primaryColor: "#FF00FF", accentColor: "#22C55E", backgroundColor: "#000000" },
  },
  {
    slug: "matw",
    status: "pending",
    message: "Refreshing our portal to match our 2026 brand guidelines — deep green primary with a gold accent.",
    requestedBranding: { primaryColor: "#1B4D3E", accentColor: "#C9A227", tagline: "Muslims Around The World" },
  },
  {
    slug: "logotest",
    status: "pending",
    message: "Please switch us to the Minimal theme and a teal accent for a cleaner look.",
    requestedBranding: { accentColor: "#0D9488", theme: "minimal", tagline: "Small acts, big change" },
  },
  {
    slug: "testing",
    status: "approved",
    reviewNote: "Applied — softer background looks good.",
    message: "Can we use a softer off-white background across the portal?",
    requestedBranding: { backgroundColor: "#F5F5F4", theme: "classic" },
  },
];

async function run() {
  console.log("\n=== Seeding branding requests (as the tenant portal would) ===\n");
  const superadmin = await User.findOne({ role: "superadmin" }).select("_id");

  // Idempotent: clear previously-seeded requests by their exact message.
  await BrandingRequest.deleteMany({ message: { $in: REQUESTS.map((r) => r.message) } });

  for (const r of REQUESTS) {
    const org = await Organisation.findOne({ slug: r.slug }).select("name slug branding adminUserId");
    if (!org) {
      console.log(`  ! ${r.slug} — organisation not found, skipped`);
      continue;
    }
    let requestedBy = org.adminUserId;
    if (!requestedBy) {
      const admin = await User.findOne({ organisationId: org._id, role: "admin" }).select("_id");
      requestedBy = admin?._id;
    }
    if (!requestedBy) {
      console.log(`  ! ${r.slug} — no admin user to attribute the request to, skipped`);
      continue;
    }

    const doc = {
      organisationId: org._id,
      requestedBy,
      requestedBranding: r.requestedBranding,
      currentBranding: org.branding?.toObject?.() || org.branding || {},
      message: r.message,
      status: r.status,
    };
    if (r.status !== "pending") {
      doc.reviewedBy = superadmin?._id;
      doc.reviewNote = r.reviewNote || "";
      doc.reviewedAt = new Date();
    }
    await BrandingRequest.create(doc);
    console.log(`  + ${org.slug.padEnd(24)} ${r.status.padEnd(9)} ${Object.keys(r.requestedBranding).join(", ")}`);
  }
  console.log("\nDone.\n");
}

(async () => {
  try {
    await connectDB();
    await run();
  } catch (err) {
    console.error("Seed branding requests failed:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
})();
