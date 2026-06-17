/**
 * Backfill the section-based pages (About, Our Team, Our Partners) to the
 * section/block builder.
 *
 * These pages became section-based (config/pageTemplates.js → sectionBased,
 * config/sectionTypes.js). New tenants get `content.sections` from the template
 * defaults on seed. This converts tenants seeded earlier — preserving any
 * content they had customised via the old fixed editors (hero copy, partner
 * stats/why/ways/logos/cta, etc.) by overlaying it onto the default sections.
 *
 * Conservative + idempotent: only touches pages without a non-empty
 * `content.sections`; never deletes the legacy keys.
 *
 * Run:  npm run backfill:sections
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Page = require("../models/page");
const {
  defaultHomeSections,
  defaultAboutSections,
  defaultTeamSections,
  defaultPartnersSections,
  defaultInitiativesSections,
  defaultGetInvolvedSections,
  defaultGivingSections,
  getSectionDefaults,
} = require("../config/sectionTypes");

const MONGODB_URI = process.env.MONGODB_URI;

const setIf = (obj, key, val) => { if (val !== undefined && val !== null) obj[key] = val; };

/* ── About: legacy { hero, cards } → hero / cardGrid / ctaBand ───────── */
function aboutToSections(content) {
  const hero = content?.hero || {};
  const cards = Array.isArray(content?.cards) ? content.cards : [];
  if (!hero.title && !hero.subtitle && !hero.image && !cards.length) return defaultAboutSections();
  const heroDefaults = getSectionDefaults("hero");
  const sections = [
    {
      id: "about-hero",
      type: "hero",
      archived: false,
      data: {
        ...heroDefaults,
        eyebrow: hero.eyebrow ?? heroDefaults.eyebrow,
        title: hero.title ?? heroDefaults.title,
        subtitle: hero.subtitle ?? heroDefaults.subtitle,
        image: hero.image ?? heroDefaults.image,
      },
    },
  ];
  if (cards.length) {
    sections.push({
      id: "about-cards",
      type: "cardGrid",
      archived: false,
      data: {
        ...getSectionDefaults("cardGrid"),
        items: cards.map((c) => ({ image: c.image, title: c.title, description: c.description, link: c.link })),
      },
    });
  }
  sections.push({ id: "about-cta", type: "ctaBand", archived: false, data: getSectionDefaults("ctaBand") });
  return sections;
}

/* ── Team: only the hero was ever editable → overlay it onto defaults ── */
function teamToSections(content) {
  const base = defaultTeamSections();
  const hero = content?.hero || {};
  setIf(base[0].data, "eyebrow", hero.label);
  setIf(base[0].data, "title", hero.title);
  setIf(base[0].data, "subtitle", hero.subtitle);
  setIf(base[0].data, "image", hero.image);
  return base;
}

/* ── Partners: overlay saved stats/why/ways/logos/cta onto defaults ──── */
function partnersToSections(content) {
  const c = content || {};
  const base = defaultPartnersSections(); // [hero, stats, why, logos, ways, cta]
  const hero = c.hero || {};
  setIf(base[0].data, "eyebrow", hero.eyebrow);
  setIf(base[0].data, "title", hero.title);
  setIf(base[0].data, "subtitle", hero.subtitle);
  setIf(base[0].data, "image", hero.image);
  if (Array.isArray(c.stats) && c.stats.length) base[1].data.items = c.stats.map((s) => ({ value: s.value, label: s.label }));
  setIf(base[2].data, "eyebrow", c.whyEyebrow);
  setIf(base[2].data, "heading", c.whyHeading);
  setIf(base[2].data, "intro", c.whyIntro);
  if (Array.isArray(c.why) && c.why.length) base[2].data.items = c.why.map((w) => ({ icon: w.icon, title: w.title, text: w.text, link: "" }));
  setIf(base[3].data, "eyebrow", c.introLabel);
  setIf(base[3].data, "heading", c.introHeading);
  if (Array.isArray(c.partners) && c.partners.length) base[3].data.items = c.partners.map((p) => ({ logo: p.logo, name: p.name }));
  setIf(base[4].data, "eyebrow", c.waysEyebrow);
  setIf(base[4].data, "heading", c.waysHeading);
  setIf(base[4].data, "intro", c.waysIntro);
  if (Array.isArray(c.ways) && c.ways.length)
    base[4].data.items = c.ways.map((w) => ({ icon: w.icon, title: w.title, text: w.text, link: `/become-a-partner?type=${w.type || "other"}` }));
  setIf(base[5].data, "title", c.cta?.title);
  setIf(base[5].data, "text", c.cta?.text);
  return base;
}

