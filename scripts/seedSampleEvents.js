/**
 * Seed one sample event per registration scenario for a tenant, and enrich the
 * tenant's existing events with a sensible scenario.
 *
 * Scenarios covered: info-only, external link, internal free (unlimited),
 * internal capped + guests, internal paid + featured, registration closed,
 * deadline passed, full (at capacity), online webinar, completed, cancelled,
 * ongoing multi-day.
 *
 * Idempotent: sample events are upserted by (organisationId, title), so re-running
 * updates them in place rather than creating duplicates. No documents are deleted.
 *
 * Run:  npm run seed:sample-events            (defaults to org slug "calcite")
 *       SEED_ORG_SLUG=yourslug npm run seed:sample-events
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Event = require("../models/event");
const Organisation = require("../models/organisation");

const MONGODB_URI = process.env.MONGODB_URI;
const ORG_SLUG = process.env.SEED_ORG_SLUG || "calcite";

const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(9, 0, 0, 0);
  return d;
};

// Reusable question presets
const Q = {
  dietary: { key: "dietary_requirements", label: "Dietary requirements", type: "select", required: false, options: ["None", "Vegetarian", "Vegan", "Halal", "Gluten-free", "Other"] },
  tshirt: { key: "tshirt_size", label: "T-shirt size", type: "select", required: false, options: ["XS", "S", "M", "L", "XL", "XXL"] },
  emergency: { key: "emergency_contact", label: "Emergency contact (name & phone)", type: "text", required: true, options: [] },
  availability: { key: "availability", label: "Availability", type: "textarea", required: false, options: [] },
  guestsNum: { key: "number_of_guests", label: "Number of guests joining you", type: "number", required: false, options: [] },
  seats: { key: "number_of_seats", label: "Number of seats", type: "number", required: false, options: [] },
  table: { key: "table_preference", label: "Table / seating preference", type: "text", required: false, options: [] },
  org: { key: "organisation", label: "Organisation / company", type: "text", required: false, options: [] },
  hear: { key: "how_did_you_hear", label: "How did you hear about us?", type: "select", required: false, options: ["Social media", "Friend or family", "Email", "Our website", "Other"] },
  age: { key: "age_group", label: "Age group", type: "select", required: false, options: ["Under 18", "18–30", "31–50", "51+"] },
  concerns: { key: "health_concerns", label: "Specific health concerns (optional)", type: "textarea", required: false, options: [] },
};

const loc = (city, venue, address) => ({ city, venue, address });

function buildSamples(orgId) {
  const base = { organisationId: orgId, timezone: "AEST", startTime: "10:00", endTime: "14:00", currency: "AUD" };
  return [
    // 1. Info-only (no registration)
    {
      ...base, title: "Open Day at Our Centre", eventType: "community", status: "upcoming",
      date: day(20), registrationMode: "none",
      location: loc("Sydney", "Calcite Community Centre", "12 Hope St, Sydney NSW"),
      description: "Drop in to meet our team, tour the centre and learn about the programs we run. No booking needed — everyone is welcome.",
    },
    // 2. External link
    {
      ...base, title: "Annual Charity Gala — Buy Tickets", eventType: "gala", status: "upcoming",
      date: day(45), startTime: "18:30", endTime: "23:00", registrationMode: "external",
      registrationLink: "https://example.org/gala-tickets", featured: true,
      location: loc("Sydney", "Grand Ballroom, Hilton", "488 George St, Sydney NSW"),
      description: "An elegant evening of dinner, entertainment and a live auction. Tickets are sold through our ticketing partner.",
    },
    // 3. Internal free, unlimited, with questions
    {
      ...base, title: "Beach Cleanup Volunteer Day", eventType: "volunteer", status: "upcoming",
      date: day(10), startTime: "08:00", endTime: "12:00", registrationMode: "internal",
      requiresRegistration: true, isRegistrationOpen: true, capacity: null,
      allowGuests: true, maxGuestsPerRegistration: 3,
      registrationQuestions: [Q.tshirt, Q.availability, Q.emergency],
      location: loc("Sydney", "Bondi Beach", "Bondi Beach, Sydney NSW"),
      description: "Join our volunteers to keep our beaches clean. Gloves and bags provided — just bring water and sunscreen.",
    },
    // 4. Internal free, capacity-limited, guests allowed
    {
      ...base, title: "Community Iftar Dinner", eventType: "community", status: "upcoming",
      date: day(14), startTime: "18:00", endTime: "21:00", registrationMode: "internal",
      requiresRegistration: true, isRegistrationOpen: true, capacity: 150, registrationCount: 86,
      allowGuests: true, maxGuestsPerRegistration: 6, registrationDeadline: day(12),
      registrationQuestions: [Q.guestsNum, Q.dietary],
      location: loc("Melbourne", "Community Hall", "5 Unity Rd, Melbourne VIC"),
      description: "Break bread with the community at our shared Iftar. Bring your family and friends — all are welcome at the table.",
    },
    // 5. Internal paid, featured, with questions
    {
      ...base, title: "Charity Gala Dinner 2026", eventType: "gala", status: "upcoming",
      date: day(60), startTime: "19:00", endTime: "23:30", registrationMode: "internal",
      requiresRegistration: true, isRegistrationOpen: true, capacity: 200, registrationCount: 64,
      allowGuests: true, maxGuestsPerRegistration: 1, isPaid: true, price: 120, featured: true,
      registrationQuestions: [Q.dietary, Q.seats, Q.table],
      location: loc("Sydney", "Sofitel Darling Harbour", "12 Darling Dr, Sydney NSW"),
      description: "Join us for an elegant evening in support of our cause — dinner, guest speakers and a live auction. Every seat helps us make a difference.",
    },
    // 6. Internal, registration CLOSED
    {
      ...base, title: "Leadership Workshop (Registrations Closed)", eventType: "workshop", status: "upcoming",
      date: day(30), startTime: "09:30", endTime: "16:00", registrationMode: "internal",
      requiresRegistration: true, isRegistrationOpen: false, capacity: 40, registrationCount: 25,
      registrationQuestions: [Q.org],
      location: loc("Brisbane", "Training Room A", "200 Adelaide St, Brisbane QLD"),
      description: "A full-day workshop for emerging community leaders. Registrations are currently closed.",
    },
    // 7. Internal, deadline PASSED
    {
      ...base, title: "Fun Run for a Cause", eventType: "fundraiser", status: "upcoming",
      date: day(5), startTime: "07:00", endTime: "11:00", registrationMode: "internal",
      requiresRegistration: true, isRegistrationOpen: true, capacity: 300, registrationCount: 180,
      allowGuests: true, maxGuestsPerRegistration: 4, registrationDeadline: day(-2),
      registrationQuestions: [Q.tshirt, Q.age],
      location: loc("Perth", "Kings Park", "Fraser Ave, Perth WA"),
      description: "Walk or run to raise funds and awareness. All ages and fitness levels welcome. (Registration deadline has passed.)",
    },
    // 8. Internal, FULL (at capacity)
    {
      ...base, title: "Free Health Camp (Fully Booked)", eventType: "community", status: "upcoming",
      date: day(8), startTime: "09:00", endTime: "15:00", registrationMode: "internal",
      requiresRegistration: true, isRegistrationOpen: true, capacity: 50, registrationCount: 50,
      registrationQuestions: [Q.age, Q.concerns],
      location: loc("Adelaide", "Mobile Clinic", "Victoria Square, Adelaide SA"),
      description: "Free check-ups and consultations with our medical partners. This camp is fully booked.",
    },
    // 9. Online webinar (internal)
    {
      ...base, title: "Online Fundraising Webinar", eventType: "webinar", status: "upcoming",
      date: day(18), startTime: "13:00", endTime: "14:00", registrationMode: "internal",
      requiresRegistration: true, isRegistrationOpen: true, capacity: null, registrationCount: 42,
      registrationQuestions: [Q.org, Q.hear],
      location: loc("Online", "Zoom", ""),
      description: "Learn how community fundraising works and how you can get involved. A live Q&A with our team is included.",
    },
    // 10. Completed past event
    {
      ...base, title: "Ramadan Food Drive 2025", eventType: "community", status: "completed",
      date: day(-40), registrationMode: "none",
      location: loc("Sydney", "Distribution Hub", "8 Charity Ln, Sydney NSW"),
      description: "We packed and distributed thousands of ration hampers to families in need. Thank you to everyone who contributed.",
    },
    // 11. Cancelled event
    {
      ...base, title: "Outdoor Charity Concert (Cancelled)", eventType: "community", status: "cancelled",
      date: day(25), startTime: "17:00", endTime: "22:00", registrationMode: "internal",
      requiresRegistration: true, isRegistrationOpen: false, capacity: 500, registrationCount: 120,
      location: loc("Gold Coast", "Amphitheatre", "Surfers Paradise, QLD"),
      description: "Unfortunately this event has been cancelled. Registered attendees have been notified.",
    },
    // 12. Ongoing, multi-day, info-only, featured
    {
      ...base, title: "Week-long Donation Drive", eventType: "fundraiser", status: "ongoing",
      date: day(-1), endDate: day(5), startTime: "09:00", endTime: "17:00", registrationMode: "none",
      featured: true,
      location: loc("Sydney", "Main Foyer", "1 Generosity Ave, Sydney NSW"),
      description: "Our week-long drive is underway! Drop off donations any day this week at the main foyer.",
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

  let org = await Organisation.findOne({ slug: ORG_SLUG }).select("_id name slug").lean();
  if (!org) {
    org = await Organisation.findOne({}).select("_id name slug").lean();
    if (!org) {
      console.error("ERROR: No organisations found to seed events for.");
      await mongoose.disconnect();
      process.exit(1);
    }
    console.warn(`Org slug "${ORG_SLUG}" not found — using "${org.slug || org.name}" instead.\n`);
  }
  console.log(`Seeding sample events for: ${org.slug || org.name} (${org._id})\n`);

  const samples = buildSamples(org._id);
  const sampleTitles = samples.map((s) => s.title);

  // 1) Upsert each sample event by (org, title)
  for (const ev of samples) {
    await Event.findOneAndUpdate(
      { organisationId: org._id, title: ev.title },
      { $set: ev },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    console.log(`  ✓ ${ev.status.padEnd(9)} ${ev.registrationMode.padEnd(8)} ${ev.title}`);
  }

  // 2) Enrich existing (non-sample) events that have no real scenario yet.
  // We rotate through a set of varied profiles so existing events showcase
  // different scenarios. .lean() so an absent registrationMode reads as
  // undefined (not the schema default).
  const PROFILES = [
    { // paid gala, featured
      registrationMode: "internal", requiresRegistration: true, isRegistrationOpen: true,
      capacity: 200, registrationCount: 72, allowGuests: true, maxGuestsPerRegistration: 1,
      isPaid: true, price: 100, featured: true, registrationQuestions: [Q.dietary, Q.seats, Q.table],
    },
    { // workshop / seminar
      registrationMode: "internal", requiresRegistration: true, isRegistrationOpen: true,
      capacity: 60, registrationCount: 23, registrationQuestions: [Q.org, Q.age],
    },
    { // volunteer, unlimited, guests
      registrationMode: "internal", requiresRegistration: true, isRegistrationOpen: true,
      capacity: null, registrationCount: 38, allowGuests: true, maxGuestsPerRegistration: 3,
      registrationQuestions: [Q.tshirt, Q.availability, Q.emergency],
    },
    { // run, capped, guests
      registrationMode: "internal", requiresRegistration: true, isRegistrationOpen: true,
      capacity: 300, registrationCount: 215, allowGuests: true, maxGuestsPerRegistration: 4,
      registrationQuestions: [Q.tshirt, Q.age],
    },
    { registrationMode: "none" }, // info-only
  ];

  const existing = await Event.find({ organisationId: org._id, title: { $nin: sampleTitles } }).lean();
  let enriched = 0;
  for (const ev of existing) {
    const explicitMode = ev.registrationMode === "external" || ev.registrationMode === "internal";
    const hasLink = ev.registrationLink && ev.registrationLink.trim();
    if (explicitMode || hasLink) continue; // already configured — leave it alone
    const profile = PROFILES[enriched % PROFILES.length];
    await Event.updateOne({ _id: ev._id }, { $set: profile });
    enriched++;
    console.log(`  ↻ enriched existing → ${profile.registrationMode.padEnd(8)} ${ev.title}`);
  }

  console.log(`\n✅ Done. ${samples.length} sample events upserted, ${enriched} existing event(s) enriched.`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (e) => {
  console.error("\n❌ Sample event seeding failed:", e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
