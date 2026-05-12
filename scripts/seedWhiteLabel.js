/**
 * HopeGive Foundation — Comprehensive Database Seeding Script
 *
 * Seeds ALL collections with realistic data so every feature in the
 * admin and customer portals is fully testable.
 *
 * Before running, add WHITELABEL_MONGODB_URI to your .env file:
 *   WHITELABEL_MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/hopegive
 *
 * Run:  npm run seed:whitelabel
 *
 * Login credentials after seeding:
 *   Admin:  admin@hopegive.org     / Admin@1234
 *   Donors: emily@hopegive.org     / Donor@1234
 *           ahmed@hopegive.org     / Donor@1234
 *           sarah@hopegive.org     / Donor@1234
 *           faisal@hopegive.org    / Donor@1234
 *           maria@hopegive.org     / Donor@1234
 *           james@hopegive.org     / Donor@1234
 *           aisha@hopegive.org     / Donor@1234
 *           david@hopegive.org     / Donor@1234
 */

require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

// Import ALL existing models
const User = require("../models/user");
const Product = require("../models/product");
const Order = require("../models/order");
const Event = require("../models/event");
const DonationType = require("../models/donationtypes");
const Newsletter = require("../models/newsletter");
const ContactRequest = require("../models/contact");
const Join = require("../models/join");
const PaymentMethod = require("../models/paymentMethods");

const MONGODB_URI =
  process.env.WHITELABEL_MONGODB_URI || process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error(
    "ERROR: No MongoDB URI found. Set WHITELABEL_MONGODB_URI in your .env file."
  );
  process.exit(1);
}

// Helper: random date in last N days
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// Helper: random date in future N days
function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

