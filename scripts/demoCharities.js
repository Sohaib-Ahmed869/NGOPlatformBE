/**
 * scripts/demoCharities.js — THE TWO INVENTED CHARITIES
 *
 * Bellhaven Foundation (general) and Harbourlight Foundation (Islamic giving)
 * are FICTIONAL. Nothing in this file describes a real organisation, and that
 * is the whole point of it: the platform's other two Australian tenants
 * (ozharvest, humanappeal) are real charities carrying their real ABNs, real
 * addresses, real monitored inboxes and logos hot-linked off their live sites,
 * which makes them unsafe to demo, screenshot or hand to a prospect. These two
 * are safe to show anyone.
 *
 * Everything here was chosen to be checkably not-real:
 *   names      Checked against the ACNC register + the ABR before use. Close
 *              matches were rejected: "Wattleseed" (Wattle Foundation Ltd
 *              exists) and "Corella" (The Corella Fund exists) both went.
 *              Re-check before renaming either charity.
 *   phones     ACMA's drama/fiction blocks — 0491 570 006-0491 570 156 for
 *              mobiles, xx 5550 xxxx for landlines. These can never be
 *              allocated to a real subscriber, so a demo that dials out or a
 *              screenshot that leaks cannot reach anybody.
 *   emails     @bellhaven.org.au / @harbourlight.org.au — unregistered
 *              domains. The relay accepts mail to them and the delivery
 *              bounces, so the welcome email manualProvision sends reaches
 *              nobody; the seed script prints a set-password link instead.
 *   donors,    example.com throughout (RFC 2606 reserved).
 *   volunteers
 *   ABN        Deliberately absent. Organisation has no abn field anyway, and
 *              receipts print a hardcoded one (services/recieptUtils.js:81),
 *              so inventing an ABN here would only put a plausible-looking
 *              fake number on a PDF. If either tenant ever needs one, use the
 *              ATO's documentation ABN, not a made-up sequence.
 *   addresses  Real suburb and postcode (so state/postcode validation and
 *              the map link behave), invented street.
 *
 * Consumed by:
 *   seedDemoCharities.js       provisions both tenants through the operator path
 *   setDemoCharityBranding.js  uploads their marks and writes the branding block
 *   seedDemoCharityContent.js  fills each portal with content
 *
 * All content below is deterministic — no Math.random — so a re-run produces
 * the same portal rather than a different one.
 */

// ── Dates are relative to the run so the demo never goes stale ──────────────
const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
const daysAhead = (n) => new Date(Date.now() + n * DAY);

/**
 * Product.image is required and every other tenant's seeded products carry a
 * data: URI rather than an S3 object, so a re-seed never leaves dead links in
 * the bucket. Flat disc, initials, tenant hue — no gradient (see the house
 * rule against the AI-generated look).
 */
const initialsImage = (title, hue) => {
  const initials = title
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">` +
    `<rect width="96" height="96" rx="48" fill="hsl(${hue} 38% 38%)"/>` +
    `<text x="48" y="61" text-anchor="middle" fill="#fff" font-size="34" ` +
    `font-family="Outfit,Segoe UI,system-ui,sans-serif" font-weight="600" ` +
    `letter-spacing="1">${initials}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
};

/**
 * A partner's "logo". The public partner wall only renders an entry that HAS
 * one (LogosStrip drops logo-less items, and the admin toggle refuses to
 * publish without one), so seeded partners need something real to show. These
 * are invented companies, so a wordmark drawn from the name is the honest
 * option — no scraped brand assets, nothing to go stale, and it stays inside
 * the tenant's own hue.
 */
const logoImage = (name, hue) => {
  // Two lines for the long ones — a 30-character company name at one line is
  // unreadable in a 28px-high logo box.
  const words = name.split(/\s+/);
  const mid = words.length > 2 ? Math.ceil(words.length / 2) : words.length;
  const lines = [words.slice(0, mid).join(" "), words.slice(mid).join(" ")].filter(Boolean);
  const size = Math.min(30, Math.floor(700 / Math.max(...lines.map((l) => l.length))));
  const rows = lines
    .map((l, i) => `<text x="160" y="${lines.length === 1 ? 58 : 44 + i * 30}" text-anchor="middle" ` +
      `fill="hsl(${hue} 32% 30%)" font-size="${size}" font-family="Outfit,Segoe UI,system-ui,sans-serif" ` +
      `font-weight="600" letter-spacing="-0.5">${l.replace(/&/g, "&amp;")}</text>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 96">${rows}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
};

const products = (list, hue) =>
  list.map((p) => ({
    ...p,
    slug: p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    image: initialsImage(p.title, hue),
    isActive: true,
  }));

/* ── BELLHAVEN FOUNDATION ──────────────────────────────────────────────────
   A suburban Melbourne charity working on housing stress and food relief.
   Deliberately domestic and unglamorous: it exercises the general (non-Islamic)
   vertical, and its programme mix is the kind most Australian tenants have. */
