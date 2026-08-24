#!/usr/bin/env node
/**
 * Reconcile reported MRR against what Stripe actually bills.
 *
 *   npm run audit:mrr
 *
 * The SuperAdmin dashboard and billing screen compute MRR from PLAN LIST PRICES
 * multiplied by subscriber counts. That is fast and needs no Stripe round-trip,
 * but it silently assumes every subscriber sits on their plan's current price —
 * and Stripe Prices are immutable, so every price edit leaves existing
 * subscribers behind on the old one. The two numbers drift apart with no signal
 * anywhere in the console.
 *
 * This walks the live subscriptions and prints, per tenant, what the dashboard
 * thinks they pay versus what Stripe is charging them. Read-only: it changes
 * nothing in Stripe or the database. Moving tenants onto current pricing is
 * `POST /superadmin/plans/:code/migrate-subscribers`, which is a real billing
 * action and stays a deliberate step.
 *
 * Exit code 1 when the totals disagree, so CI can watch it.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Organisation = require("../models/organisation");
const Plan = require("../models/plan");
const subscriptionMetrics = require("../services/subscriptionMetrics");
const platformStripe = require("../services/platformStripe");

const money = (n, ccy) => `${(n ?? 0).toFixed(2)} ${String(ccy || "").toUpperCase()}`;
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);

/** A Stripe recurring price expressed as a monthly amount. */
function monthlyFrom(price) {
  const amount = (price.unit_amount || 0) / 100;
  const { interval, interval_count: count = 1 } = price.recurring || {};
  switch (interval) {
    case "month":
      return amount / count;
    case "year":
      return amount / (12 * count);
    case "week":
      return (amount * 52) / (12 * count);
    case "day":
      return (amount * 365) / (12 * count);
    default:
      return null; // one-off / unknown cadence — cannot be an MRR contribution
  }
}

