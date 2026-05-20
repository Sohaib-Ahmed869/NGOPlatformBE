/**
 * Multi-Organisation Seed Script
 *
 * Seeds comprehensive data for both existing organisations:
 *   - hopegive  (slug: hopegive)
 *   - calcite   (slug: calcite)
 *
 * Creates for EACH org: admin user, 5 donors, donation types, products,
 * events, programs, orders, contacts, volunteers, newsletter subscribers.
 *
 * Run:  node scripts/seedOrganisations.js
 *
 * Login credentials after seeding:
 *   HopeGive Admin:  admin@hopegive.org  / Admin@1234
 *   Calcite Admin:   admin@calcite.org   / Admin@1234
 *   All Donors:      {name}@{slug}.org   / Donor@1234
 */

require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const User = require("../models/user");
const Product = require("../models/product");
const Order = require("../models/order");
const Event = require("../models/event");
const DonationType = require("../models/donationtypes");
const Newsletter = require("../models/newsletter");
const ContactRequest = require("../models/contact");
const Join = require("../models/join");
const PaymentMethod = require("../models/paymentMethods");
const Program = require("../models/program");

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) { console.error("ERROR: No MONGODB_URI in .env"); process.exit(1); }

// ── Existing org IDs from the database ──────────────────
const ORGS = {
  hopegive: {
    _id: new mongoose.Types.ObjectId("6a0c50f73048907de47fb22d"),
    adminUserId: new mongoose.Types.ObjectId("6a0c51173048907de47fb234"),
    slug: "hopegive",
    name: "HopeGive",
  },
  calcite: {
    _id: new mongoose.Types.ObjectId("6a0c58ab0f5ecc9c8dc43285"),
    adminUserId: new mongoose.Types.ObjectId("6a0c58da12a6b53d03a911c0"),
    slug: "calcite",
    name: "Calcite",
  },
};

const hash = (pw) => bcrypt.hashSync(pw, 10);
const ADMIN_PW = hash("Admin@1234");
const DONOR_PW = hash("Donor@1234");

let donationIdCounter = 100000;
const nextDonationId = () => `D${++donationIdCounter}`;

// ── Helpers ─────────────────────────────────────────────
const pastDate = (daysAgo) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d;
};
const futureDate = (daysAhead) => {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d;
};

// ── Data generators per org ─────────────────────────────
function generateDonors(org) {
  const donors = [
    { first: "Emily", last: "Johnson", email: `emily@${org.slug}.org`, phone: "+61412345001" },
    { first: "Ahmed", last: "Khan", email: `ahmed@${org.slug}.org`, phone: "+61412345002" },
    { first: "Sarah", last: "Williams", email: `sarah@${org.slug}.org`, phone: "+61412345003" },
    { first: "Faisal", last: "Rahman", email: `faisal@${org.slug}.org`, phone: "+61412345004" },
    { first: "Maria", last: "Garcia", email: `maria@${org.slug}.org`, phone: "+61412345005" },
  ];
  return donors.map((d) => ({
    name: `${d.first} ${d.last}`,
    firstName: d.first,
    lastName: d.last,
    email: d.email,
    password: DONOR_PW,
    role: "donor",
    organisationId: org._id,
    phone: d.phone,
    address: { street: `${Math.floor(Math.random() * 200) + 1} Main St`, city: "Sydney", state: "NSW", postalCode: "2000" },
  }));
}

function generateDonationTypes(orgId) {
  return [
    "Sadaqah", "Zakat ul Maal", "Zakat ul Fitr",
    "Education Fund", "Water Fund", "Food Fund",
    "Emergency Relief", "Orphan Care",
  ].map((dt) => ({ organisationId: orgId, donationType: dt }));
}

