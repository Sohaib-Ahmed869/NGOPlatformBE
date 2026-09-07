/**
 * Provision the two INVENTED charities as live tenants.
 *
 *   Lead (source: superadmin_manual, stage: new)
 *     → leadConversion.manualProvision()
 *       → Organisation (active, comped) + admin User + seeded pages/donation types
 *       → Lead flips to "won" with convertedOrgId + stageHistory
 *
 * It deliberately goes the long way round — through the same operator path a
 * SuperAdmin uses on the Leads screen — rather than inserting an Organisation
 * directly. A tenant hand-inserted into Mongo is missing whatever provisioning
 * does today and silently keeps missing whatever it does tomorrow; this way the
 * demo tenants are provisioned exactly like a paying one, and running this
 * script is itself a smoke test of the conversion path.
 *
 * Who these charities are, and why every phone number and domain in them is
 * unreachable on purpose: see scripts/demoCharities.js.
 *
 * ── The welcome email goes nowhere, by design ───────────────────────────────
 * manualProvision emails the new admin a "set your password" link. Both admin
 * addresses are on unregistered domains: the relay ACCEPTS the message (so the
 * script reports "sent") and the delivery bounces back to the platform sender
 * minutes later. Nobody receives it either way, which is the point — a demo
 * tenant must not be able to mail a real person. Access comes from what this
 * script prints instead: a known password AND a fresh set-password link.
 *
 * Re-runnable: an existing organisation or admin user for either slug is
 * reported and skipped, so this never half-provisions over the top of itself.
 *
 * Run:  node scripts/seedDemoCharities.js              (both)
 *       node scripts/seedDemoCharities.js bellhaven    (just one)
 *       npm run seed:demo-charities
 *
 * Then:  npm run brand:demo-charities   (marks + colours)
 *        npm run seed:demo-content      (programmes, events, donations, …)
 */

require("dotenv").config();
const mongoose = require("mongoose");
const crypto = require("crypto");
const bcrypt = require("bcrypt");

const Lead = require("../models/lead");
const User = require("../models/user");
const Organisation = require("../models/organisation");
const DonationType = require("../models/donationtypes");
const { manualProvision } = require("../services/leadConversion");
const { selectFromArgv } = require("./demoCharities");

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("ERROR: No MONGODB_URI in .env");
  process.exit(1);
}

// The demo tenants' admin password. Set DEMO_ADMIN_PASSWORD in .env to keep it
// out of the repo — this default is a convenience for a local demo database and
// nothing more. Never point it at a password used anywhere real.
const ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD || "@nvidia940MX";

/** A fresh set-password link, so access never depends on an email landing. */
async function mintSetPasswordLink(adminUser) {
  const raw = crypto.randomBytes(32).toString("hex");
  adminUser.resetPasswordToken = crypto.createHash("sha256").update(raw).digest("hex");
  adminUser.resetPasswordExpires = Date.now() + 7 * 24 * 3600 * 1000;
  await adminUser.save();
  const base = (process.env.CLIENT_URL || "http://localhost:5173").replace(/\/$/, "");
  return `${base}/reset-password/${raw}`;
}

