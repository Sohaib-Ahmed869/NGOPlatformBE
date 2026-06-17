/**
 * Backfill: create a marketing Mailbox for every tenant that already has its own
 * SMTP configured under organisation.email, so newsletter campaigns immediately
 * use the new rotating-mailbox sender without the admin re-entering credentials.
 *
 * The encrypted password is copied across as-is (same PAYMENT_ENC_KEY), so no
 * decrypt/re-encrypt round-trip is needed.
 *
 * Idempotent: skips any organisation that already has a mailbox. No deletes.
 *
 * Run:  npm run seed:mailboxes
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Organisation = require("../models/organisation");
const Mailbox = require("../models/Mailbox");

const MONGODB_URI = process.env.MONGODB_URI;

async function run() {
  if (!MONGODB_URI) {
    console.error("ERROR: MONGODB_URI not set in .env");
    process.exit(1);
  }
  await mongoose.connect(MONGODB_URI);
  console.log("✓ Connected to MongoDB\n");

  // Tenants with a usable SMTP config on organisation.email.
  const orgs = await Organisation.find({
    "email.host": { $nin: [null, ""] },
    "email.username": { $nin: [null, ""] },
    "email.passwordEnc": { $nin: [null, ""] },
  }).select("name slug email");

  let created = 0;
  let skipped = 0;
  for (const org of orgs) {
    const existing = await Mailbox.countDocuments({ organisationId: org._id });
    if (existing > 0) {
      skipped += 1;
      console.log(`  • ${org.slug || org.name}: already has ${existing} mailbox(es) — skipped`);
      continue;
    }
    const e = org.email;
    await Mailbox.create({
      organisationId: org._id,
      label: e.accountLabel || e.username,
      smtp: {
        host: e.host,
        port: e.port || 587,
        secure: !!e.secure,
        username: e.username,
        passwordEnc: e.passwordEnc, // already AES-256-GCM encrypted
      },
      fromName: e.fromName || org.name || "",
      fromEmail: e.fromEmail || e.username,
      replyTo: e.replyTo || "",
      lastVerifiedAt: e.lastVerifiedAt || null,
      isDefault: true,
    });
    created += 1;
    console.log(`  ✓ ${org.slug || org.name}: mailbox created from org.email (${e.username})`);
  }

  console.log(`\n✅ Done. ${created} mailbox(es) created, ${skipped} org(s) skipped.`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (e) => {
  console.error("\n❌ Mailbox backfill failed:", e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