function generateProducts(orgId) {
  return [
    { title: "School Supplies Kit", description: "Complete kit with books, pens, and stationery for one child", price: 25, category: "education", image: "https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=400&h=400&fit=crop" },
    { title: "Teacher Training Program", description: "Fund one month of teacher training in rural areas", price: 150, category: "education", image: "https://images.unsplash.com/photo-1509062522246-3755977927d7?w=400&h=400&fit=crop" },
    { title: "Clean Water Well", description: "Contribute to building a clean water well", price: 500, category: "water", image: "https://images.unsplash.com/photo-1541544537156-7627a7a4aa1c?w=400&h=400&fit=crop" },
    { title: "Water Filter System", description: "Provide a household water filtration system", price: 75, category: "water", image: "https://images.unsplash.com/photo-1581244277943-fe4a9c777189?w=400&h=400&fit=crop" },
    { title: "Food Pack - Family", description: "Monthly food supplies for a family of five", price: 50, category: "food", image: "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?w=400&h=400&fit=crop" },
    { title: "Community Kitchen Meal", description: "Sponsor 100 meals at a community kitchen", price: 200, category: "food", image: "https://images.unsplash.com/photo-1547592180-85f173990554?w=400&h=400&fit=crop" },
    { title: "Emergency Medical Kit", description: "Essential medical supplies for disaster zones", price: 100, category: "emergencies", image: "https://images.unsplash.com/photo-1516574187841-cb9cc2ca948b?w=400&h=400&fit=crop" },
    { title: "Shelter Materials Pack", description: "Temporary shelter materials for displaced families", price: 300, category: "emergencies", image: "https://images.unsplash.com/photo-1569025743873-ea3a9ber528f0?w=400&h=400&fit=crop" },
  ].map((p) => ({
    ...p,
    organisationId: orgId,
    slug: p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + orgId.toString().slice(-4),
    isActive: true,
  }));
}

function generateEvents(orgId) {
  return [
    { title: "Annual Charity Gala", description: "Join us for an evening of giving and celebration", date: futureDate(30), startTime: "18:00", endTime: "22:00", location: { city: "Sydney", venue: "Grand Ballroom", address: "100 George St" }, status: "upcoming", imageUrl: "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=600&h=400&fit=crop" },
    { title: "Community Clean-Up Day", description: "Help us clean up local parks and beaches", date: futureDate(14), startTime: "08:00", endTime: "14:00", location: { city: "Sydney", venue: "Bondi Beach", address: "Bondi Beach Pavilion" }, status: "upcoming", imageUrl: "https://images.unsplash.com/photo-1559027615-cd4628902d4a?w=600&h=400&fit=crop" },
    { title: "Youth Education Workshop", description: "Free workshop on digital literacy for young people", date: futureDate(45), startTime: "10:00", endTime: "16:00", location: { city: "Melbourne", venue: "Community Hall", address: "50 Flinders St" }, status: "upcoming", imageUrl: "https://images.unsplash.com/photo-1524178232363-1fb2b075b655?w=600&h=400&fit=crop" },
    { title: "Fundraiser Walk-a-thon", description: "5km sponsored walk for clean water projects", date: pastDate(10), startTime: "07:00", endTime: "12:00", location: { city: "Brisbane", venue: "Riverside Park", address: "South Bank" }, status: "completed", imageUrl: "https://images.unsplash.com/photo-1571902943202-507ec2618e8f?w=600&h=400&fit=crop" },
  ].map((e) => ({ ...e, organisationId: orgId, timezone: "Australia/Sydney" }));
}

