/**
 * Fill the two invented charities' portals with content.
 *
 * A freshly provisioned tenant has pages and donation types and nothing else,
 * which is a poor thing to demo: every list is empty, every dashboard reads
 * zero, and none of the screens that matter can be shown at all. This seeds the
 * middle ground — roughly what the humanappeal tenant carries — across
 * programmes, events, shop items, volunteers, contact requests, partner
 * inquiries, the newsletter list, donors and their donations.
 *
 * ── Idempotent, and destructive within that ─────────────────────────────────
 * Re-running DELETES the seeded collections for these two tenants and writes
 * them again, so the demo is reproducible rather than accumulating duplicates.
 * It is safe only because these organisations are demo tenants and nothing in
 * them is real: the script refuses to touch any slug that is not in
 * demoCharities.js, so it can never be pointed at ozharvest, humanappeal or a
 * paying customer.
 *
 * Pages, donation types and the admin user are NOT touched — those come from
 * provisioning.
 *
 * Run:  node scripts/seedDemoCharityContent.js              (both)
 *       node scripts/seedDemoCharityContent.js bellhaven    (just one)
 *       npm run seed:demo-content
 */

require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const Organisation = require("../models/organisation");
const User = require("../models/user");
const Program = require("../models/program");
const Event = require("../models/event");
const Product = require("../models/product");
const Order = require("../models/order");
const Join = require("../models/join");
const ContactRequest = require("../models/contact");
const PartnerInquiry = require("../models/partnerInquiry");
const Newsletter = require("../models/newsletter");
const Page = require("../models/page");
const { selectFromArgv, daysAgo, daysAhead, logoImage } = require("./demoCharities");

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("ERROR: No MONGODB_URI in .env");
  process.exit(1);
}

const DONOR_PASSWORD = "Donor@1234";

/**
 * Every invented person gets an address under <slug>.example.com.
 *
 * example.com is reserved (RFC 2606) so none of this can reach a real inbox,
 * and the per-tenant subdomain is not cosmetic: users.email is UNIQUE GLOBALLY,
 * not per organisation. A flat first.last@example.com collides with whatever
 * another tenant's seed already used — humanappeal's donor list, for one — and
 * the insert dies mid-run. Namespacing by slug also makes it obvious at a
 * glance which demo tenant a row belongs to.
 */
const personEmail = (slug, ...parts) =>
  parts.join(".").toLowerCase().replace(/[^a-z0-9.]+/g, ".").replace(/\.+/g, ".").replace(/^\.|\.$/g, "")
  + `@${slug}.example.com`;

/* ── Donations ──────────────────────────────────────────────────────────────
   Six months of giving, generated from fixed tables rather than Math.random so
   the dashboard's trend line, top-donor list and payment-method split come out
   the same on every run — a demo you can rehearse against.

   Shapes copied from the working seed in seedOrganisations.js: `single` for
   one-off gifts, `recurring` with a paymentHistory the subscriptions screen
   reads, and one `installments` plan so /admin/installments is not empty. */
const AMOUNTS = [50, 120, 35, 250, 80, 500, 65, 150, 40, 200, 90, 1000, 75, 300, 45];
const METHODS = ["visa", "mastercard", "visa", "bank", "mastercard"];
const STATUSES = ["completed", "completed", "completed", "completed", "completed", "pending"];

