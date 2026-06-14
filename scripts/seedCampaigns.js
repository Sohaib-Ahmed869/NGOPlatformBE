/**
 * Seed sample newsletter campaigns for a tenant so the Campaigns tab has
 * realistic data (draft, scheduled, sent via SMTP, sent via Mailchimp, failed).
 *
 * Idempotent: upserted by (organisationId, subject), so re-running updates them
 * in place rather than creating duplicates. No documents are deleted.
 *
 * Run:  npm run seed:campaigns                       (defaults to org slug "calcite")
 *       SEED_ORG_SLUG=yourslug npm run seed:campaigns
 */

require("dotenv").config();
const mongoose = require("mongoose");
const NewsletterCampaign = require("../models/newsletterCampaign");
const Organisation = require("../models/organisation");

const MONGODB_URI = process.env.MONGODB_URI;
const ORG_SLUG = process.env.SEED_ORG_SLUG || "calcite";

const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(10, 0, 0, 0);
  return d;
};

const body = (intro, points) => `
  <h2>${intro.title}</h2>
  <p>${intro.lead}</p>
  <ul>${points.map((p) => `<li>${p}</li>`).join("")}</ul>
  <p>With gratitude,<br/>The team</p>
`;

function buildSamples(orgId, createdBy) {
  const base = { organisationId: orgId, createdBy, audience: { type: "all_active", days: 30, source: "" } };
  return [
    // 1. Sent via SMTP
    {
      ...base,
      subject: "Welcome to the family 🎉",
      body: body(
        { title: "Welcome aboard!", lead: "Thank you for subscribing — here's what you can expect from us." },
        ["Monthly impact updates", "Early invites to events", "Stories from the field"],
      ),
      status: "sent",
      provider: "smtp",
      sentAt: day(-6),
      stats: { recipients: 128, sent: 126, failed: 2 },
    },
    // 2. Sent via Mailchimp
    {
      ...base,
      subject: "Our February impact, in numbers",
      body: body(
        { title: "February at a glance", lead: "Because of you, this month we were able to do more." },
        ["1,240 meals provided", "38 new volunteers", "$14,800 raised"],
      ),
      status: "sent",
      provider: "mailchimp",
      mailchimpCampaignId: "demo-mc-0001",
      sentAt: day(-13),
      stats: { recipients: 131, sent: 131, failed: 0 },
    },
    // 3. Scheduled
    {
      ...base,
      subject: "Ramadan appeal — the final 10 days",
      body: body(
        { title: "The final stretch", lead: "There's still time to make your Ramadan giving count." },
        ["Sponsor a family iftar", "Fund a water well", "Give a one-off gift"],
      ),
      // Far-future date on purpose: the scheduler auto-sends "scheduled"
      // campaigns when due, so a demo one shouldn't fire on real subscribers.
      status: "scheduled",
      scheduledAt: day(365),
    },
    // 4. Draft (recent-subscribers audience)
    {
      ...base,
      subject: "Volunteer drive: we need 20 hands",
      audience: { type: "recent", days: 30, source: "" },
      body: body(
        { title: "Can you spare a Saturday?", lead: "We're looking for volunteers for our community kitchen this month." },
        ["No experience needed", "Lunch provided", "Bring a friend"],
      ),
      status: "draft",
    },
    // 5. Failed (shows the error surfacing)
    {
      ...base,
      subject: "Year-end thank you",
      body: body(
        { title: "Thank you for an incredible year", lead: "A note of gratitude as the year draws to a close." },
        ["Your generosity changed lives", "Here's to the year ahead"],
      ),
      status: "failed",
      provider: "mailchimp",
      error: "From email is not verified in this Mailchimp account.",
      stats: { recipients: 0, sent: 0, failed: 0 },
    },
  ];
}

async function run() {
  if (!MONGODB_URI) {
    console.error("ERROR: MONGODB_URI not set in .env");
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log("✓ Connected to MongoDB\n");

  let org = await Organisation.findOne({ slug: ORG_SLUG }).select("_id name slug adminUserId").lean();
  if (!org) {
    org = await Organisation.findOne({}).select("_id name slug adminUserId").lean();
    if (!org) {
      console.error("ERROR: No organisations found to seed campaigns for.");
      await mongoose.disconnect();
      process.exit(1);
    }
    console.warn(`Org slug "${ORG_SLUG}" not found — using "${org.slug || org.name}" instead.\n`);
  }
  console.log(`Seeding sample campaigns for: ${org.slug || org.name} (${org._id})\n`);

  const samples = buildSamples(org._id, org.adminUserId || null);
  for (const c of samples) {
    await NewsletterCampaign.findOneAndUpdate(
      { organisationId: org._id, subject: c.subject },
      { $set: c },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    const when =
      c.status === "scheduled" ? `→ ${c.scheduledAt.toISOString().slice(0, 10)}` : c.status === "sent" ? `· ${c.stats.sent}/${c.stats.recipients}` : "";
    console.log(`  ✓ ${c.status.padEnd(9)} ${(c.provider || "—").padEnd(9)} ${c.subject} ${when}`);
  }

  console.log(`\n✅ Done. ${samples.length} sample campaigns upserted.`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (e) => {
  console.error("\n❌ Campaign seeding failed:", e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