function generatePrograms(orgId, adminId) {
  const programImages = [
    [
      { url: "https://images.unsplash.com/photo-1541544537156-7627a7a4aa1c?w=600&h=400&fit=crop", key: "seed/well-1" },
      { url: "https://images.unsplash.com/photo-1581244277943-fe4a9c777189?w=600&h=400&fit=crop", key: "seed/well-2" },
    ],
    [
      { url: "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?w=600&h=400&fit=crop", key: "seed/food-1" },
      { url: "https://images.unsplash.com/photo-1547592180-85f173990554?w=600&h=400&fit=crop", key: "seed/food-2" },
    ],
    [
      { url: "https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=600&h=400&fit=crop", key: "seed/school-1" },
      { url: "https://images.unsplash.com/photo-1509062522246-3755977927d7?w=600&h=400&fit=crop", key: "seed/school-2" },
    ],
    [
      { url: "https://images.unsplash.com/photo-1469571486292-0ba58a3f068b?w=600&h=400&fit=crop", key: "seed/winter-1" },
    ],
  ];
  const followUpImages = [
    "https://images.unsplash.com/photo-1594708767771-a7502209ff7e?w=400&h=300&fit=crop",
    "https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=400&h=300&fit=crop",
  ];

  return [
    { title: "Build a Well", description: "Help us build clean water wells in rural communities. Every dollar brings us closer to providing safe drinking water.", goalAmount: 5000, raisedAmount: 1250, status: "published" },
    { title: "Feed 100 Families", description: "Provide monthly food packages to 100 families in need during this difficult season.", goalAmount: 10000, raisedAmount: 3400, status: "published" },
    { title: "School Rebuilding Project", description: "Rebuild damaged classrooms and provide new learning materials for children.", goalAmount: 25000, raisedAmount: 8750, status: "published" },
    { title: "Winter Relief Drive", description: "Distribute warm clothing and blankets to refugees and displaced families.", goalAmount: 8000, raisedAmount: 8000, status: "completed" },
  ].map((p, i) => ({
    ...p,
    organisationId: orgId,
    createdBy: adminId,
    images: programImages[i] || [],
    coverImageIndex: 0,
    followUpUpdates: p.status === "completed" ? [
      { text: "We've reached our goal! Thank you to all donors. Here's a look at the impact.", images: followUpImages, sentAt: pastDate(5) },
      { text: "Final distribution completed. 200 families received winter supplies.", images: [followUpImages[0]], sentAt: pastDate(2) },
    ] : p.raisedAmount > 1000 ? [
      { text: "Great progress! We've hit a major milestone. Construction has begun.", images: [followUpImages[1]], sentAt: pastDate(15) },
      { text: "Update: Phase 1 is 60% complete. Thank you for your continued support!", images: [], sentAt: pastDate(3) },
    ] : [],
    donors: [],
  }));
}

