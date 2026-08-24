/**
 * scripts/diagnoseRegistration.js — WHY IS A NEW ORG STUCK ON "Setting up your organisation…"?
 *
 * Registration is two-phase: POST /api/saas/register creates the org with
 * isActive:false + a `pendingAdmin`, then the SaaS Stripe webhook
 * (invoice.paid / customer.subscription.updated) materialises the admin User and
 * flips isActive:true. /register/success polls GET /saas/organisations/status
 * for 60s and shows "Something went wrong" if the flag never turns on.
 *
 * So a stuck registration is almost always "the card was charged but the webhook
 * never landed" — typically because Stripe cannot reach localhost, or because
 * STRIPE_SAAS_WEBHOOK_SECRET does not match the endpoint that fired.
 *
 * This script asks Stripe what actually happened to each pending org's
 * subscription and prints the verdict.
 *
 *   node scripts/diagnoseRegistration.js                 (all non-active orgs)
 *   node scripts/diagnoseRegistration.js --org=donexus   (one org)
 *   node scripts/diagnoseRegistration.js --org=donexus --activate
 *        └─ activate the orgs whose FIRST INVOICE IS ACTUALLY PAID in Stripe
 *           (the same idempotent path the webhook uses — never invents a payment)
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Organisation = require("../models/organisation");
const User = require("../models/user");
// Console-configured key first, then STRIPE_SECRET_KEY — primed after connect.
const platformStripe = require("../services/platformStripe");
const stripe = platformStripe.stripe;
const { activateOrgWithAdmin } = require("../services/orgActivation");

const ORG_ARG = (process.argv.find((a) => a.startsWith("--org=")) || "").split("=")[1];
const ACTIVATE = process.argv.includes("--activate");

const line = () => console.log("─".repeat(78));
const kv = (k, v) => console.log(`   ${String(k).padEnd(24)} ${v ?? "—"}`);

async function main() {
  await connectDB();
  await platformStripe.prime(); // resolve console-configured credentials

  // Environment sanity — the two things that silently break activation.
  line();
  console.log("ENVIRONMENT");
  // Report what's ACTUALLY in use, not just what's in .env — keys can now come
  // from the SuperAdmin console, and a diagnostic that only reads env would say
  // "MISSING" while the server is billing perfectly well.
  const src = platformStripe.describeSource();
  kv(
    "Stripe secret key",
    src.configured
      ? `${src.mode.toUpperCase()} mode, from ${src.secretSource === "database" ? "the SuperAdmin console" : "STRIPE_SECRET_KEY"}`
      : "MISSING — set it in the console (Platform Settings → Stripe) or STRIPE_SECRET_KEY",
  );
  kv(
    "SaaS webhook secret",
    platformStripe.getSaasWebhookSecret()
      ? `set (from ${process.env.STRIPE_SAAS_WEBHOOK_SECRET && !src.webhookSource.includes("database") ? "env" : "the SuperAdmin console"})`
      : "MISSING — webhook will 400 on every event",
  );
  kv("CLIENT_URL", process.env.CLIENT_URL);

  const query = ORG_ARG ? { slug: ORG_ARG } : { $or: [{ isActive: false }, { subscriptionStatus: { $ne: "active" } }] };
  const orgs = await Organisation.find(query).sort({ createdAt: -1 }).limit(25);

  if (!orgs.length) {
    line();
    console.log(ORG_ARG ? `No organisation with slug "${ORG_ARG}".` : "No pending/inactive organisations. Nothing to diagnose.");
    return;
  }

  for (const org of orgs) {
    line();
    console.log(`ORG  ${org.name}  (/${org.slug})`);
    kv("created", org.createdAt?.toISOString());
    kv("isActive", org.isActive);
    kv("subscriptionStatus", org.subscriptionStatus);
    kv("plan / cycle", `${org.plan} / ${org.billingCycle}`);
    kv("adminUserId", org.adminUserId || "NOT CREATED YET");
    kv("pendingAdmin", org.pendingAdmin?.email || "—");
    kv("stripeCustomerId", org.stripeCustomerId);
    kv("stripeSubscriptionId", org.stripeSubscriptionId);

    if (!org.stripeSubscriptionId) {
      console.log("\n   VERDICT: no subscription was ever created — registration failed before Stripe.");
      continue;
    }

    let sub;
    try {
      sub = await stripe.subscriptions.retrieve(org.stripeSubscriptionId, { expand: ["latest_invoice.payment_intent"] });
    } catch (e) {
      console.log(`\n   VERDICT: Stripe rejected the subscription lookup — ${e.message}`);
      console.log("            (usually a TEST id being read with a LIVE key, or vice versa)");
      continue;
    }

    const inv = sub.latest_invoice;
    const pi = inv?.payment_intent;
    console.log("");
    kv("stripe sub status", sub.status);
    kv("latest invoice", `${inv?.id} — ${inv?.status} — paid=${inv?.paid}`);
    kv("payment intent", pi ? `${pi.id} — ${pi.status}` : "—");
    kv("amount paid", inv ? `${(inv.amount_paid / 100).toFixed(2)} ${String(inv.currency).toUpperCase()}` : "—");

    // Did Stripe ever attempt to deliver the activating events to us?
    try {
      const events = await stripe.events.list({ limit: 20 });
      const mine = events.data.filter((e) => JSON.stringify(e.data?.object || {}).includes(org.stripeSubscriptionId));
      kv("recent related events", mine.length ? mine.map((e) => e.type).join(", ") : "none in the last 20 account events");
    } catch {
      /* events list is best-effort */
    }

    // A paid invoice alone does NOT mean the org should be live — a cancelled
    // subscription keeps its last paid invoice forever. Both must hold.
    const paid = inv?.paid === true || pi?.status === "succeeded";
    const live = ["active", "trialing"].includes(sub.status);
    console.log("");
    if (org.isActive && org.adminUserId) {
      console.log("   VERDICT: healthy — org is active and has an admin user.");
    } else if (paid && !live) {
      console.log(`   VERDICT: paid once, but the subscription is now "${sub.status}".`);
      console.log("            Do NOT activate — this tenant needs a NEW subscription.");
      console.log("            (Most likely they paid, then it was cancelled in Stripe.)");
    } else if (paid && live) {
      console.log("   VERDICT: >>> PAID IN STRIPE BUT NOT ACTIVATED LOCALLY <<<");
      console.log("            The card was charged; the SaaS webhook never activated the org.");
      console.log("            Cause: Stripe could not deliver invoice.paid to this backend");
      console.log("            (localhost is unreachable from Stripe → run `stripe listen`),");
      console.log("            or STRIPE_SAAS_WEBHOOK_SECRET does not match the firing endpoint.");
      if (ACTIVATE) {
        await activateOrgWithAdmin(org, { subscriptionId: sub.id, customerId: sub.customer });
        const fresh = await Organisation.findById(org._id);
        const admin = fresh.adminUserId ? await User.findById(fresh.adminUserId) : null;
        console.log(`            ACTIVATED → isActive=${fresh.isActive}, admin=${admin?.email || "none"}`);
      } else {
        console.log("            Re-run with --activate to fix this org now.");
      }
    } else if (sub.status === "incomplete") {
      console.log("   VERDICT: the first invoice was never paid — the customer abandoned the");
      console.log("            card step, or the card was declined. Nothing to activate.");
    } else {
      console.log(`   VERDICT: subscription is "${sub.status}" and the invoice is "${inv?.status}" — not payable/paid.`);
    }
  }

  line();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close());
