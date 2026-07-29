/**
 * scripts/auditStripeCustomers.js — SAVED-CARD / STRIPE CUSTOMER AUDIT
 *
 * Answers "why did this donation die with `No such customer: cus_...`?".
 *
 * Stripe customer + payment-method ids are scoped to ONE Stripe account, and
 * each tenant charges on their own keys. A stored id therefore goes stale when:
 *   • the customer was deleted in the Stripe dashboard (or test data was wiped)
 *   • the tenant swapped their Stripe keys (or turned their own account on/off,
 *     flipping donations between the tenant and the platform account)
 *   • the card was vaulted on one account and replayed against another
 *
 * For every organisation this checks — against THAT tenant's Stripe account —
 * each donor's `User.stripeCustomerId` and each saved card's
 * `PaymentMethod.{stripeCustomerId,stripePaymentMethodId}`, and classifies what
 * is wrong.
 *
 *   node scripts/auditStripeCustomers.js              (read-only report)
 *   node scripts/auditStripeCustomers.js --fix        (repair what it finds)
 *   node scripts/auditStripeCustomers.js --org=slug   (one tenant only)
 *
 * --fix is idempotent and never touches money. It only:
 *   • clears a User.stripeCustomerId that no longer exists
 *   • repoints a card row at the customer its PM is actually attached to
 *   • re-vaults an orphaned PM on a fresh customer for that donor
 *   • deactivates a card whose Stripe payment method is gone (donor re-adds it)
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Organisation = require("../models/organisation");
const User = require("../models/user");
const PaymentMethod = require("../models/paymentMethods");
const { getTenantStripe, isPaymentConfigured } = require("../services/tenantStripe");

const FIX = process.argv.includes("--fix");
const ORG_ARG = (process.argv.find((a) => a.startsWith("--org=")) || "").split("=")[1];

const pad = (s, n) => String(s ?? "").padEnd(n);
const tally = {};
const bump = (k) => (tally[k] = (tally[k] || 0) + 1);
const fixes = [];

/** Which Stripe account do this tenant's keys point at? */
async function accountLabel(stripe, org) {
  const source = isPaymentConfigured(org) ? "tenant keys" : "PLATFORM fallback";
  try {
    const acct = await stripe.accounts.retrieve();
    return `${acct.id} (${source})`;
  } catch (e) {
    return `<account lookup failed: ${e.message}> (${source})`;
  }
}

/** Retire a card the donor can no longer be charged on (they must re-add it). */
async function retireCard(card) {
  card.isActive = false;
  card.isDefault = false;
  await card.save();
  if (card.user?._id) {
    await User.updateOne(
      { _id: card.user._id, defaultPaymentMethod: card._id },
      { $unset: { defaultPaymentMethod: 1 } },
    );
  }
}

async function retrieveCustomer(stripe, id) {
  if (!id) return { state: "none" };
  try {
    const c = await stripe.customers.retrieve(id);
    if (!c || c.deleted) return { state: "deleted" };
    return { state: "live", customer: c };
  } catch (e) {
    return { state: e.code === "resource_missing" ? "missing" : "error", error: e.message };
  }
}

async function retrievePaymentMethod(stripe, id) {
  if (!id) return { state: "none" };
  try {
    return { state: "live", pm: await stripe.paymentMethods.retrieve(id) };
  } catch (e) {
    return { state: e.code === "resource_missing" ? "missing" : "error", error: e.message };
  }
}