function generateOrders(orgId, donors, programs) {
  const orders = [];
  const types = ["Sadaqah", "Zakat ul Maal", "Zakat ul Fitr", "Education Fund", "Water Fund", "Food Fund", "Emergency Relief"];
  const methods = ["visa", "mastercard", "visa", "mastercard", "bank"];
  const statuses = ["completed", "completed", "completed", "completed", "pending"];

  // ── Spread single donations across 6 months (3-5 per month) ──
  for (let monthsAgo = 5; monthsAgo >= 0; monthsAgo--) {
    const count = 3 + Math.floor(Math.random() * 3); // 3-5 per month
    for (let j = 0; j < count; j++) {
      const donor = donors[(monthsAgo * 3 + j) % donors.length];
      const amount = [25, 50, 75, 100, 150, 200, 250, 500][Math.floor(Math.random() * 8)];
      const dayOffset = monthsAgo * 30 + Math.floor(Math.random() * 28);
      const prog = j === 0 && programs[monthsAgo % programs.length] ? programs[monthsAgo % programs.length] : null;
      orders.push({
        user: donor._id,
        organisationId: orgId,
        programId: prog?._id || null,
        donationId: nextDonationId(),
        items: [{ title: prog ? prog.title : types[j % types.length], price: amount, quantity: 1 }],
        paymentType: "single",
        donationType: types[(monthsAgo + j) % types.length],
        adminCostContribution: { included: j % 3 === 0, amount: j % 3 === 0 ? amount * 0.02 : 0 },
        donorDetails: { name: donor.name, phone: donor.phone, email: donor.email },
        paymentMethod: methods[(monthsAgo + j) % methods.length],
        paymentStatus: statuses[(monthsAgo + j) % statuses.length],
        totalAmount: amount + (j % 3 === 0 ? amount * 0.02 : 0),
        transactionDetails: {},
        createdAt: pastDate(dayOffset),
      });
    }
  }

  // ── Recurring donations (2 active, 1 ended) ──
  orders.push({
    user: donors[0]._id, organisationId: orgId, donationId: nextDonationId(),
    items: [{ title: "Monthly Support", price: 50, quantity: 1 }],
    paymentType: "recurring", donationType: "Sadaqah",
    adminCostContribution: { included: true, amount: 1 },
    donorDetails: { name: donors[0].name, phone: donors[0].phone, email: donors[0].email },
    paymentMethod: "visa", paymentStatus: "active", totalAmount: 51,
    recurringDetails: {
      frequency: "monthly", amount: 51, startDate: pastDate(150), endDate: futureDate(210),
      status: "active", nextPaymentDate: futureDate(10), totalPayments: 5,
      paymentHistory: [
        { date: pastDate(150), amount: 51, status: "succeeded" },
        { date: pastDate(120), amount: 51, status: "succeeded" },
        { date: pastDate(90), amount: 51, status: "succeeded" },
        { date: pastDate(60), amount: 51, status: "succeeded" },
        { date: pastDate(30), amount: 51, status: "succeeded" },
      ],
    },
    createdAt: pastDate(150),
  });
  orders.push({
    user: donors[2]._id, organisationId: orgId, donationId: nextDonationId(),
    items: [{ title: "Weekly Giving", price: 20, quantity: 1 }],
    paymentType: "recurring", donationType: "Sadaqah",
    adminCostContribution: { included: false, amount: 0 },
    donorDetails: { name: donors[2].name, phone: donors[2].phone, email: donors[2].email },
    paymentMethod: "mastercard", paymentStatus: "active", totalAmount: 20,
    recurringDetails: {
      frequency: "weekly", amount: 20, startDate: pastDate(60), endDate: futureDate(300),
      status: "active", nextPaymentDate: futureDate(3), totalPayments: 8,
      paymentHistory: Array.from({ length: 8 }, (_, i) => ({ date: pastDate(60 - i * 7), amount: 20, status: "succeeded" })),
    },
    createdAt: pastDate(60),
  });
  orders.push({
    user: donors[4]._id, organisationId: orgId, donationId: nextDonationId(),
    items: [{ title: "Yearly Pledge", price: 500, quantity: 1 }],
    paymentType: "recurring", donationType: "Zakat ul Maal",
    adminCostContribution: { included: true, amount: 10 },
    donorDetails: { name: donors[4].name, phone: donors[4].phone, email: donors[4].email },
    paymentMethod: "visa", paymentStatus: "ended", totalAmount: 510,
    recurringDetails: {
      frequency: "yearly", amount: 510, startDate: pastDate(400), endDate: pastDate(30),
      status: "ended", totalPayments: 1,
      paymentHistory: [{ date: pastDate(400), amount: 510, status: "succeeded" }],
    },
    createdAt: pastDate(400),
  });

  // ── Installment donations (2 active, 1 completed) ──
  orders.push({
    user: donors[1]._id, organisationId: orgId, donationId: nextDonationId(),
    items: [{ title: "Education Pledge", price: 300, quantity: 1 }],
    paymentType: "installments", donationType: "Education Fund",
    adminCostContribution: { included: true, amount: 6 },
    donorDetails: { name: donors[1].name, phone: donors[1].phone, email: donors[1].email },
    paymentMethod: "mastercard", paymentStatus: "active", totalAmount: 306,
    installmentDetails: {
      numberOfInstallments: 6, installmentAmount: 51, startDate: pastDate(120),
      status: "active", installmentsPaid: 4, nextInstallmentDate: futureDate(10),
      installmentHistory: Array.from({ length: 4 }, (_, i) => ({ installmentNumber: i + 1, date: pastDate(120 - i * 30), amount: 51, status: "completed" })),
      paymentIntervalDays: 30,
    },
    createdAt: pastDate(120),
  });
  orders.push({
    user: donors[3]._id, organisationId: orgId, donationId: nextDonationId(),
    items: [{ title: "Water Fund Installment", price: 600, quantity: 1 }],
    paymentType: "installments", donationType: "Water Fund",
    adminCostContribution: { included: false, amount: 0 },
    donorDetails: { name: donors[3].name, phone: donors[3].phone, email: donors[3].email },
    paymentMethod: "visa", paymentStatus: "active", totalAmount: 600,
    installmentDetails: {
      numberOfInstallments: 12, installmentAmount: 50, startDate: pastDate(90),
      status: "active", installmentsPaid: 3, nextInstallmentDate: futureDate(5),
      installmentHistory: Array.from({ length: 3 }, (_, i) => ({ installmentNumber: i + 1, date: pastDate(90 - i * 30), amount: 50, status: "completed" })),
      paymentIntervalDays: 30,
    },
    createdAt: pastDate(90),
  });
  orders.push({
    user: donors[0]._id, organisationId: orgId, donationId: nextDonationId(),
    items: [{ title: "Emergency Relief Installment", price: 180, quantity: 1 }],
    paymentType: "installments", donationType: "Emergency Relief",
    adminCostContribution: { included: true, amount: 3.6 },
    donorDetails: { name: donors[0].name, phone: donors[0].phone, email: donors[0].email },
    paymentMethod: "mastercard", paymentStatus: "completed", totalAmount: 183.6,
    installmentDetails: {
      numberOfInstallments: 3, installmentAmount: 61.2, startDate: pastDate(90),
      status: "completed", installmentsPaid: 3, nextInstallmentDate: null,
      installmentHistory: Array.from({ length: 3 }, (_, i) => ({ installmentNumber: i + 1, date: pastDate(90 - i * 30), amount: 61.2, status: "completed" })),
      paymentIntervalDays: 30,
    },
    createdAt: pastDate(90),
  });

  // ── A failed donation for realism ──
  orders.push({
    user: donors[3]._id, organisationId: orgId, donationId: nextDonationId(),
    items: [{ title: "General Donation", price: 100, quantity: 1 }],
    paymentType: "single", donationType: "Sadaqah",
    adminCostContribution: { included: false, amount: 0 },
    donorDetails: { name: donors[3].name, email: donors[3].email },
    paymentMethod: "visa", paymentStatus: "failed", totalAmount: 100,
    createdAt: pastDate(15),
  });

  return orders;
}