function buildOrders(org, donors, programs, donationTypes, prefix) {
  const orders = [];
  let seq = 1000;
  const nextId = () => `${prefix}${++seq}`;

  // 15 one-off gifts, ~2-3 a month across six months.
  AMOUNTS.forEach((amount, i) => {
    const donor = donors[i % donors.length];
    const program = i % 3 === 0 ? programs[i % programs.length] : null;
    const withAdminCost = i % 4 === 0;
    const adminCost = withAdminCost ? Math.round(amount * 0.02 * 100) / 100 : 0;
    orders.push({
      user: donor._id,
      organisationId: org._id,
      programId: program?._id || null,
      donationId: nextId(),
      items: [{ title: program ? program.title : donationTypes[i % donationTypes.length], price: amount, quantity: 1 }],
      paymentType: "single",
      donationType: donationTypes[i % donationTypes.length],
      adminCostContribution: { included: withAdminCost, amount: adminCost },
      donorDetails: {
        name: donor.name,
        phone: donor.phone,
        email: donor.email,
        address: donor.address ? { ...donor.address } : undefined,
      },
      paymentMethod: METHODS[i % METHODS.length],
      paymentStatus: STATUSES[i % STATUSES.length],
      totalAmount: amount + adminCost,
      transactionDetails: {},
      // Twelve days apart, ending two days ago: the trend chart has to reach the
      // CURRENT month or the dashboard reads as a portal nobody has used lately.
      createdAt: daysAgo(170 - i * 12),
      updatedAt: daysAgo(170 - i * 12),
    });
  });

  // Two live monthly gifts. Five charges already taken, the sixth scheduled.
  [[donors[0], 50], [donors[2], 25]].forEach(([donor, monthly], i) => {
    orders.push({
      user: donor._id,
      organisationId: org._id,
      donationId: nextId(),
      items: [{ title: "Monthly giving", price: monthly, quantity: 1 }],
      paymentType: "recurring",
      donationType: donationTypes[i],
      adminCostContribution: { included: false, amount: 0 },
      donorDetails: { name: donor.name, phone: donor.phone, email: donor.email },
      paymentMethod: i === 0 ? "visa" : "mastercard",
      paymentStatus: "active",
      totalAmount: monthly,
      recurringDetails: {
        frequency: "monthly",
        amount: monthly,
        startDate: daysAgo(160),
        endDate: daysAhead(200),
        status: "active",
        nextPaymentDate: daysAhead(30 - i * 8),
        totalPayments: 5,
        paymentHistory: [150, 120, 90, 60, 30].map((d) => ({
          date: daysAgo(d), amount: monthly, status: "succeeded",
        })),
      },
      createdAt: daysAgo(160),
      updatedAt: daysAgo(30),
    });
  });

  // One instalment plan, three of six paid.
  const planDonor = donors[3];
  orders.push({
    user: planDonor._id,
    organisationId: org._id,
    programId: programs[1]?._id || null,
    donationId: nextId(),
    items: [{ title: programs[1]?.title || "Pledge", price: 600, quantity: 1 }],
    paymentType: "installments",
    donationType: donationTypes[2] || donationTypes[0],
    adminCostContribution: { included: false, amount: 0 },
    donorDetails: { name: planDonor.name, phone: planDonor.phone, email: planDonor.email },
    paymentMethod: "visa",
    paymentStatus: "active",
    totalAmount: 600,
    installmentDetails: {
      numberOfInstallments: 6,
      installmentAmount: 100,
      startDate: daysAgo(90),
      status: "active",
      installmentsPaid: 3,
      nextInstallmentDate: daysAhead(2),
      paymentIntervalDays: 30,
      installmentHistory: [90, 60, 30].map((d, i) => ({
        installmentNumber: i + 1, date: daysAgo(d), amount: 100, status: "succeeded",
      })),
    },
    createdAt: daysAgo(90),
    updatedAt: daysAgo(30),
  });

  return orders;
}

/* ── Row builders ───────────────────────────────────────────────────────── */

const donorRows = (org, list) =>
  list.map((d, i) => ({
    name: `${d.first} ${d.last}`,
    firstName: d.first,
    lastName: d.last,
    email: personEmail(org.slug, d.first, d.last),
    password: bcrypt.hashSync(DONOR_PASSWORD, 10),
    role: "donor",
    organisationId: org._id,
    phone: `0491 570 0${String(10 + i).slice(-2)}`, // ACMA fiction block
    address: { street: `${12 + i * 7} Sample Street`, city: d.suburb, state: d.state, postalCode: d.postcode },
  }));

const eventRows = (org, list, contactEmail) =>
  list.map((e) => ({
    organisationId: org._id,
    title: e.title,
    date: e.inDays >= 0 ? daysAhead(e.inDays) : daysAgo(-e.inDays),
    startTime: e.startTime,
    endTime: e.endTime,
    timezone: "Australia/Sydney",
    location: { city: e.city, venue: e.venue, address: e.address },
    description: e.description,
    eventType: e.eventType,
    audience: e.audience,
    registrationMode: e.registrationMode,
    registrationLink: e.registrationLink || "",
    capacity: e.capacity ?? null,
    registrationCount: e.registrationCount || 0,
    requiresRegistration: !!e.requiresRegistration,
    isRegistrationOpen: e.status === "upcoming",
    allowGuests: false,
    maxGuestsPerRegistration: 0,
    isPaid: !!e.isPaid,
    price: e.price || 0,
    currency: "AUD",
    contactEmail,
    featured: false,
    status: e.status,
  }));