async function auditOrg(org) {
  const stripe = getTenantStripe(org);
  const account = await accountLabel(stripe, org);

  const users = await User.find({
    organisationId: org._id,
    stripeCustomerId: { $nin: ["", null] },
  }).select("name email stripeCustomerId organisationId");

  // Retired cards (isActive:false) are already out of the donor's wallet — they
  // can't fail a charge, so they'd only be permanent noise. --all includes them.
  const cards = await PaymentMethod.find({
    ...(process.argv.includes("--all") ? {} : { isActive: true }),
    $or: [{ organisationId: org._id }, { organisationId: null, user: { $in: users.map((u) => u._id) } }],
  }).populate("user", "name email stripeCustomerId organisationId");

  if (!users.length && !cards.length) return;

  console.log(`\n── ${org.name} (${org.slug})`);
  console.log(`   Stripe account: ${account}`);

  // ── Donor customers ──
  for (const user of users) {
    const res = await retrieveCustomer(stripe, user.stripeCustomerId);
    if (res.state === "live") {
      bump("customer ok");
      continue;
    }
    bump(`customer ${res.state}`);
    console.log(
      `   ✗ ${pad(user.email, 34)} User.stripeCustomerId ${user.stripeCustomerId} → ${res.state}${res.error ? ` (${res.error})` : ""}`,
    );
    if (FIX) {
      await User.updateOne({ _id: user._id }, { $set: { stripeCustomerId: "" } });
      fixes.push(`cleared stale customer on ${user.email}`);
    }
  }

  // ── Saved cards ──
  for (const card of cards) {
    const who = card.user?.email || String(card.user?._id || card.user);
    const label = `${card.brand || card.cardType || "card"} ••${card.cardNumber || "????"}`;
    const pmRes = await retrievePaymentMethod(stripe, card.stripePaymentMethodId);

    if (pmRes.state !== "live") {
      bump(`card PM ${pmRes.state}`);
      console.log(
        `   ✗ ${pad(who, 34)} ${pad(label, 18)} payment method ${card.stripePaymentMethodId || "<none>"} → ${pmRes.state}`,
      );
      if (FIX && card.isActive) {
        await retireCard(card);
        fixes.push(`deactivated unusable card ${label} for ${who}`);
      }
      continue;
    }

    const attached = pmRes.pm.customer || null;
    const custRes = await retrieveCustomer(stripe, card.stripeCustomerId);

    // Backfill card metadata straight from Stripe while we have the PM in hand
    // (rows saved before brand/last4 were captured render as "Card •••• ????").
    const pmCard = pmRes.pm.card || {};
    if (FIX && pmCard.last4 && card.cardNumber !== pmCard.last4) {
      card.brand = pmCard.brand || card.brand;
      card.cardNumber = pmCard.last4;
      card.expiryMonth = pmCard.exp_month;
      card.expiryYear = pmCard.exp_year;
      await card.save();
      fixes.push(`backfilled card details for ${who} (${pmCard.brand} ••${pmCard.last4})`);
    }

    if (attached && attached === card.stripeCustomerId && custRes.state === "live") {
      bump("card ok");
      continue;
    }

    // Work out (and report) exactly which way the row is wrong.
    let why;
    if (!attached && custRes.state === "live") why = "PM detached from its customer";
    else if (!attached) why = `PM orphaned + stored customer ${custRes.state}`;
    else if (attached !== card.stripeCustomerId) why = `PM attached to ${attached}, row says ${card.stripeCustomerId || "<none>"}`;
    else why = `stored customer ${custRes.state}`;

    bump(`card mismatch: ${why.split(" ").slice(0, 3).join(" ")}`);
    console.log(`   ✗ ${pad(who, 34)} ${pad(label, 18)} ${why}`);

    if (!FIX) continue;

    if (attached && custRes.state !== "live") {
      // The PM's own customer is authoritative — adopt it.
      card.stripeCustomerId = attached;
      await card.save();
      if (card.user?._id) {
        await User.updateOne({ _id: card.user._id }, { $set: { stripeCustomerId: attached } });
      }
      fixes.push(`repointed ${label} for ${who} → ${attached}`);
    } else if (!attached) {
      // Orphaned PM — re-vault it on a live customer for this donor: the row's
      // own customer if it survived, else the donor's current one, else a new one.
      let customerId = custRes.state === "live" ? card.stripeCustomerId : null;
      if (!customerId && card.user?.stripeCustomerId) {
        const donorRes = await retrieveCustomer(stripe, card.user.stripeCustomerId);
        if (donorRes.state === "live") customerId = card.user.stripeCustomerId;
      }
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: card.user?.email,
          name: card.user?.name,
          metadata: { userId: String(card.user?._id || ""), organisationId: String(org._id) },
        });
        customerId = customer.id;
      }
      try {
        await stripe.paymentMethods.attach(card.stripePaymentMethodId, { customer: customerId });
        card.stripeCustomerId = customerId;
        await card.save();
        if (card.user?._id) {
          await User.updateOne({ _id: card.user._id }, { $set: { stripeCustomerId: customerId } });
        }
        fixes.push(`re-vaulted ${label} for ${who} → ${customerId}`);
      } catch (e) {
        await retireCard(card);
        fixes.push(`could not re-vault ${label} for ${who} (${e.message}) — deactivated`);
      }
    } else {
      // PM lives on a different (live) customer than the row claims.
      card.stripeCustomerId = attached;
      await card.save();
      fixes.push(`corrected ${label} for ${who} → ${attached}`);
    }
  }
}

async function run() {
  console.log(`\n=== Stripe customer audit ${FIX ? "(FIX MODE)" : "(read-only)"} ===`);

  const filter = ORG_ARG ? { slug: ORG_ARG } : {};
  const orgs = await Organisation.find(filter);
  if (!orgs.length) {
    console.log(`No organisations matched${ORG_ARG ? ` slug "${ORG_ARG}"` : ""}.`);
    return;
  }

  for (const org of orgs) {
    try {
      await auditOrg(org);
    } catch (e) {
      console.log(`\n── ${org.name} (${org.slug})\n   ! audit failed: ${e.message}`);
      bump("org audit failed");
    }
  }

  console.log("\n=== Summary ===");
  const keys = Object.keys(tally).sort();
  if (!keys.length) console.log("  nothing to report");
  for (const k of keys) console.log(`  ${pad(k, 44)} ${tally[k]}`);

  if (fixes.length) {
    console.log(`\n=== Repairs (${fixes.length}) ===`);
    fixes.forEach((f) => console.log(`  • ${f}`));
  } else if (!FIX && keys.some((k) => k !== "card ok" && k !== "customer ok")) {
    console.log("\nRe-run with --fix to repair the rows above.");
  }
}

connectDB()
  .then(run)
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
