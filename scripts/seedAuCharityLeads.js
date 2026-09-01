/**
 * Stage two real Australian charities as Leads, then convert each one into a
 * live Organisation through the normal operator path.
 *
 *   Lead (source: superadmin_manual, stage: new)
 *     → leadConversion.manualProvision()
 *       → Organisation (active, comped) + admin User + seeded pages/donation types
 *       → Lead flips to "won" with convertedOrgId + stageHistory
 *
 * Organisation data is real and verified: the legal entity names and ABNs come
 * from the Australian Business Register, the contact details from each
 * charity's own public contact page. Both hold DGR Item 1 endorsement.
 *
 * ── The admin email is deliberately OURS, not the charity's ──────────────────
 * manualProvision sends a real "your portal is ready, set your password" email
 * to the admin address, and SMTP is live. info@ozharvest.org and
 * info@humanappeal.org.au are monitored inboxes at organisations that have not
 * asked for a portal, so the admin account is held by the operator until each
 * charity nominates someone. The charity's genuine public contact details still
 * go on the Organisation (that is what the donor-facing site shows) — only the
 * login is ours. At handover, change the admin user's email and re-issue.
 *
 * Re-runnable: an existing lead/org for either slug is reported and skipped.
 *
 * Run:  node scripts/seedAuCharityLeads.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const crypto = require("crypto");

const Lead = require("../models/lead");
const User = require("../models/user");
const Organisation = require("../models/organisation");
const { manualProvision } = require("../services/leadConversion");

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("ERROR: No MONGODB_URI in .env");
  process.exit(1);
}

// Where the set-password / welcome email goes while the operator holds the
// account. Override with OPERATOR_EMAIL if plus-addressing isn't supported.
const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL || "ayna.sulaiman@calcite.live";
const OPERATOR_NAME = process.env.OPERATOR_NAME || "Ayna Sulaiman";
const adminEmailFor = (tag) => {
  const [local, domain] = OPERATOR_EMAIL.split("@");
  return `${local}+${tag}@${domain}`;
};

/* ── The two charities ─────────────────────────────────────────────────────
   `verified` is real public-register data. `estimated` is the one qualification
   field that is a judgement call — both are ACNC "Large" charities, so the
   top budget band is the safe read, but confirm it against each charity's
   reported revenue on the ACNC register before it drives a plan/price. */
const CHARITIES = [
  {
    tag: "ozharvest",
    slug: "ozharvest",
    lead: {
      orgName: "Oz Harvest Limited",              // ABR legal entity name
      orgWebsite: "https://www.ozharvest.org",
      verticalType: "general",
      causeAreas: ["poverty", "environment"],
      country: "Australia",
      contactPhone: "1800 108 006",
      contactRole: "TBC — awaiting nominated contact",
      annualBudgetRange: "5m_plus",               // estimated, see note above
      interestedPlan: "enterprise",
      interestedBillingCycle: "annual",
      timeline: "this_quarter",
      decisionRole: "decision_maker",
      message:
        "Operator-created prospect. Food rescue charity, national footprint. "
        + "ABN 33 107 782 196 (ABR-verified). DGR Item 1 endorsed 17 May 2004, "
        + "ACNC registered 3 Dec 2012.",
    },
    convert: { plan: "enterprise", billingCycle: "annual", revenueRange: "5000000+", theme: "warm-amber", isMuslimCharity: false },
    // Real public contact points — these are what the donor-facing site shows.
    publicContact: {
      contactEmail: "info@ozharvest.org",
      contactPhone: "1800 108 006",
      address: "Warehouse G3/G4, 46-62 Maddox St, Alexandria NSW 2015, Australia",
      addressDetails: { street: "Warehouse G3/G4, 46-62 Maddox St", city: "Alexandria", state: "NSW", postalCode: "2015", country: "Australia" },
      website: "https://www.ozharvest.org",
    },
    abn: "33 107 782 196",
  },
  {
    tag: "humanappeal",
    slug: "humanappeal",
    lead: {
      orgName: "Human Appeal International Australia", // ABR legal entity name
      orgWebsite: "https://www.humanappeal.org.au",
      verticalType: "muslim",
      causeAreas: ["zakat", "disaster_relief", "poverty", "children"],
      country: "Australia",
      contactPhone: "1300 760 155",
      contactRole: "TBC — awaiting nominated contact",
      annualBudgetRange: "5m_plus",               // estimated, see note above
      interestedPlan: "professional",
      interestedBillingCycle: "annual",
      timeline: "this_quarter",
      decisionRole: "decision_maker",
      message:
        "Operator-created prospect. Islamic relief charity, 46+ countries. "
        + "ABN 26 164 251 245 (ABR-verified). DGR Item 1 + Public Benevolent "
        + "Institution, endorsed 13 Jun 2013. NOTE: several sibling ACNC entities "
        + "exist under the Human Appeal umbrella — confirm which one the portal is for.",
    },
    convert: { plan: "professional", billingCycle: "annual", revenueRange: "5000000+", theme: "pro-teal", isMuslimCharity: true },
    publicContact: {
      contactEmail: "info@humanappeal.org.au",
      contactPhone: "1300 760 155",
      address: "119 Haldon St, Lakemba NSW 2195, Australia",
      addressDetails: { street: "119 Haldon St", city: "Lakemba", state: "NSW", postalCode: "2195", country: "Australia" },
      website: "https://www.humanappeal.org.au",
    },
    abn: "26 164 251 245",
  },
];