async function run() {
  const charities = selectFromArgv();
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log(`Connected to ${mongoose.connection.name}\n`);

  const results = [];

  for (const c of charities) {
    console.log(`── ${c.lead.orgName} ${"─".repeat(Math.max(0, 52 - c.lead.orgName.length))}`);

    if (await Organisation.exists({ slug: c.slug })) {
      console.log(`   SKIP — an organisation with slug "${c.slug}" already exists.\n`);
      continue;
    }
    if (await User.exists({ email: c.admin.email })) {
      console.log(`   SKIP — a user already exists for ${c.admin.email}.\n`);
      continue;
    }

    // ── 1. The lead ──────────────────────────────────────────────────────
    const lead = await Lead.create({
      ...c.lead,
      contactName: c.admin.name,
      contactEmail: c.admin.email,
      source: "superadmin_manual",
      stage: "new",
      consentToContact: true,
      consentAt: new Date(),
    });
    console.log(`   Lead created      ${lead._id}  (stage: ${lead.stage}, source: ${lead.source})`);

    // ── 2. Convert it ────────────────────────────────────────────────────
    // A stub req: clientBaseUrl() reads CLIENT_URL first, and req.user is only
    // used for stageHistory attribution, which is nobody here.
    const { organisation, adminUser, emailStatus } = await manualProvision(
      lead,
      {
        ...c.convert,
        slug: c.slug,
        adminName: c.admin.name,
        adminEmail: c.admin.email,
      },
      { user: null },
    );
    console.log(`   Converted         ${organisation._id}  (plan: ${organisation.plan}/${organisation.billingCycle}, comped: ${organisation.isComp})`);
    // "sent" here means the relay accepted it, not that it was delivered — the
    // domain does not exist, so it bounces. See the header.
    console.log(`   Welcome email     ${emailStatus} (bounces — fictional domain, nobody receives it)`);

    // ── 3. The public identity ───────────────────────────────────────────
    // manualProvision seeds contactEmail from the admin LOGIN; the donor-facing
    // site should show the charity's own published details instead. Its name is
    // the legal entity ("… Ltd") because that is what a lead carries; the site
    // and every email header should read as the trading name.
    Object.assign(organisation, c.publicContact);
    organisation.name = c.displayName;
    organisation.eventAudiences = c.eventAudiences;
    await organisation.save();
    console.log(`   Public identity   ${c.displayName} · ${c.publicContact.contactEmail} · ${c.publicContact.contactPhone}`);
    console.log(`   Event audiences   ${c.eventAudiences.map((a) => a.label).join(", ")}`);

    // ── 4. Donation types on top of the vertical defaults ────────────────
    const seeded = await DonationType.countDocuments({ organisationId: organisation._id });
    if (c.extraDonationTypes?.length) {
      await DonationType.insertMany(
        c.extraDonationTypes.map((donationType, i) => ({
          organisationId: organisation._id,
          donationType,
          order: seeded + i,
        })),
        { ordered: false },
      );
    }
    console.log(`   Donation types    ${seeded} default + ${c.extraDonationTypes?.length || 0} tenant-specific`);

    // ── 5. A password, because no email is ever going to arrive ──────────
    adminUser.password = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    await adminUser.save();
    const link = await mintSetPasswordLink(adminUser);

    results.push({
      name: organisation.name,
      slug: organisation.slug,
      orgId: String(organisation._id),
      leadId: String(lead._id),
      adminEmail: c.admin.email,
      plan: `${organisation.plan} / ${organisation.billingCycle}`,
      muslim: organisation.isMuslimCharity,
      link,
    });
    console.log(`   Admin login       ${c.admin.email} / ${ADMIN_PASSWORD}`);
    console.log(`   Set password      ${link}\n`);
  }

  if (results.length) {
    const host = (process.env.CLIENT_URL || "http://localhost:5173").replace(/^https?:\/\//, "");
    console.log("═".repeat(74));
    console.log("DONE — demo tenants provisioned. Set-password links are valid for 7 days.\n");
    for (const r of results) {
      console.log(`${r.name}`);
      console.log(`  portal      http://${r.slug}.${host}`);
      console.log(`  plan        ${r.plan} (comped — no Stripe charge)`);
      console.log(`  vertical    ${r.muslim ? "Muslim charity — Islamic giving pages on" : "General charity"}`);
      console.log(`  admin       ${r.adminEmail} / ${ADMIN_PASSWORD}`);
      console.log(`  org         ${r.orgId}`);
      console.log(`  lead        ${r.leadId}\n`);
    }
    console.log("Next:  npm run brand:demo-charities   → marks, colours, favicon");
    console.log("       npm run seed:demo-content      → programmes, events, donations, volunteers");
  } else {
    console.log("Nothing to do — every selected charity already exists.");
  }

  await mongoose.disconnect();
}

run().catch(async (e) => {
  console.error("\nFAILED:", e.publicMessage || e.message);
  console.error(e.stack);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
