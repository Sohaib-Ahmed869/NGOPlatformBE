/**
 * scripts/seedDemoData.js  — DEMO / DEV DATA
 *
 * Populates realistic data for the SuperAdmin Billing / Invoices / Coupons
 * screens so they aren't empty in a demo:
 *   1. Gives the (test) organisations a realistic plan MIX (basic/pro/enterprise).
 *   2. Seeds a set of discount coupons (display-synced placeholders).
 *   3. Seeds ~6 months of platform invoices per org (mostly paid, a few open/failed).
 *
 * Idempotent: re-running replaces the seeded coupons + invoices (matched by
 * `in_seed_*` / the coupon codes). It does NOT touch real Stripe objects.
 *
 *   node scripts/seedDemoData.js        (or: npm run seed:demo)
 *
 * Reverting the plan mix: set every org back to one tier, e.g. in mongosh
 *   db.organisations.updateMany({}, { $set: { plan: "professional" } })
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Organisation = require("../models/organisation");
const Coupon = require("../models/coupon");
const PlatformInvoice = require("../models/platformInvoice");

const PLAN_PRICE = { basic: 200, professional: 500, enterprise: 1000 };

// A realistic distribution — the obvious throwaway test orgs go on basic.
const PLAN_BY_SLUG = {
  testing: "basic",
  logotest: "basic",
  testcharity: "basic",
  matw2: "professional",
  "shahid-afridi-foundation": "professional",
  calcite: "professional",
  hopegive: "professional",
  matw: "enterprise",
};

const DAY = 86400000;
const COUPONS = [
  { code: "LAUNCH25", description: "25% off your first 3 months", type: "percent", value: 25, duration: "repeating", durationInMonths: 3, planCodes: [], maxRedemptions: 100, timesRedeemed: 23, redeemBy: new Date(Date.now() + 90 * DAY), isActive: true },
  { code: "CHARITY50", description: "50% off for registered charities", type: "percent", value: 50, duration: "forever", durationInMonths: null, planCodes: ["professional", "enterprise"], maxRedemptions: null, timesRedeemed: 8, redeemBy: null, isActive: true },
  { code: "ANNUAL100", description: "$100 off an annual subscription", type: "amount", value: 100, duration: "once", planCodes: ["professional", "enterprise"], maxRedemptions: null, timesRedeemed: 14, redeemBy: null, isActive: true },
  { code: "WELCOME10", description: "10% off your first month", type: "percent", value: 10, duration: "once", planCodes: [], maxRedemptions: 500, timesRedeemed: 67, redeemBy: null, isActive: true },
  { code: "BLACKFRIDAY30", description: "30% off — Black Friday (expired)", type: "percent", value: 30, duration: "once", planCodes: [], maxRedemptions: 200, timesRedeemed: 41, redeemBy: new Date(Date.now() - 30 * DAY), isActive: false, archivedAt: new Date(Date.now() - 20 * DAY) },
];

const rand = (n) => Math.floor(Math.random() * n);

async function run() {
  console.log("\n=== Seeding demo billing data ===\n");

  // ── 1. Realistic plan mix ──
  const orgs = await Organisation.find().select("name slug plan stripeCustomerId stripeSubscriptionId");
  for (const org of orgs) {
    const target = PLAN_BY_SLUG[org.slug] || "professional";
    if (org.plan !== target) {
      console.log(`  plan: ${org.slug.padEnd(24)} ${org.plan} → ${target}`);
      org.plan = target;
      await org.save();
    }
  }

  // ── 2. Coupons (idempotent) ──
  const codes = COUPONS.map((c) => c.code);
  await Coupon.deleteMany({ code: { $in: codes } });
  await Coupon.insertMany(
    COUPONS.map((c) => ({
      ...c,
      currency: "usd",
      stripeCouponId: `co_seed_${c.code}`,
      stripePromotionCodeId: `promo_seed_${c.code}`,
    })),
  );
  console.log(`\n  ✓ ${COUPONS.length} coupons seeded`);

  // ── 3. Invoices (idempotent) ──
  await PlatformInvoice.deleteMany({ stripeInvoiceId: { $regex: "^in_seed_" } });
  const now = new Date();
  const docs = [];
  let num = 1000;
  for (const org of orgs) {
    const price = PLAN_PRICE[org.plan] || 500;
    const months = 5 + rand(2); // 5–6 months of history
    for (let i = months; i >= 0; i--) {
      const periodStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const periodEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      let status = "paid";
      if (i === 0 && Math.random() < 0.3) status = Math.random() < 0.5 ? "open" : "failed";
      num += 1;
      const id = `in_seed_${org.slug}_${i}`;
      docs.push({
        _id: new mongoose.Types.ObjectId(),
        organisationId: org._id,
        stripeInvoiceId: id,
        stripeCustomerId: org.stripeCustomerId || `cus_seed_${org.slug}`,
        stripeSubscriptionId: org.stripeSubscriptionId || "",
        number: `INV-${num}`,
        amountDue: price,
        amountPaid: status === "paid" ? price : 0,
        currency: "usd",
        status,
        hostedInvoiceUrl: `https://invoice.stripe.com/i/seed/${id}`,
        invoicePdf: `https://invoice.stripe.com/i/seed/${id}/pdf`,
        periodStart,
        periodEnd,
        paidAt: status === "paid" ? periodStart : null,
        createdAt: periodStart,
        updatedAt: periodStart,
      });
    }
  }
  await PlatformInvoice.collection.insertMany(docs);
  const collected = docs.filter((d) => d.status === "paid").reduce((s, d) => s + d.amountPaid, 0);
  console.log(`  ✓ ${docs.length} invoices seeded ($${collected.toLocaleString()} collected)`);

  console.log("\nDone.\n");
}

(async () => {
  try {
    await connectDB();
    await run();
  } catch (err) {
    console.error("Seed demo failed:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
})();