function generateContacts(orgId) {
  return [
    { fullName: "John Smith", email: "john@example.com", phoneNumber: "+61400111222", purpose: "Volunteer Inquiry", description: "I'd like to know more about volunteering opportunities." },
    { fullName: "Lisa Chen", email: "lisa@example.com", phoneNumber: "+61400333444", purpose: "Donation Question", description: "Can I donate via bank transfer?" },
    { fullName: "Omar Ali", email: "omar@example.com", phoneNumber: "+61400555666", purpose: "Partnership Proposal", description: "Our company would like to sponsor an event." },
  ].map((c) => ({ ...c, organisationId: orgId, status: "pending" }));
}

function generateVolunteers(orgId) {
  return [
    { firstName: "Alex", lastName: "Turner", email: "alex.t@example.com", phoneNumber: "+61400100001", age: 28, gender: "male", skills: "Web Development, Social Media", address: "10 King St, Sydney" },
    { firstName: "Priya", lastName: "Sharma", email: "priya.s@example.com", phoneNumber: "+61400100002", age: 24, gender: "female", skills: "Event Planning, Photography", address: "25 Queen St, Melbourne" },
    { firstName: "Daniel", lastName: "Park", email: "daniel.p@example.com", phoneNumber: "+61400100003", age: 32, gender: "male", skills: "Fundraising, Public Speaking", address: "8 Collins St, Brisbane" },
    { firstName: "Zara", lastName: "Mohammed", email: "zara.m@example.com", phoneNumber: "+61400100004", age: 19, gender: "female", skills: "Translation, Teaching", address: "42 Pitt St, Sydney" },
  ].map((v) => ({ ...v, organisationId: orgId, availableDays: ["Saturday", "Sunday"] }));
}

function generateNewsletterSubs(orgId) {
  const emails = [
    "subscriber1@example.com", "subscriber2@example.com", "subscriber3@example.com",
    "subscriber4@example.com", "subscriber5@example.com", "subscriber6@example.com",
    "subscriber7@example.com", "subscriber8@example.com", "subscriber9@example.com",
    "subscriber10@example.com",
  ];
  return emails.map((email) => ({ organisationId: orgId, email, status: "active", source: "website" }));
}

