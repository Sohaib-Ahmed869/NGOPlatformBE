/**
 * Backfill `reporter.kind` on support tickets created before the field shipped.
 *
 *   npm run backfill:tickets
 *
 * Classifies every ticket that has no `reporter.kind` yet into the platform
 * operator's three source buckets:
 *   "admin"    → the tenant's own NGO staff (the linked user is admin/superadmin)
 *   "customer" → a donor / end-user (the linked user is a donor)
 *   "public"   → an anonymous public-form submission (no account)
 *
 * Resolution order for each ticket:
 *   1. If reporter.userId resolves to a User → use that user's role.
 *   2. Else if reporter.email matches a User → use that user's role.
 *   3. Else fall back to isExternal (true → "public", false → "customer").
 *
 * Idempotent: only touches tickets where reporter.kind is missing/empty, so it's
 * safe to re-run.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const SupportTicket = require("../models/supportTicket");
const User = require("../models/user");

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI not found in .env");
  process.exit(1);
}

const roleToKind = (role) => (["admin", "superadmin"].includes(role) ? "admin" : role === "donor" ? "customer" : null);

async function backfill() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB");

    // Only tickets that haven't been classified yet.
    const tickets = await SupportTicket.find({
      $or: [{ "reporter.kind": { $exists: false } }, { "reporter.kind": null }, { "reporter.kind": "" }],
    }).select("reporter");

    if (!tickets.length) {
      console.log("No tickets need backfilling — every ticket already has reporter.kind. ✔");
      return;
    }
    console.log(`Found ${tickets.length} ticket(s) without a source — classifying…`);

    // Pre-load the users referenced by id or email in one pass each (avoids N queries).
    const userIds = [...new Set(tickets.map((t) => t.reporter?.userId).filter(Boolean).map(String))];
    const emails = [...new Set(tickets.map((t) => (t.reporter?.email || "").toLowerCase().trim()).filter(Boolean))];

    const byId = new Map();
    if (userIds.length) {
      (await User.find({ _id: { $in: userIds } }).select("role email")).forEach((u) => byId.set(String(u._id), u));
    }
    const byEmail = new Map();
    if (emails.length) {
      (await User.find({ email: { $in: emails } }).select("role email")).forEach((u) => byEmail.set((u.email || "").toLowerCase(), u));
    }

    const ops = [];
    const tally = { admin: 0, customer: 0, public: 0 };
    for (const t of tickets) {
      const r = t.reporter || {};
      const user = (r.userId && byId.get(String(r.userId))) || (r.email && byEmail.get(r.email.toLowerCase().trim()));
      const kind = roleToKind(user?.role) || (r.isExternal ? "public" : "customer");
      tally[kind] += 1;
      ops.push({ updateOne: { filter: { _id: t._id }, update: { $set: { "reporter.kind": kind } } } });
    }

    if (ops.length) await SupportTicket.bulkWrite(ops, { ordered: false });

    console.log(`\nBackfilled ${ops.length} ticket(s):`);
    console.log(`  Tenant (admin):    ${tally.admin}`);
    console.log(`  Tenant customer:   ${tally.customer}`);
    console.log(`  Public visitor:    ${tally.public}`);
    console.log("\nView them in SuperAdmin → Support Tickets (now with a Source badge & filter).\n");
  } catch (error) {
    console.error("Backfill failed:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

backfill();