/* ── Hubs: overlay saved hero + cards/forms onto the default sections ── */
function initiativesToSections(content) {
  const base = defaultInitiativesSections();
  const hero = content?.hero || {};
  setIf(base[0].data, "eyebrow", hero.eyebrow);
  setIf(base[0].data, "title", hero.title);
  setIf(base[0].data, "subtitle", hero.subtitle);
  setIf(base[0].data, "image", hero.image);
  if (Array.isArray(content?.cards) && content.cards.length)
    base[1].data.items = content.cards.map((c) => ({ image: c.icon || c.image, title: c.title, description: c.description, link: c.link }));
  return base;
}

function getInvolvedToSections(content) {
  const base = defaultGetInvolvedSections();
  const hero = content?.hero || {};
  setIf(base[0].data, "eyebrow", hero.eyebrow);
  setIf(base[0].data, "title", hero.title);
  setIf(base[0].data, "subtitle", hero.subtitle);
  setIf(base[0].data, "image", hero.image);
  if (Array.isArray(content?.cards) && content.cards.length)
    base[1].data.items = content.cards.map((c) => ({ image: c.icon || c.image, title: c.title, description: c.description, link: c.link }));
  setIf(base[2].data, "title", content?.cta?.title);
  setIf(base[2].data, "text", content?.cta?.text);
  return base;
}

function givingToSections(content) {
  const base = defaultGivingSections();
  const hero = content?.hero || {};
  setIf(base[0].data, "eyebrow", hero.eyebrow);
  setIf(base[0].data, "title", hero.title);
  setIf(base[0].data, "subtitle", hero.subtitle);
  setIf(base[0].data, "image", hero.image);
  if (Array.isArray(content?.forms) && content.forms.length)
    base[1].data.items = content.forms.map((f) => ({ icon: f.icon, title: f.title, text: f.text, link: "" }));
  return base;
}

/* ── Home: overlay saved hero + stats onto the default home sections ── */
function homeToSections(content) {
  const base = defaultHomeSections();
  const hero = content?.hero || {};
  setIf(base[0].data, "eyebrow", hero.badge);
  setIf(base[0].data, "title", hero.title);
  setIf(base[0].data, "subtitle", hero.subtitle);
  setIf(base[0].data, "primaryCtaText", hero.primaryCtaText);
  setIf(base[0].data, "primaryCtaLink", hero.primaryCtaLink);
  setIf(base[0].data, "secondaryCtaText", hero.secondaryCtaText);
  setIf(base[0].data, "secondaryCtaLink", hero.secondaryCtaLink);
  if (Array.isArray(hero.stats) && hero.stats.length)
    base[1].data.items = hero.stats.map((s) => ({ value: s.value, label: s.label }));
  return base;
}

const CONVERTERS = {
  home: homeToSections,
  about: aboutToSections,
  team: teamToSections,
  partners: partnersToSections,
  initiatives: initiativesToSections,
  getInvolved: getInvolvedToSections,
  giving: givingToSections,
};

async function run() {
  if (!MONGODB_URI) {
    console.error("ERROR: MONGODB_URI not set in .env");
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log("✓ Connected to MongoDB\n");

  const keys = Object.keys(CONVERTERS);
  const docs = await Page.find({ key: { $in: keys } });
  console.log(`Found ${docs.length} section-based page(s) across ${keys.join(", ")}.\n`);

  let updated = 0;
  let skipped = 0;
  for (const d of docs) {
    const c = d.content || {};
    if (Array.isArray(c.sections) && c.sections.length) {
      skipped++;
      continue;
    }
    d.content = { ...c, sections: CONVERTERS[d.key](c) };
    d.markModified("content");
    await d.save();
    updated++;
    console.log(`  ✓ ${d.key} · ${d.organisationId} — ${d.content.sections.length} sections`);
  }

  console.log(`\n✅ Backfill complete — ${updated} converted, ${skipped} already section-based.`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (e) => {
  console.error("\n❌ Backfill failed:", e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