async function seed() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB\n");

    // ── Clear ALL collections ────────────────────────────────────
    const collections = [User, Product, Order, Event, DonationType, Newsletter, ContactRequest, Join, PaymentMethod];
    await Promise.all(collections.map((M) => M.deleteMany({})));
    console.log("✓ Cleared all collections\n");

    // ══════════════════════════════════════════════════════════════
    // 1. USERS — 1 admin + 8 donors (varied profiles)
    // ══════════════════════════════════════════════════════════════
    const adminPw = await bcrypt.hash("Admin@1234", 10);
    const donorPw = await bcrypt.hash("Donor@1234", 10);

    const usersData = [
      {
        name: "Admin User", firstName: "Admin", lastName: "User",
        email: "admin@hopegive.org", password: adminPw, role: "admin",
        phone: "+61 400 000 000", country: "Australia",
        address: { street: "100 George St", city: "Sydney", state: "NSW", postalCode: "2000" },
      },
      {
        name: "Emily Richardson", firstName: "Emily", lastName: "Richardson",
        email: "emily@hopegive.org", password: donorPw, role: "user",
        phone: "+44 7700 900001", country: "United Kingdom",
        address: { street: "42 Kensington Lane", city: "London", state: "England", postalCode: "SW7 2BX" },
        currency: "GBP", language: "en",
      },
      {
        name: "Ahmed Al-Rashid", firstName: "Ahmed", lastName: "Al-Rashid",
        email: "ahmed@hopegive.org", password: donorPw, role: "user",
        phone: "+971 50 123 4567", country: "United Arab Emirates",
        address: { street: "Sheikh Zayed Road, Tower 5", city: "Dubai", state: "Dubai", postalCode: "00000" },
        currency: "AED", language: "ar",
      },
      {
        name: "Sarah Chen", firstName: "Sarah", lastName: "Chen",
        email: "sarah@hopegive.org", password: donorPw, role: "user",
        phone: "+1 212 555 0199", country: "United States",
        address: { street: "350 Fifth Avenue", city: "New York", state: "NY", postalCode: "10118" },
        currency: "USD", language: "en",
      },
      {
        name: "Faisal Mahmood", firstName: "Faisal", lastName: "Mahmood",
        email: "faisal@hopegive.org", password: donorPw, role: "user",
        phone: "+92 300 1234567", country: "Pakistan",
        address: { street: "Block 7, Clifton", city: "Karachi", state: "Sindh", postalCode: "75600" },
        currency: "PKR", language: "en",
      },
      {
        name: "Maria Santos", firstName: "Maria", lastName: "Santos",
        email: "maria@hopegive.org", password: donorPw, role: "user",
        phone: "+61 412 345 678", country: "Australia",
        address: { street: "88 Collins St", city: "Melbourne", state: "VIC", postalCode: "3000" },
        currency: "AUD", language: "en",
      },
      {
        name: "James Wright", firstName: "James", lastName: "Wright",
        email: "james@hopegive.org", password: donorPw, role: "user",
        phone: "+1 416 555 0100", country: "Canada",
        address: { street: "200 Bay St", city: "Toronto", state: "ON", postalCode: "M5J 2J5" },
        currency: "CAD", language: "en",
      },
      {
        name: "Aisha Khan", firstName: "Aisha", lastName: "Khan",
        email: "aisha@hopegive.org", password: donorPw, role: "user",
        phone: "+44 7911 123456", country: "United Kingdom",
        address: { street: "15 Oxford Road", city: "Manchester", state: "England", postalCode: "M1 5QA" },
        currency: "GBP", language: "en",
      },
      {
        name: "David Okonkwo", firstName: "David", lastName: "Okonkwo",
        email: "david@hopegive.org", password: donorPw, role: "user",
        phone: "+234 801 234 5678", country: "Nigeria",
        address: { street: "25 Marina", city: "Lagos", state: "Lagos", postalCode: "101001" },
        currency: "USD", language: "en",
      },
    ];

    const users = [];
    for (const data of usersData) {
      users.push(await new User(data).save());
    }
    const admin = users[0];
    const donors = users.slice(1);
    console.log(`✓ ${users.length} users (1 admin + ${donors.length} donors)`);

    // ══════════════════════════════════════════════════════════════
    // 2. DONATION TYPES — 8 types covering all categories
    // ══════════════════════════════════════════════════════════════
    const dtData = [
      { donationType: "Sadaqah" },
      { donationType: "Zakat ul Maal" },
      { donationType: "Zakat ul Fitr" },
      { donationType: "Education Fund" },
      { donationType: "Water Fund" },
      { donationType: "Food Fund" },
      { donationType: "Emergency Fund" },
      { donationType: "General Donation" },
    ];
    const donationTypes = await DonationType.insertMany(dtData);
    console.log(`✓ ${donationTypes.length} donation types`);
    const dtNames = donationTypes.map((d) => d.donationType);

    // ══════════════════════════════════════════════════════════════
    // 3. PRODUCTS — 12 products across all 4 categories
    // ══════════════════════════════════════════════════════════════
    const productsData = [
      // Education (3)
      { title: "Sponsor a Child's Education", description: "Fund one year of schooling for a child in an underserved community, covering books, uniform, and tuition.", price: 120, category: "education", image: "https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=400&q=80", isActive: true },
      { title: "School Supply Kit", description: "A complete kit with notebooks, pens, backpack, and learning materials for one student.", price: 35, category: "education", image: "https://images.unsplash.com/photo-1497633762265-9d179a990aa6?w=400&q=80", isActive: true },
      { title: "Teacher Training Program", description: "Help train local teachers with modern teaching methods and materials for an entire semester.", price: 250, category: "education", image: "https://images.unsplash.com/photo-1509062522246-3755977927d7?w=400&q=80", isActive: true },
      // Food (3)
      { title: "Feed a Family for a Month", description: "Provide a family of five with nutritious food supplies for an entire month.", price: 75, category: "food", image: "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?w=400&q=80", isActive: true },
      { title: "Emergency Food Pack", description: "An emergency food package with rice, lentils, oil, and essentials for one family.", price: 25, category: "food", image: "https://images.unsplash.com/photo-1593113598332-cd288d649433?w=400&q=80", isActive: true },
      { title: "Community Kitchen Sponsorship", description: "Sponsor a community kitchen serving 200 meals daily for one week.", price: 500, category: "food", image: "https://images.unsplash.com/photo-1578357078586-491adf1aa5ba?w=400&q=80", isActive: true },
      // Water (3)
      { title: "Build a Hand Pump", description: "Install a hand-operated water pump providing clean water to an entire village for years.", price: 300, category: "water", image: "https://images.unsplash.com/photo-1541544741938-0af808871cc0?w=400&q=80", isActive: true },
      { title: "Water Purification Tablets (1000)", description: "Provide 1000 water purification tablets enough to purify 10,000 litres of water.", price: 15, category: "water", image: "https://images.unsplash.com/photo-1594398901394-4e34939a4fd0?w=400&q=80", isActive: true },
      { title: "Solar Water Panel", description: "Fund a solar-powered water purification system for a remote school.", price: 450, category: "water", image: "https://images.unsplash.com/photo-1581888227599-779811939961?w=400&q=80", isActive: true },
      // Emergencies (3)
      { title: "Disaster Relief Kit", description: "Blankets, first-aid supplies, hygiene products, and emergency shelter materials for one family.", price: 50, category: "emergencies", image: "https://images.unsplash.com/photo-1469571486292-0ba58a3f068b?w=400&q=80", isActive: true },
      { title: "Emergency Medical Camp", description: "Fund a mobile medical camp providing free healthcare for 200+ people in a crisis zone.", price: 1000, category: "emergencies", image: "https://images.unsplash.com/photo-1532629345422-7515f3d16bb6?w=400&q=80", isActive: true },
      { title: "Rebuilding Hope Package", description: "Support post-disaster rebuilding with construction materials and labour for one home.", price: 750, category: "emergencies", image: "https://images.unsplash.com/photo-1559027615-cd4628902d4a?w=400&q=80", isActive: true },
    ];

    const products = [];
    for (const p of productsData) {
      products.push(await new Product(p).save());
    }
    console.log(`✓ ${products.length} products (3 per category)`);

    // ══════════════════════════════════════════════════════════════
    // 4. EVENTS — 8 events (4 upcoming, 2 ongoing, 2 completed)
    // ══════════════════════════════════════════════════════════════
    const eventsData = [
      { title: "Annual Gala Dinner", date: new Date("2026-12-15"), startTime: "18:00", endTime: "23:00", timezone: "GMT", location: { city: "London", venue: "The Grand Ballroom", address: "1 Park Lane, London W1K 1BE" }, description: "## Annual Gala Dinner 2026\n\nAn evening of elegance and philanthropy.\n\n**Highlights:**\n- Keynote by international humanitarian leaders\n- Live auction with exclusive items\n- Three-course dinner\n- Live entertainment\n\n**Dress Code:** Black tie\n**Capacity:** 200 guests\n\nAll proceeds go to our Education Fund.", imageUrl: "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800&q=80", registrationLink: "https://hopegive.org/events/gala", status: "upcoming" },
      { title: "Charity Marathon", date: new Date("2026-03-20"), startTime: "07:00", endTime: "14:00", timezone: "EST", location: { city: "New York", venue: "Central Park", address: "Central Park West, NY 10024" }, description: "## Charity Marathon 2026\n\nRun for a cause!\n\n**Distances:**\n- 5K Fun Run\n- 10K Challenge\n- Half Marathon\n\n**Registration includes:** T-shirt, medal, refreshments\n**Capacity:** 500 runners", imageUrl: "https://images.unsplash.com/photo-1452626038306-9aae5e071dd3?w=800&q=80", registrationLink: "https://hopegive.org/events/marathon", status: "upcoming" },
      { title: "Fundraising Auction", date: new Date("2026-06-08"), startTime: "19:00", endTime: "22:00", timezone: "GST", location: { city: "Dubai", venue: "Atlantis The Palm", address: "Crescent Road, Palm Jumeirah, Dubai" }, description: "## Exclusive Fundraising Auction\n\nBid on luxury items and unique experiences.\n\n**Featured items:**\n- Signed artwork from renowned artists\n- Luxury travel packages\n- Private dining experiences\n\n**Capacity:** 150 guests", imageUrl: "https://images.unsplash.com/photo-1511578314322-379afb476865?w=800&q=80", registrationLink: "https://hopegive.org/events/auction", status: "upcoming" },
      { title: "Youth Leadership Summit", date: new Date("2026-08-15"), startTime: "09:00", endTime: "17:00", timezone: "AEST", location: { city: "Sydney", venue: "International Convention Centre", address: "14 Darling Dr, Sydney NSW 2000" }, description: "## Youth Leadership Summit\n\nEmpowering the next generation of changemakers.\n\n**Sessions:**\n- Social entrepreneurship workshop\n- Panel discussions with NGO leaders\n- Networking lunch\n- Hackathon for social good\n\n**Ages:** 16-25\n**Capacity:** 300 attendees", imageUrl: "https://images.unsplash.com/photo-1552664730-d307ca884978?w=800&q=80", registrationLink: "https://hopegive.org/events/youth-summit", status: "upcoming" },
      { title: "Ramadan Food Drive", date: daysAgo(5), startTime: "09:00", endTime: "18:00", timezone: "PKT", location: { city: "Karachi", venue: "Community Center", address: "Block 7, Clifton, Karachi" }, description: "Ongoing Ramadan food distribution serving 500 families daily.", imageUrl: "https://images.unsplash.com/photo-1593113598332-cd288d649433?w=800&q=80", registrationLink: "https://hopegive.org/events/ramadan-drive", status: "ongoing" },
      { title: "Clean Water Campaign Launch", date: daysAgo(3), startTime: "10:00", endTime: "15:00", timezone: "EAT", location: { city: "Nairobi", venue: "UN Complex", address: "United Nations Avenue, Nairobi" }, description: "Launch event for our 2026 clean water initiative across East Africa.", imageUrl: "https://images.unsplash.com/photo-1541544741938-0af808871cc0?w=800&q=80", registrationLink: "https://hopegive.org/events/water-launch", status: "ongoing" },
      { title: "Community Food Drive 2025", date: new Date("2025-06-15"), startTime: "09:00", endTime: "16:00", timezone: "PKT", location: { city: "Karachi", venue: "Community Hall", address: "Block 7, Clifton, Karachi" }, description: "City-wide food collection and distribution drive that served 300 families.", imageUrl: "https://images.unsplash.com/photo-1593113598332-cd288d649433?w=800&q=80", registrationLink: "", status: "completed" },
      { title: "Awareness Walk 2025", date: new Date("2025-04-12"), startTime: "08:00", endTime: "12:00", timezone: "EST", location: { city: "Toronto", venue: "Nathan Phillips Square", address: "100 Queen St W, Toronto" }, description: "Community walk that raised awareness for children's education. Over 400 participants.", imageUrl: "https://images.unsplash.com/photo-1469571486292-0ba58a3f068b?w=800&q=80", registrationLink: "", status: "completed" },
    ];
    const events = await Event.insertMany(eventsData);
    console.log(`✓ ${events.length} events (4 upcoming, 2 ongoing, 2 completed)`);

    // ══════════════════════════════════════════════════════════════
    // 5. PAYMENT METHODS — 2 per donor (for user portal payment mgmt)
    // ══════════════════════════════════════════════════════════════
    const pmData = [];
    const cardTypes = ["visa", "mastercard"];
    donors.forEach((donor, i) => {
      pmData.push({
        user: donor._id,
        type: "credit_card",
        cardNumber: String(1000 + i * 111).slice(-4),
        cardType: cardTypes[i % 2],
        expiryMonth: ((i * 3) % 12) + 1,
        expiryYear: 2027,
        isDefault: true,
        isActive: true,
      });
      pmData.push({
        user: donor._id,
        type: "debit_card",
        cardNumber: String(5000 + i * 222).slice(-4),
        cardType: cardTypes[(i + 1) % 2],
        expiryMonth: ((i * 5) % 12) + 1,
        expiryYear: 2028,
        isDefault: false,
        isActive: true,
      });
    });
    const paymentMethods = await PaymentMethod.insertMany(pmData);
    console.log(`✓ ${paymentMethods.length} payment methods (2 per donor)`);

    // ══════════════════════════════════════════════════════════════
    // 6. ORDERS — 30 orders covering all payment types and statuses
    // ══════════════════════════════════════════════════════════════
    const ordersData = [];
    let orderCounter = 1;

    // --- 6a. 15 single/completed donations (spread across donors & types) ---
    for (let i = 0; i < 15; i++) {
      const donor = donors[i % donors.length];
      const amount = [25, 50, 75, 100, 150, 200, 250, 300, 500][i % 9];
      const dt = dtNames[i % dtNames.length];
      const product = products[i % products.length];
      const age = Math.floor(Math.random() * 170) + 10; // 10-180 days ago

      ordersData.push({
        user: donor._id,
        donationId: `DON-${String(orderCounter++).padStart(5, "0")}`,
        items: [{ title: product.title, price: amount, quantity: 1 }],
        paymentType: "single",
        donationType: dt,
        adminCostContribution: { included: i % 3 === 0, amount: i % 3 === 0 ? Math.round(amount * 0.05) : 0 },
        donorDetails: {
          name: donor.name, phone: donor.phone, email: donor.email,
          address: donor.address || {},
          agreeToMessages: i % 2 === 0,
        },
        paymentMethod: ["visa", "mastercard", "card", "bank"][i % 4],
        paymentStatus: "completed",
        totalAmount: amount + (i % 3 === 0 ? Math.round(amount * 0.05) : 0),
        createdAt: daysAgo(age),
      });
    }

    // --- 6b. 3 single/pending donations ---
    for (let i = 0; i < 3; i++) {
      const donor = donors[i + 2];
      ordersData.push({
        user: donor._id,
        donationId: `DON-${String(orderCounter++).padStart(5, "0")}`,
        items: [{ title: "Pending Donation", price: [30, 60, 100][i], quantity: 1 }],
        paymentType: "single",
        donationType: dtNames[i],
        donorDetails: { name: donor.name, phone: donor.phone, email: donor.email, address: donor.address || {} },
        paymentMethod: "bank",
        paymentStatus: "pending",
        totalAmount: [30, 60, 100][i],
        createdAt: daysAgo(i + 1),
      });
    }

    // --- 6c. 6 recurring/active subscriptions (visible in subscription mgmt) ---
    const recurringConfigs = [
      { donorIdx: 0, amount: 25, freq: "monthly", dt: 0 },
      { donorIdx: 1, amount: 50, freq: "monthly", dt: 1 },
      { donorIdx: 2, amount: 100, freq: "monthly", dt: 3 },
      { donorIdx: 3, amount: 10, freq: "weekly", dt: 4 },
      { donorIdx: 4, amount: 75, freq: "monthly", dt: 5 },
      { donorIdx: 5, amount: 30, freq: "yearly", dt: 7 },
    ];
    recurringConfigs.forEach((cfg) => {
      const donor = donors[cfg.donorIdx];
      const start = daysAgo(90);
      const history = [];
      for (let p = 0; p < 3; p++) {
        const payDate = new Date(start);
        payDate.setMonth(payDate.getMonth() + p);
        history.push({ date: payDate, amount: cfg.amount, invoiceId: `INV-R${orderCounter}-${p + 1}`, status: "succeeded" });
      }
      ordersData.push({
        user: donor._id,
        donationId: `DON-${String(orderCounter++).padStart(5, "0")}`,
        items: [{ title: `${cfg.freq} - ${dtNames[cfg.dt]}`, price: cfg.amount, quantity: 1 }],
        paymentType: "recurring",
        donationType: dtNames[cfg.dt],
        donorDetails: { name: donor.name, phone: donor.phone, email: donor.email, address: donor.address || {} },
        paymentMethod: "visa",
        paymentStatus: "active",
        totalAmount: cfg.amount,
        recurringDetails: {
          frequency: cfg.freq,
          amount: cfg.amount,
          startDate: start,
          status: "active",
          nextPaymentDate: daysFromNow(15),
          totalPayments: 3,
          paymentHistory: history,
        },
        createdAt: start,
      });
    });

    // --- 6d. 2 cancelled subscriptions ---
    for (let i = 0; i < 2; i++) {
      const donor = donors[i + 6];
      const start = daysAgo(180);
      ordersData.push({
        user: donor._id,
        donationId: `DON-${String(orderCounter++).padStart(5, "0")}`,
        items: [{ title: `Monthly - ${dtNames[i + 2]}`, price: [40, 60][i], quantity: 1 }],
        paymentType: "recurring",
        donationType: dtNames[i + 2],
        donorDetails: { name: donor.name, phone: donor.phone, email: donor.email, address: donor.address || {} },
        paymentMethod: "mastercard",
        paymentStatus: "cancelled",
        totalAmount: [40, 60][i],
        recurringDetails: {
          frequency: "monthly",
          amount: [40, 60][i],
          startDate: start,
          status: "cancelled",
          totalPayments: 4,
          paymentHistory: [
            { date: start, amount: [40, 60][i], invoiceId: `INV-C${i + 1}-1`, status: "succeeded" },
            { date: daysAgo(150), amount: [40, 60][i], invoiceId: `INV-C${i + 1}-2`, status: "succeeded" },
            { date: daysAgo(120), amount: [40, 60][i], invoiceId: `INV-C${i + 1}-3`, status: "succeeded" },
            { date: daysAgo(90), amount: [40, 60][i], invoiceId: `INV-C${i + 1}-4`, status: "succeeded" },
          ],
        },
        cancellationDetails: { date: daysAgo(85), reason: ["Financial reasons", "Moving to another charity"][i] },
        createdAt: start,
      });
    }

    // --- 6e. 2 pending_cancellation (for cancellation requests admin screen) ---
    for (let i = 0; i < 2; i++) {
      const donor = donors[i + 3];
      const start = daysAgo(120);
      ordersData.push({
        user: donor._id,
        donationId: `DON-${String(orderCounter++).padStart(5, "0")}`,
        items: [{ title: `Monthly - ${dtNames[i + 4]}`, price: [20, 45][i], quantity: 1 }],
        paymentType: "recurring",
        donationType: dtNames[i + 4],
        donorDetails: { name: donor.name, phone: donor.phone, email: donor.email, address: donor.address || {} },
        paymentMethod: "visa",
        paymentStatus: "pending_cancellation",
        totalAmount: [20, 45][i],
        recurringDetails: {
          frequency: "monthly",
          amount: [20, 45][i],
          startDate: start,
          status: "active",
          totalPayments: 3,
          paymentHistory: [
            { date: start, amount: [20, 45][i], invoiceId: `INV-PC${i + 1}-1`, status: "succeeded" },
            { date: daysAgo(90), amount: [20, 45][i], invoiceId: `INV-PC${i + 1}-2`, status: "succeeded" },
            { date: daysAgo(60), amount: [20, 45][i], invoiceId: `INV-PC${i + 1}-3`, status: "succeeded" },
          ],
        },
        cancellationDetails: { date: daysAgo(5), reason: ["Want to change amount", "Temporary pause needed"][i] },
        createdAt: start,
      });
    }

    // --- 6f. 2 installment orders ---
    for (let i = 0; i < 2; i++) {
      const donor = donors[i];
      const start = daysAgo(60);
      const totalAmt = [600, 1200][i];
      const numInstallments = [6, 12][i];
      const instAmt = totalAmt / numInstallments;
      const instHistory = [];
      for (let p = 0; p < 2; p++) {
        const payDate = new Date(start);
        payDate.setMonth(payDate.getMonth() + p);
        instHistory.push({ installmentNumber: p + 1, date: payDate, amount: instAmt, status: "completed", transactionId: `TXN-I${i + 1}-${p + 1}` });
      }
      ordersData.push({
        user: donor._id,
        donationId: `DON-${String(orderCounter++).padStart(5, "0")}`,
        items: [{ title: products[i + 6].title, price: totalAmt, quantity: 1 }],
        paymentType: "installments",
        donationType: dtNames[i + 4],
        donorDetails: { name: donor.name, phone: donor.phone, email: donor.email, address: donor.address || {} },
        paymentMethod: "visa",
        paymentStatus: "active",
        totalAmount: totalAmt,
        installmentDetails: {
          numberOfInstallments: numInstallments,
          installmentAmount: instAmt,
          startDate: start,
          status: "active",
          installmentsPaid: 2,
          nextInstallmentDate: daysFromNow(5),
          installmentHistory: instHistory,
          paymentIntervalDays: 30,
        },
        createdAt: start,
      });
    }

    const orders = await Order.insertMany(ordersData);
    console.log(`✓ ${orders.length} orders:`);
    console.log(`    15 single/completed, 3 single/pending`);
    console.log(`    6 recurring/active, 2 recurring/cancelled, 2 pending_cancellation`);
    console.log(`    2 installment/active`);

    // ══════════════════════════════════════════════════════════════
    // 7. CONTACT REQUESTS — 6 (mix of statuses, for admin contacts screen)
    // ══════════════════════════════════════════════════════════════
    const contactsData = [
      { fullName: "John Parker", phoneNumber: "+1 555 0101", email: "john.parker@email.com", purpose: "General", description: "I would like to learn more about your education programs and how I can get involved as a mentor.", status: "pending", createdAt: daysAgo(2) },
      { fullName: "Lisa Thompson", phoneNumber: "+44 7800 111222", email: "lisa.t@email.com", purpose: "General", description: "Can you send me the annual report and financial transparency documents?", status: "pending", createdAt: daysAgo(5) },
      { fullName: "Omar Hassan", phoneNumber: "+971 55 9998877", email: "omar.h@email.com", purpose: "Collaborate with us", description: "Our company would like to partner for a corporate donation matching program.", hostCity: "Dubai", numberOfGuests: 50, minimumDonation: 5000, status: "pending", createdAt: daysAgo(3) },
      { fullName: "Rachel Kim", phoneNumber: "+82 10 1234 5678", email: "rachel.kim@email.com", purpose: "General", description: "I'm a journalist writing about charitable organisations in Australia. Can I schedule an interview?", status: "reviewed", createdAt: daysAgo(15) },
      { fullName: "Michael Brown", phoneNumber: "+1 312 555 0199", email: "m.brown@corp.com", purpose: "Collaborate with us", description: "Interested in hosting a charity event in Chicago. We have a venue that seats 300.", hostCity: "Chicago", numberOfGuests: 300, minimumDonation: 10000, status: "reviewed", createdAt: daysAgo(20) },
      { fullName: "Priya Sharma", phoneNumber: "+91 98765 43210", email: "priya.s@email.com", purpose: "General", description: "Thank you for the wonderful work. I wanted to share how your clean water project changed our village.", status: "responded", createdAt: daysAgo(30) },
    ];
    const contacts = await ContactRequest.insertMany(contactsData);
    console.log(`✓ ${contacts.length} contact requests (3 pending, 2 reviewed, 1 responded)`);

    // ══════════════════════════════════════════════════════════════
    // 8. VOLUNTEER / JOIN REQUESTS — 8 (for admin volunteers screen)
    // ══════════════════════════════════════════════════════════════
    const joinData = [
      { firstName: "Alex", lastName: "Turner", email: "alex.t@email.com", phoneNumber: "+61 400 111 222", age: 28, gender: "Male", address: "45 Pitt St, Sydney NSW 2000", skills: "Event management, Public speaking, Social media marketing", availableDays: ["Saturday", "Sunday"] },
      { firstName: "Sophie", lastName: "Dupont", email: "sophie.d@email.com", phoneNumber: "+33 6 12 34 56 78", age: 24, gender: "Female", address: "12 Rue de Rivoli, Paris 75001", skills: "Graphic design, Photography, Web development", availableDays: ["Monday", "Wednesday", "Friday"] },
      { firstName: "Raj", lastName: "Patel", email: "raj.p@email.com", phoneNumber: "+91 98765 00001", age: 32, gender: "Male", address: "MG Road, Bangalore 560001", skills: "Medical assistance, First aid, Translation (Hindi/English)", availableDays: ["Tuesday", "Thursday", "Saturday"] },
      { firstName: "Emma", lastName: "Wilson", email: "emma.w@email.com", phoneNumber: "+44 7700 900100", age: 22, gender: "Female", address: "10 Downing Lane, London SE1", skills: "Teaching, Tutoring, Curriculum development", availableDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] },
      { firstName: "Yusuf", lastName: "Ali", email: "yusuf.a@email.com", phoneNumber: "+92 333 1234567", age: 35, gender: "Male", address: "DHA Phase 5, Lahore", skills: "Logistics, Supply chain management, Warehouse operations", availableDays: ["Saturday", "Sunday"] },
      { firstName: "Chen", lastName: "Wei", email: "chen.w@email.com", phoneNumber: "+86 138 0013 8000", age: 27, gender: "Male", address: "Pudong District, Shanghai", skills: "Data analysis, Financial planning, Grant writing", availableDays: ["Wednesday", "Saturday"] },
      { firstName: "Amira", lastName: "Khalil", email: "amira.k@email.com", phoneNumber: "+20 100 123 4567", age: 29, gender: "Female", address: "Zamalek, Cairo 11211", skills: "Counselling, Community outreach, Fundraising", availableDays: ["Monday", "Thursday", "Saturday"] },
      { firstName: "Lucas", lastName: "Miller", email: "lucas.m@email.com", phoneNumber: "+1 647 555 0123", age: 31, gender: "Male", address: "200 University Ave, Toronto ON", skills: "Construction, Plumbing, Electrical work", availableDays: ["Friday", "Saturday", "Sunday"] },
    ];
    const volunteers = await Join.insertMany(joinData);
    console.log(`✓ ${volunteers.length} volunteer/join requests`);

    // ══════════════════════════════════════════════════════════════
    // 9. NEWSLETTER SUBSCRIBERS — 20
    // ══════════════════════════════════════════════════════════════
    const nlData = [
      "subscriber1@example.com", "donor.updates@gmail.com", "charity.fan@outlook.com",
      "give.back@yahoo.com", "hope.supporter@gmail.com", "community.hero@hotmail.com",
      "change.maker@gmail.com", "global.impact@outlook.com", "kind.hearts@gmail.com",
      "future.bright@yahoo.com", "helping.hand@gmail.com", "world.changer@outlook.com",
      "impact.daily@gmail.com", "hearts.united@yahoo.com", "give.more@hotmail.com",
      "better.world@gmail.com", "hope.rising@outlook.com", "charity.love@gmail.com",
      "peace.builder@yahoo.com", "kind.soul@hotmail.com",
    ].map((email) => ({ email, status: "active", source: "website" }));
    const newsletters = await Newsletter.insertMany(nlData);
    console.log(`✓ ${newsletters.length} newsletter subscribers`);

    // ══════════════════════════════════════════════════════════════
    // SUMMARY
    // ══════════════════════════════════════════════════════════════
    console.log("\n" + "═".repeat(55));
    console.log("  ✅ SEEDING COMPLETE — Full database ready");
    console.log("═".repeat(55));
    console.log(`  Users:            ${users.length} (1 admin + ${donors.length} donors)`);
    console.log(`  Donation Types:   ${donationTypes.length}`);
    console.log(`  Products:         ${products.length} (3 per category)`);
    console.log(`  Events:           ${events.length} (4 upcoming, 2 ongoing, 2 past)`);
    console.log(`  Payment Methods:  ${paymentMethods.length} (2 per donor)`);
    console.log(`  Orders/Donations: ${orders.length}`);
    console.log(`  Contact Requests: ${contacts.length}`);
    console.log(`  Volunteers:       ${volunteers.length}`);
    console.log(`  Newsletter:       ${newsletters.length}`);
    console.log("═".repeat(55));
    console.log("\n  Admin login:  admin@hopegive.org / Admin@1234");
    console.log("  Donor login:  emily@hopegive.org / Donor@1234\n");

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Seeding failed:", error.message);
    console.error(error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

seed();