/** A fresh set-password link, so access does not depend on the email landing. */
async function mintSetPasswordLink(adminUser) {
  const raw = crypto.randomBytes(32).toString("hex");
  adminUser.resetPasswordToken = crypto.createHash("sha256").update(raw).digest("hex");
  adminUser.resetPasswordExpires = Date.now() + 7 * 24 * 3600 * 1000;
  await adminUser.save();
  const base = process.env.CLIENT_URL || "http://localhost:5173";
  return `${base.replace(/\/$/, "")}/reset-password/${raw}`;
}

async function run() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log(`Connected to ${mongoose.connection.name}\n`);

  const results = [];

  for (const c of CHARITIES) {
    const adminEmail = adminEmailFor(c.tag);
    console.log(`── ${c.lead.orgName} ${"─".repeat(Math.max(0, 52 - c.lead.orgName.length))}`);

    if (await Organisation.exists({ slug: c.slug })) {
      console.log(`   SKIP — an organisation with slug "${c.slug}" already exists.\n`);
      continue;
    }
    if (await User.exists({ email: adminEmail })) {
      console.log(`   SKIP — a user already exists for ${adminEmail}.\n`);
      continue;
    }

    // ── 1. The lead ──────────────────────────────────────────────────────
    const lead = await Lead.create({
      ...c.lead,
      contactName: OPERATOR_NAME,
      contactEmail: adminEmail,
      source: "superadmin_manual",
      stage: "new",
      consentToContact: true,
      consentAt: new Date(),
    });
    console.log(`   Lead created      ${lead._id}  (stage: ${lead.stage}, source: ${lead.source})`);

    // ── 2. Convert it ────────────────────────────────────────────────────
    // A stub req: clientBaseUrl() reads CLIENT_URL first, and req.user is only
    // used for the stageHistory attribution, which is nobody here.
    const req = { user: null };
    const { organisation, adminUser, emailStatus } = await manualProvision(
      lead,
      { ...c.convert, slug: c.slug, adminName: OPERATOR_NAME, adminEmail,
        compReason: "Staged onboarding — operator-provisioned pending charity handover" },
      req,
    );
    const after = await Lead.findById(lead._id).lean();
    console.log(`   Converted         ${organisation._id}  (stage: ${after.stage}, mode: ${after.conversionMode})`);
    console.log(`   Welcome email     ${emailStatus} → ${adminEmail}`);

    // ── 3. Put the charity's REAL public contact details on the org ──────
    // manualProvision seeds contactEmail from the admin login; the donor-facing
    // site should show the charity's own published details instead.
    Object.assign(organisation, c.publicContact);
    await organisation.save();

    const link = await mintSetPasswordLink(adminUser);
    results.push({ name: organisation.name, slug: organisation.slug, orgId: String(organisation._id),
                   leadId: String(lead._id), adminEmail, abn: c.abn, link,
                   plan: organisation.plan, billing: organisation.billingCycle,
                   muslim: organisation.isMuslimCharity, comp: organisation.isComp });
    console.log(`   Public contact    ${c.publicContact.contactEmail} · ${c.publicContact.contactPhone}`);
    console.log(`   Set password      ${link}\n`);
  }

  if (results.length) {
    console.log("═".repeat(74));
    console.log("DONE — both leads converted. Set-password links are valid for 7 days.\n");
    for (const r of results) {
      console.log(`${r.name}`);
      console.log(`  portal      ${r.slug}.<root domain>`);
      console.log(`  plan        ${r.plan} / ${r.billing}${r.comp ? " (comped — no Stripe charge)" : ""}`);
      console.log(`  vertical    ${r.muslim ? "Muslim charity — Islamic giving pages on" : "General charity"}`);
      console.log(`  ABN         ${r.abn}   ⚠ not stored: Organisation has no abn field`);
      console.log(`  admin login ${r.adminEmail}`);
      console.log(`  lead        ${r.leadId}`);
      console.log(`  org         ${r.orgId}\n`);
    }
    console.log("⚠ Receipts still print the hardcoded ABN in services/recieptUtils.js:81.");
    console.log("  Both charities are DGR Item 1, so fix that before either takes a live donation.");
  } else {
    console.log("Nothing to do — both already exist.");
  }

  await mongoose.disconnect();
}

run().catch(async (e) => {
  console.error("\nFAILED:", e.publicMessage || e.message);
  console.error(e.stack);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