const volunteerRows = (org, list) =>
  list.map((v, i) => ({
    organisationId: org._id,
    ...v,
    email: personEmail(org.slug, v.firstName, v.lastName),
    phoneNumber: `0491 570 1${String(10 + i).slice(-2)}`,
    source: "website",
    createdAt: daysAgo(60 - i * 4),
  }));

const contactRows = (org, list) =>
  list.map((c, i) => ({
    organisationId: org._id,
    fullName: c.fullName,
    email: personEmail(org.slug, c.fullName),
    phoneNumber: `0491 570 0${String(50 + i).slice(-2)}`,
    purpose: c.purpose,
    hostCity: c.hostCity,
    description: c.description,
    numberOfGuests: 0,
    minimumDonation: 0,
    status: c.status,
    lastMessageAt: daysAgo(i * 3 + 1),
    createdAt: daysAgo(i * 3 + 1),
  }));

const partnerRows = (org, list, hue) =>
  list.map((p, i) => {
    // Only the ones going on the public wall get a logo — that mirrors reality
    // (an inquiry arrives without one) and it is what gates publication.
    const logo = p.showOnWebsite ? logoImage(p.organisationName, hue) : "";
    return {
      organisationId: org._id,
      ...p,
      logoUrl: logo,
      logoKey: "",
      adminNotes: "",
      displayOrder: i,
      publicName: p.organisationName,
      publicLogoUrl: logo,
      publicLogoKey: "",
      source: "website",
      createdAt: daysAgo(i * 9 + 4),
    };
  });

const newsletterRows = (org, names) =>
  names.map((n, i) => ({
    organisationId: org._id,
    email: personEmail(org.slug, n),
    // Every 12th subscriber has opted out, so the segment counts and the
    // unsubscribe column on the campaigns screen have something to show.
    status: i % 12 === 11 ? "unsubscribed" : "active",
    source: ["website", "checkout", "event", "import"][i % 4],
    unsubscribeToken: `demo-${org.slug}-${n}`,
    createdAt: daysAgo(200 - i * 4),
  }));

/**
 * Rewrite the seeded homepage in the tenant's own words.
 *
 * seedPagesForOrg gives every new tenant the same starter Home — "Changing
 * Lives, One Act of Kindness", $2.4M raised, 30+ countries. A real charity
 * rewrites that on day one; a demo tenant that hasn't is instantly recognisable
 * as a template, and its hero stats openly contradict the donations seeded
 * below. Hero, cause cards and closing band come from the charity's own
 * `homepage` block instead.
 *
 * Both `content` (published) and `draftContent` (the pending edit, when one
 * exists) are written, or the CMS would open on the old copy and publishing
 * would put it straight back.
 */
async function applyHomepage(org, c) {
  if (!c.homepage) return null;
  const page = await Page.findOne({ organisationId: org._id, key: "home" });
  if (!page) return null;

  for (const field of ["content", "draftContent"]) {
    const doc = page[field];
    if (!doc) continue;
    doc.hero = { ...(doc.hero || {}), ...c.homepage.hero };
    for (const section of doc.sections || []) {
      if (section.type === "cardGrid") section.data = { ...section.data, ...c.homepage.causes };
      if (section.type === "ctaBand") section.data = { ...section.data, ...c.homepage.cta };
    }
    page.markModified(field);
  }
  page.seo = { ...(page.seo?.toObject?.() ?? page.seo ?? {}), ...c.homepage.seo };
  await page.save();

  // The partners page ships with a hand-curated logo strip of invented
  // organisations ("Community Aid Network", …) whose "logos" are stock photos.
  // Emptying `items` and switching the source to `approved` hands the wall over
  // to the partner inquiries seeded below — which is the feature worth showing,
  // and stops two sets of made-up partners appearing side by side.
  const partnersPage = await Page.findOne({ organisationId: org._id, key: "partners" });
  if (partnersPage) {
    for (const field of ["content", "draftContent"]) {
      const doc = partnersPage[field];
      if (!doc) continue;
      for (const section of doc.sections || []) {
        if (section.type === "logosStrip") section.data = { ...section.data, source: "approved", items: [] };
      }
      partnersPage.markModified(field);
    }
    await partnersPage.save();
  }

  // A page the tenant would never have — Bellhaven has no overseas water
  // programme. Disabling cascades to the nav, footer, PageGate and the ⌘K search.
  let disabled = 0;
  if (c.disabledPages?.length) {
    const res = await Page.updateMany(
      { organisationId: org._id, key: { $in: c.disabledPages } },
      { $set: { enabled: false } },
    );
    disabled = res.modifiedCount ?? 0;
  }
  return { disabled };
}