const bellhaven = {
  tag: "bellhaven",
  slug: "bellhaven",
  displayName: "Bellhaven Foundation",

  lead: {
    orgName: "Bellhaven Foundation Ltd",
    orgWebsite: "https://www.bellhaven.org.au",
    verticalType: "general",
    // Values, not labels — these have to match src/config/leadOptions.js or the
    // lead's chips render as raw keys on the SuperAdmin Leads screen.
    causeAreas: ["poverty", "children", "education"],
    country: "Australia",
    contactPhone: "(03) 5550 0142",
    contactRole: "Operations",
    staffSize: "6-20",
    annualBudgetRange: "250k_1m",
    donorDatabaseSize: "2500_10000",
    currentTools: ["spreadsheets", "little_green_light"],
    challenges: ["donor_management", "recurring", "volunteers", "reporting"],
    interestedPlan: "professional",
    interestedBillingCycle: "annual",
    timeline: "this_quarter",
    decisionRole: "decision_maker",
    message:
      "DEMO TENANT — Bellhaven Foundation is not a real organisation. Invented "
      + "for demos, screenshots and training so neither of the platform's real "
      + "Australian charities has to stand in. Housing stress and food relief, "
      + "inner-north Melbourne.",
  },

  convert: {
    plan: "professional",
    billingCycle: "annual",
    revenueRange: "500-5000000",
    theme: "warm-terracotta",
    isMuslimCharity: false,
    compReason: "Demo tenant — invented charity, never billed",
  },

  admin: { name: "Elise Marchetti", email: "admin@bellhaven.org.au" },

  publicContact: {
    contactEmail: "hello@bellhaven.org.au",
    contactPhone: "(03) 5550 0142",
    address: "Level 1, 88 Kestrel Street, Fitzroy North VIC 3068, Australia",
    addressDetails: {
      line1: "Level 1, 88 Kestrel Street",
      city: "Fitzroy North",
      state: "VIC",
      postalCode: "3068",
      country: "Australia",
    },
    website: "https://www.bellhaven.org.au",
    socialLinks: {
      facebook: "https://www.facebook.com/bellhavenfoundation",
      instagram: "https://www.instagram.com/bellhavenfoundation",
      linkedin: "https://www.linkedin.com/company/bellhaven-foundation",
    },
  },

  /* Colours are the warm-terracotta preset verbatim, so the tenant matches
     what an operator would get by picking that theme in the console. The
     accent clears the 3.0 white-contrast floor in utils/contrast.js at 4.16:1,
     so button labels stay white and no --tenant-accent-contrast swap kicks in. */
  brand: {
    siteTitle: "Bellhaven Foundation",
    tagline: "Practical help, close to home.",
    theme: "warm-terracotta",
    primaryColor: "#4A2C2A",
    accentColor: "#C75B39",
    backgroundColor: "#FBF0EB",
    mark: "arch", // see renderDemoCharityLogos.js
    hue: 14,
  },

  eventAudiences: [
    { key: "everyone", label: "Everyone", color: "#C75B39" },
    { key: "volunteers", label: "Volunteers", color: "#4A2C2A" },
    { key: "families", label: "Families we support", color: "#8C6D46" },
    { key: "supporters", label: "Donors & supporters", color: "#6B7F5E" },
  ],

  // Added on top of the six general defaults manualProvision seeds.
  extraDonationTypes: ["Winter Appeal", "Sponsor a Family"],

  /* A domestic charity has no overseas water programme, and leaving the seeded
     one on is the sort of detail that gives a demo away. Disabling the page
     cascades through the nav, the footer, PageGate and ⌘K search. */
  disabledPages: ["water"],

  /* The homepage the page seeder produces is deliberately generic — "Changing
     Lives, One Act of Kindness", $2.4M raised, 30+ countries. Fine as a
     starting point for a real charity that will rewrite it, useless for a demo:
     the stats contradict the seeded donations and the copy could belong to
     anyone. These override the hero, the cause cards and the closing band. */
  homepage: {
    hero: {
      badge: "Housing stress & food relief · Inner-north Melbourne",
      title: "Help a family stay in their home",
      highlight: "stay in their home",
      subtitle:
        "We work with 14 partner services across Melbourne's inner north: an emergency bed the same day it is needed, groceries every Thursday, and the bond that keeps a family housed.",
      primaryCtaText: "Donate now",
      primaryCtaLink: "/donate",
      secondaryCtaText: "See our programmes",
      secondaryCtaLink: "/programs",
      stats: [
        { value: "$1.4M", label: "Raised since 2019" },
        { value: "2,600", label: "Families helped" },
        { value: "260", label: "Households fed weekly" },
        { value: "14", label: "Partner services" },
      ],
    },
    causes: {
      eyebrow: "What we do",
      heading: "Four things, done properly",
      intro: "No overseas programmes and no glossy campaigns — everything we run is inside 12 kilometres of this office.",
      items: [
        { title: "Food relief", description: "Thursday groceries and a hot meal for 260 households.", link: "/initiative-3",
          image: "https://images.unsplash.com/photo-1593113598332-cd288d649433?w=600&q=80" },
        { title: "Emergency housing", description: "A safe bed the same day the referral arrives.", link: "/initiative-4",
          image: "https://images.unsplash.com/photo-1603321544554-f416a9a11fcb?w=600&q=80" },
        { title: "Homework Club", description: "After-school tutoring for 90 primary students.", link: "/initiative-1",
          image: "https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=600&q=80" },
      ],
    },
    cta: {
      title: "Winter is when it gets hard",
      text: "A bed for one night costs $140. Groceries for a family for a week cost $45. Both are needed most between June and August.",
      primaryCtaText: "Give to the Winter Appeal",
      primaryCtaLink: "/donate",
      secondaryCtaText: "Volunteer with us",
      secondaryCtaLink: "/get-involved",
    },
    seo: {
      title: "Bellhaven Foundation — housing and food relief in Melbourne's inner north",
      description: "Emergency beds, weekly groceries, tutoring and rent support for families in Melbourne's inner north.",
    },
  },

  content: {
    programs: [
      { title: "Winter Beds Appeal", goalAmount: 180000, raisedAmount: 96500, status: "published",
        description: "Emergency motel beds and swags through the coldest ten weeks of the year, booked the same day a referral comes in from one of our 14 partner services." },
      { title: "Kitchen Table — weekly food relief", goalAmount: 120000, raisedAmount: 88200, status: "published",
        description: "A Thursday grocery service for 260 households: fresh produce, staples and a hot meal, run out of the Fitzroy North hall with a paid coordinator and 30 volunteers." },
      { title: "First Rent Fund", goalAmount: 250000, raisedAmount: 141000, status: "published",
        description: "Bond and first-month rent for families leaving crisis accommodation. Paid straight to the agent, never to a broker, and matched with six months of tenancy support." },
      { title: "Homework Club", goalAmount: 60000, raisedAmount: 47300, status: "published",
        description: "After-school tutoring for 90 primary students in three housing estates — two afternoons a week, term time, with dinner before everyone heads home." },
      { title: "Wheels to Work", goalAmount: 45000, raisedAmount: 12800, status: "published",
        description: "Registration, repairs and a year of insurance for parents whose job depends on a car that no longer starts. Capped at $1,800 per family." },
      { title: "Op Shop Fit-out", goalAmount: 75000, raisedAmount: 75000, status: "completed",
        description: "Completed June 2026. Fitted out the Brunswick shopfront that now covers a third of our operating costs from trading income." },
    ],

    events: [
      { title: "Kitchen Table Volunteer Induction", inDays: 9, startTime: "18:00", endTime: "20:00",
        eventType: "volunteer", audience: "volunteers", registrationMode: "internal", capacity: 40,
        registrationCount: 23, requiresRegistration: true, isPaid: false, status: "upcoming",
        venue: "Bellhaven Hall", address: "88 Kestrel Street, Fitzroy North VIC 3068", city: "Melbourne",
        description: "Everything you need before your first Thursday shift: food safety, the referral system, and who to call when something goes wrong." },
      { title: "Winter Beds Appeal Dinner 2027", inDays: 46, startTime: "18:30", endTime: "22:00",
        eventType: "gala", audience: "supporters", registrationMode: "internal", capacity: 220,
        registrationCount: 137, requiresRegistration: true, isPaid: true, price: 145, status: "upcoming",
        venue: "The Timber Yard", address: "351 Plummer Street, Port Melbourne VIC 3207", city: "Melbourne",
        description: "Our one ticketed night of the year. Three courses, a short live appeal, and the tenancy team explaining exactly where last winter's money went." },
      { title: "Community BBQ — Sydney Road", inDays: 21, startTime: "11:00", endTime: "14:00",
        eventType: "community", audience: "everyone", registrationMode: "none", capacity: null,
        registrationCount: 0, requiresRegistration: false, isPaid: false, status: "upcoming",
        venue: "Brunswick Community Green", address: "Sydney Road, Brunswick VIC 3056", city: "Melbourne",
        description: "Free lunch, a jumping castle and the op shop's winter racks out on the grass. No sign-up, just turn up." },
      { title: "Referral Partners Webinar", inDays: 5, startTime: "13:00", endTime: "14:00",
        eventType: "webinar", audience: "everyone", registrationMode: "external", capacity: null,
        registrationCount: 0, requiresRegistration: false, isPaid: false, status: "upcoming",
        venue: "Online", address: "", city: "Online",
        registrationLink: "https://www.bellhaven.org.au/webinar",
        description: "Walkthrough of the new intake form for caseworkers at partner services. Recorded for anyone who can't make the hour." },
      { title: "Homework Club Term 2 Celebration", inDays: -34, startTime: "16:00", endTime: "18:00",
        eventType: "community", audience: "families", registrationMode: "internal", capacity: 120,
        registrationCount: 108, requiresRegistration: true, isPaid: false, status: "completed",
        venue: "Bellhaven Hall", address: "88 Kestrel Street, Fitzroy North VIC 3068", city: "Melbourne",
        description: "End of term certificates, a shared meal, and the tutors who turned up every week getting the thanks they are owed." },
    ],

    products: products([
      { title: "Weekly Food Hamper", price: 45, category: "food",
        description: "Fresh produce, staples and a hot meal for one household at Thursday's Kitchen Table." },
      { title: "School Starter Pack", price: 60, category: "education",
        description: "Uniform, shoes, books and a bag for one primary student starting the year." },
      { title: "Emergency Swag & Sleeping Bag", price: 85, category: "emergencies",
        description: "A rated swag and bag for someone sleeping rough tonight, handed over by our outreach team." },
      { title: "Family Grocery Card", price: 120, category: "food",
        description: "A supermarket card a family spends themselves — dignity, and the right food for their kitchen." },
      { title: "Safe Night Motel Voucher", price: 140, category: "emergencies",
        description: "One night of safe motel accommodation, booked the same day the referral arrives." },
      { title: "Reading Tutor Hour", price: 30, category: "education",
        description: "An hour of one-to-one reading support at Homework Club, including the coordinator's time." },
    ], 14),

    volunteers: [
      { firstName: "Grace", lastName: "Ellery", age: 34, gender: "female", address: "Coburg VIC 3058", skills: "Commercial kitchen, food safety supervisor", availableDays: ["Thursday"], status: "approved" },
      { firstName: "Daniel", lastName: "Okafor", age: 41, gender: "male", address: "Preston VIC 3072", skills: "Van driving, warehouse logistics", availableDays: ["Wednesday", "Thursday"], status: "approved" },
      { firstName: "Mei", lastName: "Lin", age: 27, gender: "female", address: "Brunswick VIC 3056", skills: "Primary teaching, tutoring", availableDays: ["Monday", "Wednesday"], status: "approved" },
      { firstName: "Rob", lastName: "Sanderson", age: 58, gender: "male", address: "Northcote VIC 3070", skills: "Retired mechanic — Wheels to Work assessments", availableDays: ["Tuesday"], status: "shortlisted" },
      { firstName: "Amelia", lastName: "Frost", age: 23, gender: "female", address: "Carlton VIC 3053", skills: "Social work student, placement hours", availableDays: ["Monday", "Friday"], status: "reviewed" },
      { firstName: "Hamish", lastName: "Doyle", age: 36, gender: "male", address: "Thornbury VIC 3071", skills: "Graphic design, photography", availableDays: ["Saturday"], status: "reviewed" },
      { firstName: "Priya", lastName: "Raman", age: 45, gender: "female", address: "Reservoir VIC 3073", skills: "Bookkeeping, Xero", availableDays: ["Tuesday", "Thursday"], status: "approved" },
      { firstName: "Tomas", lastName: "Nowak", age: 31, gender: "male", address: "Fitzroy VIC 3065", skills: "Barista, event set-up", availableDays: ["Saturday", "Sunday"], status: "pending" },
      { firstName: "Bridget", lastName: "Cavanagh", age: 62, gender: "female", address: "Ivanhoe VIC 3079", skills: "Op shop sorting, till", availableDays: ["Monday", "Wednesday", "Friday"], status: "approved" },
      { firstName: "Sam", lastName: "Whitlock", age: 29, gender: "other", address: "Collingwood VIC 3066", skills: "Outreach, mental health first aid", availableDays: ["Thursday", "Friday"], status: "pending" },
      { firstName: "Nadia", lastName: "Haddad", age: 38, gender: "female", address: "Pascoe Vale VIC 3044", skills: "Arabic interpreting, intake support", availableDays: ["Wednesday"], status: "approved" },
      { firstName: "Oliver", lastName: "Brant", age: 19, gender: "male", address: "Bundoora VIC 3083", skills: "Heavy lifting, weekend pack-downs", availableDays: ["Saturday"], status: "rejected" },
    ],

    contacts: [
      { fullName: "Kathleen Doust", purpose: "Bequest", hostCity: "Melbourne", status: "pending",
        description: "I am updating my will and would like to understand how a gift to the First Rent Fund would be used." },
      { fullName: "Andrew Pyke", purpose: "Workplace giving", hostCity: "Melbourne", status: "reviewed",
        description: "We are a 40-person firm in Carlton looking to set up payroll giving. Who should I speak to?" },
      { fullName: "Sister Marie Ellul", purpose: "Referral", hostCity: "Melbourne", status: "responded",
        description: "Our parish has three families needing food support. What is the current wait for Kitchen Table?" },
      { fullName: "Ben Tregear", purpose: "Media", hostCity: "Melbourne", status: "pending",
        description: "Writing a piece on winter homelessness for a community paper — is someone available to talk this week?" },
      { fullName: "Yasmin Osman", purpose: "Volunteering", hostCity: "Melbourne", status: "responded",
        description: "I applied a fortnight ago for Thursday shifts and have not heard back — just checking my form arrived." },
      { fullName: "Grant McKinnon", purpose: "Donation query", hostCity: "Geelong", status: "reviewed",
        description: "My monthly donation appears twice on my statement for June. Can someone check?" },
      { fullName: "Lucia Fenn", purpose: "In-kind", hostCity: "Melbourne", status: "pending",
        description: "Our bakery has surplus most evenings and we would rather it went to your Thursday service than the bin." },
    ],

    partners: [
      { name: "Nathan Reilly", organisationName: "Kestrel & Bow Legal", partnershipType: "corporate", status: "approved",
        email: "giving@kestrelbow.com.au", phone: "(03) 5550 0210", website: "https://kestrelbow.com.au",
        message: "Pro bono tenancy advice plus a matched staff giving programme.", consentToList: true, showOnWebsite: true },
      { name: "Dee Halloran", organisationName: "Brunswick Grocers Co-op", partnershipType: "in-kind", status: "approved",
        email: "dee@brunswickgrocers.com.au", phone: "(03) 5550 0284", website: "https://brunswickgrocers.com.au",
        message: "Weekly surplus produce for Kitchen Table, delivered Wednesday nights.", consentToList: true, showOnWebsite: true },
      { name: "Marcus Webb", organisationName: "Trellis Build Group", partnershipType: "corporate", status: "contacted",
        email: "community@trellisbuild.com.au", phone: "(03) 5550 0377", website: "https://trellisbuild.com.au",
        message: "Interested in funding the Op Shop's second fit-out and sending a volunteer crew.", consentToList: true, showOnWebsite: false },
      { name: "Ruth Amberley", organisationName: "Northside Rotary", partnershipType: "community", status: "approved",
        email: "secretary@northsiderotary.org.au", phone: "(03) 5550 0455", website: "",
        message: "Our club would like to adopt the Winter Beds Appeal as this year's project.", consentToList: true, showOnWebsite: true },
      { name: "Callum Fraser", organisationName: "Fraser Motors Preston", partnershipType: "in-kind", status: "new",
        email: "callum@frasermotors.com.au", phone: "(03) 5550 0512", website: "",
        message: "Happy to do Wheels to Work servicing at cost. Roughly six cars a month.", consentToList: false, showOnWebsite: false },
      { name: "Imogen Slade", organisationName: "Slade & Partners Accounting", partnershipType: "ambassador", status: "declined",
        email: "imogen@sladepartners.com.au", phone: "(03) 5550 0603", website: "",
        message: "Offering to speak at donor events in exchange for logo placement across all materials.", consentToList: false, showOnWebsite: false },
    ],

    donors: [
      { first: "Helen", last: "Marsh", suburb: "Ivanhoe", state: "VIC", postcode: "3079" },
      { first: "Joseph", last: "Adeyemi", suburb: "Craigieburn", state: "VIC", postcode: "3064" },
      { first: "Claire", last: "Bennington", suburb: "Kew", state: "VIC", postcode: "3101" },
      { first: "Rahul", last: "Menon", suburb: "Docklands", state: "VIC", postcode: "3008" },
      { first: "Fiona", last: "Whitcombe", suburb: "Geelong", state: "VIC", postcode: "3220" },
    ],

    // Emails only — the newsletter list is the one place a big number reads as
    // realistic without inventing a whole person for each row.
    subscriberNames: [
      "helen.marsh", "joseph.adeyemi", "claire.bennington", "rahul.menon", "fiona.whitcombe",
      "greg.tolhurst", "sana.mahmood", "peter.vasilakis", "annie.corrigan", "dev.patel",
      "louise.arundel", "mark.chessell", "tania.orlov", "brendan.quill", "jia.wen",
      "monica.delacruz", "stuart.rainer", "hana.suzuki", "colin.abbott", "erin.mulvaney",
      "raj.sekhon", "belinda.royce", "tom.gaskell", "aisha.noor", "vince.perrotta",
      "kelly.strand", "owen.blackwood", "nadia.farouk", "harriet.lang", "simon.oakes",
      "gemma.wilder", "leo.castellan", "petra.novak", "duncan.mair", "yvette.solano",
      "craig.tennyson",
    ],
  },
};

