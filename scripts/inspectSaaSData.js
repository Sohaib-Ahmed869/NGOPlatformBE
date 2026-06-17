/**
 * scripts/inspectSaaSData.js  — READ-ONLY
 * Prints a quick summary of the SuperAdmin/SaaS collections so you can see the
 * current data. Does not modify anything.
 *
 *   node scripts/inspectSaaSData.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");

const Organisation = require("../models/organisation");
const User = require("../models/user");
const Plan = require("../models/plan");
const Coupon = require("../models/coupon");
const PlatformInvoice = require("../models/platformInvoice");
const PlatformAuditLog = require("../models/platformAuditLog");
const SupportTicket = require("../models/supportTicket");
const StripeEvent = require("../models/stripeEvent");

const line = (l = "─") => console.log(l.repeat(64));

async function run() {
  line("═");
  console.log("  SUPERADMIN / SAAS DATA SNAPSHOT");
  line("═");

  // Counts
  const [orgs, supers, admins, donors, plans, coupons, invoices, audits, tickets, events] = await Promise.all([
    Organisation.countDocuments(),
    User.countDocuments({ role: "superadmin" }),
    User.countDocuments({ role: "admin" }),
    User.countDocuments({ role: "donor" }),
    Plan.countDocuments(),
    Coupon.countDocuments(),
    PlatformInvoice.countDocuments(),
    PlatformAuditLog.countDocuments(),
    SupportTicket.countDocuments(),
    StripeEvent.countDocuments(),
  ]);
  console.log(`  Organisations .......... ${orgs}`);
  console.log(`  Users .................. superadmin:${supers}  admin:${admins}  donor:${donors}`);
  console.log(`  Plans .................. ${plans}`);
  console.log(`  Coupons ................ ${coupons}`);
  console.log(`  Platform invoices ...... ${invoices}`);
  console.log(`  Audit-log entries ...... ${audits}`);
  console.log(`  Support tickets ........ ${tickets}`);
  console.log(`  Processed Stripe events  ${events}`);

  line();
  console.log("  PLANS");
  line();
  const planDocs = await Plan.find().sort({ sortOrder: 1 }).lean();
  if (!planDocs.length) console.log("  (none — run `npm run seed:plans`)");
  planDocs.forEach((p) => {
    const synced = p.stripePriceIds?.monthly || p.stripePriceIds?.annual ? "synced" : "UNSYNCED";
    const lim = p.limits || {};
    console.log(`  • ${p.code.padEnd(14)} $${p.price?.monthly}/mo · campaigns:${lim.campaigns ?? "∞"} volunteers:${lim.volunteers ?? "∞"} vol:${!!lim.volunteerEnabled} [${synced}]`);
  });

  line();
  console.log("  ORGANISATIONS (latest 8)");
  line();
  const orgDocs = await Organisation.find().sort({ createdAt: -1 }).limit(8).select("name slug plan subscriptionStatus isActive isComp").lean();
  if (!orgDocs.length) console.log("  (none)");
  orgDocs.forEach((o) => {
    console.log(`  • ${(o.slug || "?").padEnd(18)} ${(o.plan || "-").padEnd(13)} ${(o.subscriptionStatus || "-").padEnd(10)} active:${!!o.isActive}${o.isComp ? " COMP" : ""}`);
  });

  line();
  console.log("  COUPONS");
  line();
  const couponDocs = await Coupon.find().sort({ createdAt: -1 }).limit(10).lean();
  if (!couponDocs.length) console.log("  (none)");
  couponDocs.forEach((c) => {
    console.log(`  • ${c.code.padEnd(14)} ${c.type === "percent" ? c.value + "%" : "$" + c.value} off · ${c.duration} · used ${c.timesRedeemed}${c.maxRedemptions ? "/" + c.maxRedemptions : ""}${c.archivedAt ? " [archived]" : ""}`);
  });

  line();
  console.log("  SUPPORT TICKETS (latest 8)");
  line();
  const ticketDocs = await SupportTicket.find().sort({ createdAt: -1 }).limit(8).populate("organisationId", "slug").lean();
  if (!ticketDocs.length) console.log("  (none)");
  ticketDocs.forEach((t) => {
    console.log(`  • #${String(t.ticketNumber).padEnd(4)} [${t.organisationId?.slug || "?"}] ${t.status.padEnd(12)} ${t.priority.padEnd(8)} triage:${t.triage} att:${t.attachments?.length || 0} — ${String(t.summary).slice(0, 40)}`);
  });

  line();
  console.log("  PLATFORM INVOICES (latest 8)");
  line();
  const invDocs = await PlatformInvoice.find().sort({ createdAt: -1 }).limit(8).populate("organisationId", "slug").lean();
  if (!invDocs.length) console.log("  (none — arrive via the Stripe SaaS webhook)");
  invDocs.forEach((i) => {
    console.log(`  • ${(i.organisationId?.slug || "?").padEnd(18)} $${i.amountPaid || i.amountDue} ${i.currency.toUpperCase()} ${i.status}`);
  });

  line();
  console.log("  RECENT OPERATOR AUDIT (latest 10)");
  line();
  const auditDocs = await PlatformAuditLog.find().sort({ createdAt: -1 }).limit(10).lean();
  if (!auditDocs.length) console.log("  (none yet)");
  auditDocs.forEach((a) => {
    console.log(`  • ${a.action.padEnd(28)} by ${a.actorEmail || "system"}`);
  });
  line("═");
}

(async () => {
  try {
    await connectDB();
    await run();
  } catch (err) {
    console.error("Inspect failed:", err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
})();