(async () => {
  await connectDB();
  await platformStripe.prime();

  if (!platformStripe.isStripeConfigured()) {
    console.error("Stripe is not configured — nothing to reconcile against.");
    process.exit(2);
  }
  const { stripe } = platformStripe;

  // ── what the console reports ─────────────────────────────────────────────
  const [facet, planDocs] = await Promise.all([
    Organisation.aggregate([subscriptionMetrics.orgFacet()]),
    Plan.find({ isActive: true }).sort({ sortOrder: 1 }).select("code name price color").lean(),
  ]);
  const reported = subscriptionMetrics.summarise(facet[0], planDocs);

  // ── what Stripe actually bills ───────────────────────────────────────────
  const subs = [];
  for await (const s of stripe.subscriptions.list({ status: "all", limit: 100, expand: ["data.items.data.price"] })) {
    if (["active", "trialing", "past_due"].includes(s.status)) subs.push(s);
  }

  const orgs = await Organisation.find({ stripeSubscriptionId: { $nin: [null, ""] } })
    .select("name slug plan billingCycle subscriptionStatus isComp stripeSubscriptionId override")
    .lean();
  const bySubId = Object.fromEntries(orgs.map((o) => [o.stripeSubscriptionId, o]));
  const planByCode = Object.fromEntries(planDocs.map((p) => [p.code, p]));

  const rows = [];
  const byCurrency = {};
  const oddCadence = [];
  const unattributed = [];

  for (const sub of subs) {
    const org = bySubId[sub.id];
    let actual = 0;
    let ccy = null;
    for (const item of sub.items.data) {
      const m = monthlyFrom(item.price);
      const qty = item.quantity || 1;
      if (m === null) {
        oddCadence.push(`${org?.slug || sub.id}: ${item.price.id} (${item.price.recurring?.interval || "one-off"})`);
        continue;
      }
      if (org && item.price.recurring?.interval && !["month", "year"].includes(item.price.recurring.interval)) {
        oddCadence.push(`${org.slug}: ${item.price.id} bills every ${item.price.recurring.interval}`);
      }
      actual += m * qty;
      ccy = item.price.currency;
    }

    if (!org) {
      // The platform Stripe account also carries donor recurring DONATIONS
      // (metadata.type === "recurring"). Those are tenant fundraising income,
      // not SaaS subscription revenue, and adding them to MRR would overstate
      // it by thousands — so they are reported separately, never summed in.
      unattributed.push({
        id: sub.id,
        kind: sub.metadata?.type === "recurring" || sub.metadata?.donorEmail ? "donor donation" : "unknown",
        who: sub.metadata?.donorEmail || sub.customer,
        monthly: actual,
        ccy,
        interval: sub.items.data[0]?.price?.recurring?.interval,
      });
      continue;
    }

    byCurrency[ccy] = (byCurrency[ccy] || 0) + actual;

    const plan = planByCode[org.plan];
    const cycle = org.billingCycle === "annual" ? "annual" : "monthly";
    const listed = plan ? (cycle === "annual" ? (plan.price?.annual || 0) / 12 : plan.price?.monthly || 0) : 0;
    const ov = org.override?.pricing || {};
    const overridden = cycle === "annual" ? (ov.annual != null ? ov.annual / 12 : null) : ov.monthly ?? null;
    const expected = org.isComp ? 0 : overridden ?? listed;

    rows.push({ tenant: org.slug, plan: org.plan, expected, actual, ccy, status: sub.status, comp: org.isComp });
  }

  // ── report ───────────────────────────────────────────────────────────────
  const totalActual = rows.reduce((s, r) => s + r.actual, 0);
  const drift = rows.filter((r) => Math.abs(r.expected - r.actual) > 0.01);

  console.log("\n\x1b[1mMRR reconciliation\x1b[0m  (SaaS subscriptions only)");
  console.log(`  reported by the console  : ${reported.mrr.toFixed(2)}  (plan list prices × subscribers)`);
  console.log(`  actually billed by Stripe: ${totalActual.toFixed(2)}  (${rows.length} tenant subscriptions)`);
  console.log(`  currencies in play       : ${Object.entries(byCurrency).map(([c, v]) => money(v, c)).join(" + ") || "none"}`);

  const currencies = Object.keys(byCurrency).filter(Boolean);
  if (currencies.length > 1) {
    console.log(
      `\n\x1b[33m  ! Tenant subscriptions span ${currencies.length} currencies. MRR sums raw numbers with\n` +
        "    no conversion, so the reported figure is not a meaningful total.\x1b[0m"
    );
  }
  if (oddCadence.length) {
    console.log(
      `\n\x1b[33m  ! ${oddCadence.length} tenant subscription item(s) bill on a cadence the MRR model has\n` +
        "    no branch for (it only knows monthly and annual):\x1b[0m"
    );
    [...new Set(oddCadence)].slice(0, 10).forEach((s) => console.log(`      ${s}`));
  }
  if (unattributed.length) {
    const donations = unattributed.filter((u) => u.kind === "donor donation");
    const unknown = unattributed.filter((u) => u.kind !== "donor donation");
    console.log(
      `\n  ${unattributed.length} live subscription(s) on the platform Stripe account belong to no tenant` +
        " —\n  excluded from the figures above:"
    );
    if (donations.length) {
      console.log(`    ${donations.length} donor recurring donation(s) — tenant fundraising, not SaaS revenue:`);
      donations.forEach((u) => console.log(`      ${pad(u.who, 34)}${money(u.monthly, u.ccy)}/mo (billed ${u.interval}ly)`));
    }
    if (unknown.length) {
      console.log(`\n\x1b[33m    ${unknown.length} subscription(s) with no tenant AND no donor metadata — someone is`);
      console.log("    being charged and nothing in the database explains why:\x1b[0m");
      unknown.forEach((u) => console.log(`      ${pad(u.id, 34)}${money(u.monthly, u.ccy)}/mo  cust=${u.who}`));
    }
  }

  if (drift.length) {
    console.log(`\n\x1b[31m${drift.length} tenant(s) are not billed what the console reports:\x1b[0m`);
    console.log(`  ${pad("TENANT", 26)}${pad("PLAN", 14)}${pad("REPORTED", 14)}${pad("STRIPE", 16)}STATUS`);
    for (const r of drift.sort((a, b) => Math.abs(b.expected - b.actual) - Math.abs(a.expected - a.actual))) {
      console.log(
        `  ${pad(r.tenant, 26)}${pad(r.plan, 14)}${pad(r.expected.toFixed(2), 14)}${pad(money(r.actual, r.ccy), 16)}${r.status}${r.comp ? " (comped)" : ""}`
      );
    }
    console.log(
      "\n  Stripe Prices are immutable, so a price edit leaves existing subscribers on\n" +
        "  the old Price. To move them: POST /superadmin/plans/<code>/migrate-subscribers\n" +
        "  — that re-bills real customers, so run it deliberately, per plan."
    );
  } else {
    console.log("\n\x1b[32mEvery tenant is billed exactly what the console reports.\x1b[0m");
  }

  await mongoose.disconnect();
  process.exit(drift.length || currencies.length > 1 ? 1 : 0);
})().catch(async (e) => {
  console.error("MRR audit failed:", e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(2);
});