async function seedCharity(c) {
  const org = await Organisation.findOne({ slug: c.slug });
  if (!org) {
    console.log(`SKIP ${c.slug} — no organisation with that slug. Run seed:demo-charities first.\n`);
    return;
  }
  console.log(`── ${org.name} ${"─".repeat(Math.max(0, 50 - org.name.length))}`);

  const orgId = org._id;
  const { content } = c;

  // Clear what this script owns, so a re-run replaces rather than duplicates.
  //
  // Donors are matched by the reserved DOMAIN, not by the current name list: an
  // earlier run may have seeded a donor this run no longer has (or, as happened
  // here, used a different address scheme), and matching names would strand
  // those rows in the tenant forever with no donations attached. Anything at
  // example.com came from a seed; a real person who signs up during a demo has
  // a real address and is left alone.
  const seededDonor = /@(?:[a-z0-9-]+\.)?example\.com$/i;
  await Promise.all([
    Program.deleteMany({ organisationId: orgId }),
    Event.deleteMany({ organisationId: orgId }),
    Product.deleteMany({ organisationId: orgId }),
    Order.deleteMany({ organisationId: orgId }),
    Join.deleteMany({ organisationId: orgId }),
    ContactRequest.deleteMany({ organisationId: orgId }),
    PartnerInquiry.deleteMany({ organisationId: orgId }),
    Newsletter.deleteMany({ organisationId: orgId }),
    User.deleteMany({ organisationId: orgId, role: "donor", email: seededDonor }),
  ]);

  const programs = await Program.insertMany(
    content.programs.map((p) => ({ ...p, organisationId: orgId, coverImageIndex: 0, images: [] })),
  );
  console.log(`   programs          ${programs.length}`);

  const events = await Event.insertMany(eventRows(org, content.events, c.publicContact.contactEmail));
  console.log(`   events            ${events.length}  (${events.filter((e) => e.status === "upcoming").length} upcoming)`);

  const products = await Product.insertMany(content.products.map((p) => ({ ...p, organisationId: orgId })));
  console.log(`   shop items        ${products.length}`);

  const donors = await User.insertMany(donorRows(org, content.donors));
  console.log(`   donors            ${donors.length}  (password ${DONOR_PASSWORD})`);

  // Donation types the tenant actually has, so a donation never references a
  // type that is not in its own list.
  const types = (await mongoose.connection.db
    .collection("donationtypes")
    .find({ organisationId: orgId }).toArray()).map((t) => t.donationType);

  const orders = await Order.insertMany(
    buildOrders(org, donors, programs, types.length ? types : ["General Donation"], c.slug === "bellhaven" ? "DBH" : "DHL"),
  );
  const received = orders
    .filter((o) => o.paymentStatus === "completed")
    .reduce((sum, o) => sum + o.totalAmount, 0);
  console.log(`   donations         ${orders.length}  ($${received.toLocaleString("en-AU")} completed, 2 recurring, 1 instalment plan)`);

  const volunteers = await Join.insertMany(volunteerRows(org, content.volunteers));
  console.log(`   volunteers        ${volunteers.length}`);

  const contacts = await ContactRequest.insertMany(contactRows(org, content.contacts));
  console.log(`   contact requests  ${contacts.length}`);

  const partners = await PartnerInquiry.insertMany(partnerRows(org, content.partners, c.brand.hue));
  console.log(`   partners          ${partners.length}  (${partners.filter((p) => p.showOnWebsite).length} on the public wall)`);

  const subs = await Newsletter.insertMany(newsletterRows(org, content.subscriberNames));
  console.log(`   subscribers       ${subs.length}  (${subs.filter((s) => s.status === "active").length} active)`);

  const home = await applyHomepage(org, c);
  if (home) {
    console.log(`   homepage          rewritten in the charity's own words${home.disabled ? ` · ${home.disabled} page(s) turned off` : ""}`);
  }
  console.log("");
}

async function run() {
  const charities = selectFromArgv();
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log(`Connected to ${mongoose.connection.name}\n`);

  for (const c of charities) await seedCharity(c);

  await mongoose.disconnect();
  console.log("Done. Log into each portal to see it — credentials are printed by seed:demo-charities.");
}

run().catch(async (e) => {
  console.error("\nFAILED:", e.message);
  console.error(e.stack);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