// ── Main seed function ──────────────────────────────────
async function seed() {
  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB\n");

  for (const key of Object.keys(ORGS)) {
    const org = ORGS[key];
    console.log(`\n━━━ Seeding ${org.name} (${org.slug}) ━━━`);

    // 1. Update admin user
    await User.findByIdAndUpdate(org.adminUserId, {
      name: `${org.name} Admin`,
      email: `admin@${org.slug}.org`,
      password: ADMIN_PW,
      role: "admin",
      organisationId: org._id,
      phone: "+61400000001",
    }, { upsert: true, new: true });
    console.log(`  ✓ Admin: admin@${org.slug}.org`);

    // 2. Donors
    const donors = generateDonors(org);
    for (const d of donors) {
      await User.findOneAndUpdate({ email: d.email }, d, { upsert: true, new: true });
    }
    // Re-fetch to get actual _ids
    const savedDonors = await User.find({ organisationId: org._id, role: "donor" }).lean();
    console.log(`  ✓ ${savedDonors.length} donors`);

    // 3. Donation types
    const dtData = generateDonationTypes(org._id);
    for (const dt of dtData) {
      await DonationType.findOneAndUpdate(
        { organisationId: dt.organisationId, donationType: dt.donationType },
        dt, { upsert: true }
      );
    }
    console.log(`  ✓ ${dtData.length} donation types`);

    // 4. Products
    const prodData = generateProducts(org._id);
    for (const p of prodData) {
      await Product.findOneAndUpdate({ organisationId: p.organisationId, slug: p.slug }, p, { upsert: true });
    }
    console.log(`  ✓ ${prodData.length} products`);

    // 5. Events
    const evtData = generateEvents(org._id);
    await Event.deleteMany({ organisationId: org._id });
    await Event.insertMany(evtData);
    console.log(`  ✓ ${evtData.length} events`);

    // 6. Programs
    const progData = generatePrograms(org._id, org.adminUserId);
    await Program.deleteMany({ organisationId: org._id });
    const savedPrograms = await Program.insertMany(progData);
    console.log(`  ✓ ${savedPrograms.length} programs`);

    // 7. Orders
    const orderData = generateOrders(org._id, savedDonors, savedPrograms);
    // Delete all seeded orders for this org, then insert with timestamps disabled to preserve createdAt
    await Order.deleteMany({ organisationId: org._id, donationId: /^D1/ });
    // Also delete old real-looking seed orders
    await Order.deleteMany({ organisationId: org._id, "transactionDetails.stripePaymentIntentId": /^pi_seed/ });
    await Order.collection.insertMany(orderData.map(o => ({
      ...o,
      updatedAt: o.createdAt, // set updatedAt same as createdAt
    })));
    console.log(`  ✓ ${orderData.length} orders`);

    // Update program donor arrays from orders
    for (const prog of savedPrograms) {
      const progOrders = orderData.filter((o) => o.programId && o.programId.equals(prog._id));
      if (progOrders.length > 0) {
        await Program.findByIdAndUpdate(prog._id, {
          $set: {
            donors: progOrders.map((o) => ({
              userId: o.user,
              email: o.donorDetails?.email,
            })),
          },
        });
      }
    }

    // 8. Contact requests
    const contactData = generateContacts(org._id);
    await ContactRequest.deleteMany({ organisationId: org._id });
    await ContactRequest.insertMany(contactData);
    console.log(`  ✓ ${contactData.length} contacts`);

    // 9. Volunteers
    const volData = generateVolunteers(org._id);
    await Join.deleteMany({ organisationId: org._id });
    await Join.insertMany(volData);
    console.log(`  ✓ ${volData.length} volunteers`);

    // 10. Newsletter subscribers
    const nlData = generateNewsletterSubs(org._id);
    for (const nl of nlData) {
      await Newsletter.findOneAndUpdate(
        { organisationId: nl.organisationId, email: nl.email },
        nl, { upsert: true }
      );
    }
    console.log(`  ✓ ${nlData.length} newsletter subscribers`);

    // 11. Payment methods for donors
    for (const donor of savedDonors.slice(0, 3)) {
      await PaymentMethod.findOneAndUpdate(
        { user: donor._id },
        {
          user: donor._id,
          type: "credit_card",
          cardNumber: "4242",
          cardType: "visa",
          expiryMonth: 12,
          expiryYear: 2028,
          isDefault: true,
          isActive: true,
        },
        { upsert: true }
      );
    }
    console.log(`  ✓ Payment methods for 3 donors`);
  }

  console.log("\n━━━ Seeding Complete ━━━");
  console.log("\nLogin credentials:");
  console.log("  HopeGive Admin:  admin@hopegive.org  / Admin@1234");
  console.log("  Calcite Admin:   admin@calcite.org   / Admin@1234");
  console.log("  All Donors:      {name}@{slug}.org   / Donor@1234");
  console.log("  (e.g., emily@hopegive.org, ahmed@calcite.org)\n");

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed error:", err);
  process.exit(1);
});