/* ── HARBOURLIGHT FOUNDATION ───────────────────────────────────────────────
   The Islamic-giving tenant: isMuslimCharity flips on the Giving hub, the
   Zakat calculator and the Ramadan page, and manualProvision seeds the Zakat /
   Sadaqah / Lillah donation types instead of the general set. Western Sydney
   base, international programmes — the shape most Australian Muslim charities
   actually have.

   The name is deliberately plain English rather than Arabic: the Arabic-derived
   naming space is crowded (Barakah, Sakina and Amanah all return live ACNC
   registrations), and Human Appeal itself shows a plain-English name is
   entirely normal for the sector. */
const harbourlight = {
  tag: "harbourlight",
  slug: "harbourlight",
  displayName: "Harbourlight Foundation",

  lead: {
    orgName: "Harbourlight Foundation Ltd",
    orgWebsite: "https://www.harbourlight.org.au",
    verticalType: "muslim",
    causeAreas: ["zakat", "children", "disaster_relief", "poverty"],
    country: "Australia",
    contactPhone: "(02) 5550 0318",
    contactRole: "Fundraising Lead",
    staffSize: "21-50",
    annualBudgetRange: "1m_5m",
    donorDatabaseSize: "10000_plus",
    currentTools: ["custom", "spreadsheets"],
    challenges: ["zakat_tools", "online_giving", "email", "events"],
    interestedPlan: "essentials",
    interestedBillingCycle: "monthly",
    timeline: "immediately",
    decisionRole: "influencer",
    message:
      "DEMO TENANT — Harbourlight Foundation is not a real organisation. "
      + "Invented to demo the Islamic giving vertical (Zakat calculator, "
      + "Ramadan and the Giving hub) without standing up a real charity's "
      + "brand. Western Sydney base, international programmes.",
  },

  convert: {
    plan: "essentials",
    billingCycle: "monthly",
    revenueRange: "500-5000000",
    theme: "nature-ocean",
    isMuslimCharity: true,
    compReason: "Demo tenant — invented charity, never billed",
  },

  admin: { name: "Yusuf Karim", email: "admin@harbourlight.org.au" },

  publicContact: {
    contactEmail: "hello@harbourlight.org.au",
    contactPhone: "(02) 5550 0318",
    address: "Unit 4, 210 Wattletree Court, Auburn NSW 2144, Australia",
    addressDetails: {
      line1: "Unit 4, 210 Wattletree Court",
      city: "Auburn",
      state: "NSW",
      postalCode: "2144",
      country: "Australia",
    },
    website: "https://www.harbourlight.org.au",
    socialLinks: {
      facebook: "https://www.facebook.com/harbourlightfoundation",
      instagram: "https://www.instagram.com/harbourlightfoundation",
      linkedin: "https://www.linkedin.com/company/harbourlight-foundation",
    },
  },

  /* nature-ocean verbatim. #0284C7 sits at 4.08:1 on white — above the 3.0
     floor, so white button labels hold here too. */
  brand: {
    siteTitle: "Harbourlight Foundation",
    tagline: "Your Zakat, delivered and accounted for.",
    theme: "nature-ocean",
    primaryColor: "#0C4A6E",
    accentColor: "#0284C7",
    backgroundColor: "#F0F9FF",
    mark: "star", // see renderDemoCharityLogos.js
    hue: 199,
  },

  eventAudiences: [
    { key: "everyone", label: "Everyone", color: "#0284C7" },
    { key: "volunteers", label: "Volunteers", color: "#0C4A6E" },
    { key: "youth", label: "Youth", color: "#0E9488" },
    { key: "supporters", label: "Donors & supporters", color: "#6366F1" },
  ],

  // On top of the seven Islamic defaults manualProvision seeds.
  extraDonationTypes: ["Qurbani", "Orphan Sponsorship"],

  disabledPages: [],

  // Same reason as Bellhaven's — see the note there.
  homepage: {
    hero: {
      badge: "Zakat · Sadaqah · Emergency relief",
      title: "Your Zakat, delivered and accounted for",
      highlight: "delivered and accounted for",
      subtitle:
        "Zakat is held in its own account and distributed in full — to eligible families across Western Sydney, and to our programmes in Somalia, Pakistan and the Levant. Every distribution is reported back.",
      primaryCtaText: "Give your Zakat",
      primaryCtaLink: "/donate",
      secondaryCtaText: "Calculate your Zakat",
      secondaryCtaLink: "/zakat/calculator",
      stats: [
        { value: "100%", label: "Zakat policy" },
        { value: "$3.1M", label: "Zakat distributed" },
        { value: "260", label: "Children sponsored" },
        { value: "46", label: "Wells built" },
      ],
    },
    causes: {
      eyebrow: "Where it goes",
      heading: "Four programmes, reported one by one",
      intro: "Each has its own account, its own field team and its own report — so you can see where your own giving landed.",
      items: [
        { title: "Water", description: "Deep-bore wells with five years of maintenance.", link: "/initiative-2",
          image: "https://images.unsplash.com/photo-1541544741938-0af808871cc0?w=600&q=80" },
        { title: "Food", description: "Ramadan parcels and year-round community kitchens.", link: "/initiative-3",
          image: "https://images.unsplash.com/photo-1593113598332-cd288d649433?w=600&q=80" },
        { title: "Orphan care", description: "School fees, medical cover and a quarterly visit.", link: "/initiative-1",
          image: "https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=600&q=80" },
        { title: "Emergencies", description: "Shelter, blankets and fuel within the first week.", link: "/initiative-4",
          image: "https://images.unsplash.com/photo-1603321544554-f416a9a11fcb?w=600&q=80" },
      ],
    },
    cta: {
      title: "Not sure what you owe?",
      text: "Work out your Zakat on gold, savings, shares and superannuation in a couple of minutes, then give it in the same visit.",
      primaryCtaText: "Open the Zakat calculator",
      primaryCtaLink: "/zakat/calculator",
      secondaryCtaText: "Read our distribution policy",
      secondaryCtaLink: "/about",
    },
    seo: {
      title: "Harbourlight Foundation — Zakat, Sadaqah and emergency relief",
      description: "An Australian Muslim charity distributing Zakat in full, with orphan sponsorship, water and emergency programmes.",
    },
  },

  content: {
    programs: [
      { title: "Zakat Distribution — Local Families", goalAmount: 400000, raisedAmount: 286400, status: "published",
        description: "Zakat held in a separate account and distributed in full to eligible families across Western Sydney, verified through three partner mosques and a caseworker. Distribution report published every Muharram." },
      { title: "Orphan Sponsorship — Somalia", goalAmount: 320000, raisedAmount: 197500, status: "published",
        description: "Monthly support for 260 orphaned children: schooling, a medical card, clothing, and a caseworker who sits with each family every quarter. Sponsors get two letters a year." },
      { title: "Water Wells — Sindh", goalAmount: 180000, raisedAmount: 143200, status: "published",
        description: "Deep-bore wells with hand pumps and a maintenance fund for the village committee, so the well still works in year five. 46 built to date." },
      { title: "Ramadan Food Parcels", goalAmount: 260000, raisedAmount: 61800, status: "published",
        description: "A month of staples for a family of six — flour, rice, oil, dates, lentils — packed locally in each country and delivered before the first fast." },
      { title: "Winter Emergency Appeal", goalAmount: 150000, raisedAmount: 88900, status: "published",
        description: "Blankets, heaters and fuel vouchers for displaced families through the coldest eight weeks. Costed per household, reported per shipment." },
      { title: "Qurbani 2026", goalAmount: 210000, raisedAmount: 210000, status: "completed",
        description: "Completed. 1,340 shares distributed across four countries within the three days, with photographic verification per village." },
    ],

    events: [
      { title: "Community Iftar — Auburn", inDays: 38, startTime: "17:45", endTime: "21:00",
        eventType: "community", audience: "everyone", registrationMode: "internal", capacity: 400,
        registrationCount: 268, requiresRegistration: true, isPaid: true, price: 35, status: "upcoming",
        venue: "Auburn Community Centre", address: "44 Macquarie Road, Auburn NSW 2144", city: "Sydney",
        description: "Our biggest night of Ramadan: a shared iftar for 400, a short talk, and the year's Zakat distribution report read out in full." },
      { title: "Zakat Workshop — What Is Actually Due", inDays: 12, startTime: "19:00", endTime: "20:30",
        eventType: "workshop", audience: "everyone", registrationMode: "internal", capacity: 90,
        registrationCount: 54, requiresRegistration: true, isPaid: false, status: "upcoming",
        venue: "Harbourlight Office", address: "210 Wattletree Court, Auburn NSW 2144", city: "Sydney",
        description: "Nisab, the lunar year, gold, superannuation and shares — worked through with a scholar and our finance lead. Bring your questions and a calculator." },
      { title: "Ramadan Parcel Packing Day", inDays: 30, startTime: "09:00", endTime: "15:00",
        eventType: "volunteer", audience: "volunteers", registrationMode: "internal", capacity: 120,
        registrationCount: 91, requiresRegistration: true, isPaid: false, status: "upcoming",
        venue: "Greystanes Warehouse", address: "12 Cumberland Way, Greystanes NSW 2145", city: "Sydney",
        description: "Six hours, twelve pallets, 900 parcels. Under-16s welcome with a parent. Lunch provided." },
      { title: "Youth Fundraising Night", inDays: 54, startTime: "18:00", endTime: "21:30",
        eventType: "fundraiser", audience: "youth", registrationMode: "external", capacity: null,
        registrationCount: 0, requiresRegistration: false, isPaid: false, status: "upcoming",
        venue: "Bankstown Sports Club", address: "8 Greenfield Parade, Bankstown NSW 2200", city: "Sydney",
        registrationLink: "https://www.harbourlight.org.au/youth-night",
        description: "Run by our under-25s committee for the water programme. Food stalls, a five-a-side tournament and a live pledge board." },
      { title: "Qurbani Distribution Report Evening", inDays: -21, startTime: "19:00", endTime: "20:30",
        eventType: "awareness", audience: "supporters", registrationMode: "internal", capacity: 150,
        registrationCount: 132, requiresRegistration: true, isPaid: false, status: "completed",
        venue: "Auburn Community Centre", address: "44 Macquarie Road, Auburn NSW 2144", city: "Sydney",
        description: "Where every share went, village by village, with the field team on the call from Somalia and Pakistan." },
    ],

    products: products([
      { title: "Ramadan Food Parcel", price: 75, category: "food",
        description: "A month of staples for a family of six, packed in-country and delivered before the first fast." },
      { title: "Water Well Share", price: 250, category: "water",
        description: "A share in a deep-bore well with a hand pump and five years of maintenance for the village committee." },
      { title: "Orphan School Kit", price: 95, category: "education",
        description: "Uniform, shoes, books and a year of school fees for one sponsored child." },
      { title: "Emergency Shelter Kit", price: 180, category: "emergencies",
        description: "Tarpaulin, ground mat, blankets and cooking set for a displaced family of five." },
      { title: "Iftar for Ten", price: 60, category: "food",
        description: "A hot iftar meal for ten people at a community kitchen during Ramadan." },
      { title: "Hand Pump Repair", price: 40, category: "water",
        description: "Parts and a technician's day to bring a broken village pump back into service." },
    ], 199),

    volunteers: [
      { firstName: "Aisha", lastName: "Rahman", age: 26, gender: "female", address: "Lakemba NSW 2195", skills: "Event coordination, social media", availableDays: ["Saturday", "Sunday"], status: "approved" },
      { firstName: "Bilal", lastName: "Choudhury", age: 33, gender: "male", address: "Auburn NSW 2144", skills: "Warehouse, forklift ticket", availableDays: ["Wednesday", "Saturday"], status: "approved" },
      { firstName: "Fatima", lastName: "Zahra", age: 22, gender: "female", address: "Granville NSW 2142", skills: "Arabic & Urdu interpreting", availableDays: ["Sunday"], status: "approved" },
      { firstName: "Omar", lastName: "Siddiqui", age: 45, gender: "male", address: "Greystanes NSW 2145", skills: "Accounting, Zakat verification", availableDays: ["Tuesday", "Thursday"], status: "approved" },
      { firstName: "Layla", lastName: "Hassan", age: 30, gender: "female", address: "Merrylands NSW 2160", skills: "Nursing, health checks at distributions", availableDays: ["Saturday"], status: "shortlisted" },
      { firstName: "Ibrahim", lastName: "Toure", age: 38, gender: "male", address: "Blacktown NSW 2148", skills: "Van driving, deliveries", availableDays: ["Friday", "Saturday"], status: "reviewed" },
      { firstName: "Zara", lastName: "Ahmed", age: 19, gender: "female", address: "Bankstown NSW 2200", skills: "Youth committee, graphic design", availableDays: ["Sunday"], status: "reviewed" },
      { firstName: "Hassan", lastName: "Ali", age: 51, gender: "male", address: "Punchbowl NSW 2196", skills: "Community liaison, mosque outreach", availableDays: ["Friday"], status: "approved" },
      { firstName: "Mariam", lastName: "Nasser", age: 28, gender: "female", address: "Wentworthville NSW 2145", skills: "Photography, donor reporting", availableDays: ["Saturday", "Sunday"], status: "pending" },
      { firstName: "Yusra", lastName: "Begum", age: 24, gender: "female", address: "Guildford NSW 2161", skills: "Data entry, call-backs", availableDays: ["Monday", "Wednesday"], status: "pending" },
      { firstName: "Tariq", lastName: "Mahmood", age: 42, gender: "male", address: "Chester Hill NSW 2162", skills: "Logistics planning, customs paperwork", availableDays: ["Thursday"], status: "approved" },
      { firstName: "Sofia", lastName: "Karimi", age: 35, gender: "female", address: "Parramatta NSW 2150", skills: "Grant writing", availableDays: ["Tuesday"], status: "rejected" },
    ],

    contacts: [
      { fullName: "Abdullah Cheema", purpose: "Zakat question", hostCity: "Sydney", status: "pending",
        description: "I hold gold and a small business inventory. Does the calculator on your site cover stock at cost or at sale price?" },
      { fullName: "Rebecca Nguyen", purpose: "Corporate giving", hostCity: "Sydney", status: "reviewed",
        description: "Our company matches staff donations up to $20k a year and we would like the water programme to be an option." },
      { fullName: "Sheikh Idris Bello", purpose: "Partnership", hostCity: "Melbourne", status: "responded",
        description: "Our mosque would like to run a joint Ramadan appeal with a shared distribution report." },
      { fullName: "Hana Farooq", purpose: "Orphan sponsorship", hostCity: "Perth", status: "pending",
        description: "I sponsor two children and have moved house — how do I update the address my letters go to?" },
      { fullName: "David Marchant", purpose: "Media", hostCity: "Sydney", status: "reviewed",
        description: "Researching how Australian charities segregate Zakat funds. Is your finance lead available for a short interview?" },
      { fullName: "Salma Ait", purpose: "Volunteering", hostCity: "Sydney", status: "responded",
        description: "I would like to help at the packing day but cannot lift. Is there a seated role?" },
      { fullName: "Michael Ozturk", purpose: "Receipt request", hostCity: "Sydney", status: "pending",
        description: "I need my FY26 tax receipts resent — the email address on my account is out of date." },
      { fullName: "Noor Jahan", purpose: "Qurbani", hostCity: "Adelaide", status: "reviewed",
        description: "Can I nominate which country my Qurbani share goes to, or is it allocated by need?" },
    ],

    partners: [
      { name: "Adnan Malik", organisationName: "Crescent Freight Services", partnershipType: "in-kind", status: "approved",
        email: "adnan@crescentfreight.com.au", phone: "(02) 5550 0620", website: "https://crescentfreight.com.au",
        message: "Free container freight for Ramadan and Qurbani shipments, two per year.", consentToList: true, showOnWebsite: true },
      { name: "Sarah Kwan", organisationName: "Meridian Health Group", partnershipType: "corporate", status: "approved",
        email: "community@meridianhealth.com.au", phone: "(02) 5550 0714", website: "https://meridianhealth.com.au",
        message: "Staff matched giving plus volunteer nurses at distribution days.", consentToList: true, showOnWebsite: true },
      { name: "Imam Rashid Osman", organisationName: "Auburn Masjid Committee", partnershipType: "community", status: "approved",
        email: "office@auburnmasjid.org.au", phone: "(02) 5550 0801", website: "",
        message: "Joint Zakat verification and use of the hall for the community iftar.", consentToList: true, showOnWebsite: true },
      { name: "Priyanka Deshmukh", organisationName: "Northline Legal", partnershipType: "corporate", status: "contacted",
        email: "pro-bono@northlinelegal.com.au", phone: "(02) 5550 0918", website: "https://northlinelegal.com.au",
        message: "Pro bono governance and DGR compliance advice.", consentToList: true, showOnWebsite: false },
      { name: "Jamal Rahim", organisationName: "Rahim Grocers", partnershipType: "in-kind", status: "new",
        email: "jamal@rahimgrocers.com.au", phone: "(02) 5550 1004", website: "",
        message: "Dates and staples at cost for the Ramadan parcels.", consentToList: false, showOnWebsite: false },
    ],

    donors: [
      { first: "Imran", last: "Sheikh", suburb: "Auburn", state: "NSW", postcode: "2144" },
      { first: "Khadija", last: "Osman", suburb: "Lakemba", state: "NSW", postcode: "2195" },
      { first: "Peter", last: "Alcott", suburb: "Ryde", state: "NSW", postcode: "2112" },
      { first: "Amina", last: "Yusuf", suburb: "Greenacre", state: "NSW", postcode: "2190" },
      { first: "Waleed", last: "Bakhtiar", suburb: "Kellyville", state: "NSW", postcode: "2155" },
    ],

    subscriberNames: [
      "imran.sheikh", "khadija.osman", "peter.alcott", "amina.yusuf", "waleed.bakhtiar",
      "sadia.qureshi", "hamza.iqbal", "leila.mansour", "arif.hussain", "nour.eldin",
      "bilal.saeed", "maryam.ashraf", "junaid.rafiq", "salima.dawood", "ismail.kanu",
      "rania.haddad", "tanvir.alam", "huda.mostafa", "kareem.jalal", "farhana.begum",
      "zaid.othman", "asma.latif", "mohsin.raza", "layla.barakat", "ehsan.pour",
      "safia.malik", "danish.chowdhury", "nadira.suleiman", "usman.ghani", "hiba.zaman",
      "rashid.kamal", "sumaya.idris", "adil.qadir", "meher.aziz", "tahir.mirza",
      "zainab.faisal", "shahid.nawaz", "rukhsana.bibi", "ayaan.mustafa", "dalia.samra",
    ],
  },
};

const CHARITIES = [bellhaven, harbourlight];

const bySlug = (slug) => CHARITIES.find((c) => c.slug === slug);

/**
 * Pick the charities a script should act on from argv:
 *   node scripts/<x>.js                → both
 *   node scripts/<x>.js bellhaven      → just that one
 * Unknown names exit rather than silently doing nothing.
 */
function selectFromArgv(argv = process.argv.slice(2)) {
  const wanted = argv.filter((a) => !a.startsWith("-"));
  if (!wanted.length) return CHARITIES;
  const picked = [];
  for (const w of wanted) {
    const c = bySlug(w.toLowerCase());
    if (!c) {
      console.error(`Unknown charity "${w}". Known: ${CHARITIES.map((x) => x.slug).join(", ")}`);
      process.exit(1);
    }
    picked.push(c);
  }
  return picked;
}

module.exports = { CHARITIES, bellhaven, harbourlight, bySlug, selectFromArgv, daysAgo, daysAhead, initialsImage, logoImage };
