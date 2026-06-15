/**
 * Seed sample supporter fundraisers (GoFundMe-style P2P campaigns) for a tenant,
 * so the public "Fundraisers" page (/p2p-campaigns) and the admin moderation
 * screen have realistic data across statuses (approved/live, fully-funded
 * completed, and a pending one awaiting review).
 *
 * Idempotent: upserted by (organisationId, slug), so re-running updates them in
 * place rather than creating duplicates. No documents are deleted.
 *
 * Requires an existing organisation + at least one user (used as the campaign
 * creator). Resolves the org's adminUserId, else any user in the org.
 *
 * Run:  npm run seed:fundraisers                     (defaults to org slug "calcite")
 *       SEED_ORG_SLUG=yourslug npm run seed:fundraisers
 */

require("dotenv").config();
const mongoose = require("mongoose");
const GoFundMe = require("../models/goFundMe");
const Organisation = require("../models/organisation");
const User = require("../models/user");

const MONGODB_URI = process.env.MONGODB_URI;
const ORG_SLUG = process.env.SEED_ORG_SLUG || "calcite";

const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function buildSamples(orgId, userId) {
  const raw = [
    {
      title: "Help Ayaan Walk Again",
      category: "Medical",
      urgencyLevel: "high",
      targetAmount: 20000,
      currentAmount: 12450,
      image: "https://images.unsplash.com/photo-1631815588090-d4bfec5b1ccb?w=1200&q=80",
      description:
        "Six-year-old Ayaan needs specialist surgery and months of physiotherapy to walk again after a road accident. Every contribution brings him one step closer.",
      personalStory:
        "Ayaan was the most energetic boy in his class until a car accident last winter left him unable to walk. His parents have spent their savings on the first round of treatment, but the surgery that could restore his mobility is still out of reach. With your help, Ayaan can run and play with his friends again.",
      financialSituation:
        "Ayaan's father is a daily-wage labourer and his mother cares for three children at home. They have already borrowed from relatives to cover the emergency hospital stay and have no way to fund the surgery on their own.",
      reasonForFunding:
        "Funds cover the corrective surgery, the hospital stay and six months of physiotherapy. Any surplus goes toward his mobility aids and follow-up care.",
      approvedAt: day(-2),
      donationCount: 87,
      status: "approved",
    },
    {
      title: "Send 30 Orphans Back to School",
      category: "Education",
      urgencyLevel: "medium",
      targetAmount: 15000,
      currentAmount: 9200,
      image: "https://images.unsplash.com/photo-1503454537195-1dcabb73ffb9?w=1200&q=80",
      description:
        "Help us put 30 orphaned children back in the classroom with uniforms, books and a full year of school fees.",
      personalStory:
        "When a child loses their parents, school is often the first thing they lose too. We work with a local shelter caring for 30 bright children who dream of becoming doctors, teachers and engineers — they just need the chance to learn.",
      financialSituation:
        "The shelter runs entirely on donations and cannot stretch to school fees, uniforms and supplies on top of food and housing. Without sponsorship these children will miss another school year.",
      reasonForFunding:
        "Each $500 sponsors one child for a full year: fees, two uniforms, shoes, a school bag and all books and stationery.",
      approvedAt: day(-5),
      donationCount: 64,
      status: "approved",
    },
    {
      title: "Flood Relief for Families in Sindh",
      category: "Emergency",
      urgencyLevel: "critical",
      targetAmount: 30000,
      currentAmount: 25600,
      image: "https://images.unsplash.com/photo-1547683905-f686c993aae5?w=1200&q=80",
      description:
        "Catastrophic floods have displaced thousands of families. We're delivering emergency food, clean water and shelter — urgently.",
      personalStory:
        "Whole villages are under water. Families who had little to begin with have lost everything — their homes, their crops and their livelihoods. Our teams are already on the ground, but the need is far greater than our current supplies.",
      financialSituation:
        "These are subsistence farming families with no savings and no insurance. They depend entirely on emergency relief until the water recedes and they can rebuild.",
      reasonForFunding:
        "Funds buy ration packs, clean drinking water, tarpaulin shelters and hygiene kits, delivered directly by our field teams over the next eight weeks.",
      approvedAt: day(-1),
      donationCount: 173,
      status: "approved",
    },
    {
      title: "Rebuild Our Community Kitchen",
      category: "Community",
      urgencyLevel: "low",
      targetAmount: 12000,
      currentAmount: 3850,
      image: "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?w=1200&q=80",
      description:
        "Our community kitchen serves 200 hot meals a day — but the old equipment has finally given out. Help us rebuild it.",
      personalStory:
        "For ten years our little kitchen has fed anyone who walks through the door: elderly neighbours, students, workers between jobs. Last month the cooker and refrigeration failed, and we've been struggling to keep going with borrowed gear.",
      financialSituation:
        "The kitchen is run by volunteers and funded by small local donations. There is no budget for a full refit of commercial kitchen equipment.",
      reasonForFunding:
        "Funds replace the commercial cooker, refrigeration and prep stations so we can safely serve hot meals every day for years to come.",
      approvedAt: day(-9),
      donationCount: 27,
      status: "approved",
    },
    {
      title: "Clean Water Wells in Memory of Br. Yusuf",
      category: "Other",
      customCategory: "Memorial",
      urgencyLevel: "medium",
      targetAmount: 18000,
      currentAmount: 8100,
      image: "https://images.unsplash.com/photo-1541252260730-0412e8e2108e?w=1200&q=80",
      description:
        "In loving memory of Brother Yusuf, we're funding clean-water wells for villages that walk hours each day for water.",
      personalStory:
        "Yusuf spent his life quietly helping others. To honour his memory, his family and friends want to give a gift that keeps giving — clean water for communities that have none. Each well serves hundreds of people for decades.",
      financialSituation:
        "The villages we're targeting have no access to safe water and no means to fund infrastructure. Children miss school to fetch water and waterborne illness is common.",
      reasonForFunding:
        "Each $3,000 funds one deep well with a hand pump, serving an entire village. Plaques will note that the wells are given in Yusuf's memory.",
      approvedAt: day(-7),
      donationCount: 41,
      status: "approved",
    },
    {
      title: "Winter Blankets Drive 2025",
      category: "Emergency",
      urgencyLevel: "medium",
      targetAmount: 10000,
      currentAmount: 10000,
      image: "https://images.unsplash.com/photo-1515125520141-3e3b67bc0a88?w=1200&q=80",
      description:
        "Thanks to an incredible response, we fully funded warm blankets and winter kits for families through the coldest months. ",
      personalStory:
        "When temperatures dropped, hundreds of families had no way to stay warm. Our community rallied and we distributed blankets, jackets and heaters across three districts. Thank you to everyone who gave.",
      financialSituation:
        "The recipients were low-income and displaced families with no heating and no spare income for winter essentials.",
      reasonForFunding:
        "Funds purchased and distributed 500 blanket-and-winter-kit bundles. This campaign is now complete — thank you!",
      approvedAt: day(-30),
      completedAt: day(-4),
      donationCount: 96,
      status: "completed",
    },
    {
      title: "Support a Young Apprentice's Tools",
      category: "Education",
      urgencyLevel: "low",
      targetAmount: 4000,
      currentAmount: 0,
      image: "https://images.unsplash.com/photo-1530124566582-a618bc2615dc?w=1200&q=80",
      description:
        "A motivated young apprentice has a job offer but can't afford the tools to start. A small boost changes everything.",
      personalStory:
        "After finishing a trade course top of his class, Bilal landed an apprenticeship — but the role requires him to bring his own toolkit, which costs more than his family earns in two months. He's ready to work; he just needs the tools.",
      financialSituation:
        "Bilal is the eldest of five and his family relies on his father's irregular income. They cannot afford the upfront cost of a professional toolkit.",
      reasonForFunding:
        "Funds buy a complete starter toolkit and safety gear so Bilal can begin his apprenticeship and support his family.",
      donationCount: 0,
      status: "pending", // awaiting admin review — appears in the moderation queue, not public
    },
  ];

  return raw.map((c) => ({
    organisationId: orgId,
    userId,
    isActive: true,
    slug: slugify(c.title),
    imagePath: `seed/fundraisers/${slugify(c.title)}.jpg`, // dummy S3 key (image is an external URL)
    ...c,
  }));
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
      console.error("ERROR: No organisations found to seed fundraisers for.");
      await mongoose.disconnect();
      process.exit(1);
    }
    console.warn(`Org slug "${ORG_SLUG}" not found — using "${org.slug || org.name}" instead.\n`);
  }

  // A fundraiser must have a creator (userId is required).
  let creatorId = org.adminUserId;
  if (!creatorId) {
    const u = await User.findOne({ organisationId: org._id }).select("_id").lean();
    creatorId = u?._id;
  }
  if (!creatorId) {
    console.error(
      `ERROR: No user found for org "${org.slug || org.name}" to set as the fundraiser creator. Seed a user first.`,
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`Seeding sample fundraisers for: ${org.slug || org.name} (${org._id})`);
  console.log(`Creator (userId): ${creatorId}\n`);

  const samples = buildSamples(org._id, creatorId);
  for (const c of samples) {
    await GoFundMe.findOneAndUpdate(
      { organisationId: org._id, slug: c.slug },
      { $set: c },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    const pct = c.targetAmount ? Math.round((c.currentAmount / c.targetAmount) * 100) : 0;
    console.log(`  ✓ ${c.status.padEnd(9)} ${String(pct + "%").padStart(4)}  ${c.title}`);
  }

  const live = samples.filter((c) => c.status === "approved").length;
  console.log(
    `\n✅ Done. ${samples.length} fundraisers upserted (${live} live/approved). View them at /p2p-campaigns.`,
  );
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (e) => {
  console.error("\n❌ Fundraiser seeding failed:", e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
