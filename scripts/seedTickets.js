/**
 * Seed realistic support tickets across organisations so the helpdesk
 * (tenant Support Tickets + SuperAdmin Tickets list + Kanban board) is populated.
 *
 *   npm run seed:tickets
 *
 * Idempotent: removes previously-seeded demo tickets (matched by their known
 * demo summaries) and re-creates them. Tickets are backdated over the last ~4
 * weeks with multi-message conversations, assignment, first-response/resolution
 * timestamps, CSAT ratings, and triage + kanban state for bug/feature items.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const SupportTicket = require("../models/supportTicket");
const Organisation = require("../models/organisation");
const User = require("../models/user");

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI not found in .env");
  process.exit(1);
}

const DAY = 86400000;
const HOUR = 3600000;

// who: "reporter" | "agent". hrs = hours after ticket creation. internal hides from reporter.
const TICKETS = [
  {
    summary: "Donations are not appearing in my dashboard",
    description: "We received 3 donations via the donate page yesterday but none of them show up in the admin dashboard or the donor list. The donors got their email receipts though.",
    category: "technical", priority: "high", status: "in_progress", ageDays: 2,
    reporter: { name: "Sarah Mitchell", email: "sarah@hopebridge.org" },
    assign: true, triage: "bug", kanban: "in_progress", triageNotes: "Webhook delivery delay — donations recorded in Stripe but dashboard aggregation lagging. Investigating the sync job.",
    comments: [
      { who: "reporter", hrs: 0, message: "This is urgent — our board meeting is tomorrow and the numbers are wrong." },
      { who: "agent", hrs: 1.5, message: "Thanks Sarah, looking into this now. I can see the payments in Stripe so the money is safe — it's a display/sync issue.", internal: false },
      { who: "agent", hrs: 1.6, message: "Stripe webhook for these 3 charges arrived but the dashboard rollup cache wasn't invalidated. Forcing a recompute.", internal: true },
    ],
  },
  {
    summary: "Login page shows a blank white screen on Safari",
    description: "Several of our volunteers on Mac/Safari can't log in — the page loads completely blank. Works fine on Chrome. Started after the weekend.",
    category: "bug_report", priority: "critical", status: "in_progress", ageDays: 1,
    reporter: { name: "Daniel Okafor", email: "d.okafor@mercyglobal.org" },
    assign: true, triage: "bug", kanban: "in_progress", triageNotes: "Repro confirmed on Safari 17. A top-level await in the auth bundle isn't transpiled for older Safari. High blast radius.",
    comments: [
      { who: "reporter", hrs: 0, message: "About a third of our team is locked out. Please prioritise." },
      { who: "agent", hrs: 0.5, message: "Reproduced on Safari — this is a build/compatibility bug on our side, not your config. Fix in progress, will update you shortly.", internal: false },
    ],
  },
  {
    summary: "Stripe payout has been delayed for 5 days",
    description: "Our last payout was scheduled for the 3rd but still shows 'in transit'. We rely on these funds for our field operations.",
    category: "billing", priority: "high", status: "on_hold", ageDays: 6,
    reporter: { name: "Aisha Rahman", email: "finance@brightfuture.org" },
    assign: true,
    comments: [
      { who: "reporter", hrs: 0, message: "Can you check what's holding up payout #PO-4821?" },
      { who: "agent", hrs: 3, message: "Stripe has flagged this for a standard verification review. I've escalated with them and we're waiting on their response — I'll chase daily.", internal: false },
      { who: "agent", hrs: 4, message: "Waiting on Stripe risk team. Nothing actionable our side yet.", internal: true },
    ],
  },
  {
    summary: "Campaign progress bar is stuck at 0%",
    description: "Our 'Clean Water' campaign has raised over $12,000 but the public progress bar still shows 0% and $0 raised.",
    category: "technical", priority: "high", status: "new", ageDays: 0,
    reporter: { name: "Tom Becker", email: "tom@atlasaid.org" },
    triage: "bug", kanban: "todo", triageNotes: "Likely the campaign goal is set to 0, causing a divide-by-zero → NaN width. Need to guard + backfill raised total.",
    comments: [
      { who: "reporter", hrs: 0, message: "Donors are messaging us asking if the campaign is broken. Embarrassing!" },
    ],
  },
  {
    summary: "Volunteer sign-up form is not sending confirmation emails",
    description: "When someone signs up to volunteer, they don't receive the confirmation email. The signups do appear in our admin list though.",
    category: "bug_report", priority: "medium", status: "in_progress", ageDays: 4,
    reporter: { name: "Grace Lin", email: "grace@northwindtrust.org" },
    assign: true, triage: "bug", kanban: "in_progress", triageNotes: "Confirmation email template missing for the volunteer flow — only the admin notification fires.",
    comments: [
      { who: "reporter", hrs: 0, message: "Is there a setting I missed, or is this a bug?" },
      { who: "agent", hrs: 6, message: "Not your setting — the volunteer confirmation email isn't wired up. We're adding it.", internal: false },
    ],
  },
  {
    summary: "PayPal donations failing with an error at checkout",
    description: "Donors choosing PayPal get 'Something went wrong' after approving the payment. Card donations work fine.",
    category: "technical", priority: "high", status: "on_hold", ageDays: 3,
    reporter: { name: "Marcus Webb", email: "marcus@oceanrelief.org" },
    assign: true,
    comments: [
      { who: "reporter", hrs: 0, message: "We just enabled PayPal last week — did I configure it wrong?" },
      { who: "agent", hrs: 2, message: "Your PayPal credentials look correct. The capture call is returning an error — we're checking whether it's a sandbox/live mismatch. Holding while we confirm with you.", internal: false },
    ],
  },
  {
    summary: "How do I issue an end-of-year tax receipt?",
    description: "A donor has asked for a consolidated tax receipt for all their 2025 gifts. How do I generate that?",
    category: "account", priority: "low", status: "solved", ageDays: 9,
    reporter: { name: "Priya Nair", email: "priya@givewell-local.org" },
    assign: true, resolved: true, resolutionNotes: "Walked them through Donors → select donor → Annual statement → download PDF.",
    csat: { rating: 5, feedback: "Super quick and friendly, thank you!" },
    comments: [
      { who: "reporter", hrs: 0, message: "Is there a one-click way or do I add them up manually?" },
      { who: "agent", hrs: 2, message: "One click! Open the donor's profile and use 'Annual statement' — it generates a consolidated PDF receipt for the year. Let me know if you'd like it emailed automatically too.", internal: false },
      { who: "reporter", hrs: 20, message: "Found it — perfect, thank you!" },
    ],
  },
  {
    summary: "We were double charged for our monthly subscription",
    description: "Our Professional plan was charged twice this month — two identical $500 charges on the same day.",
    category: "billing", priority: "critical", status: "solved", ageDays: 7,
    reporter: { name: "Helen Carter", email: "helen@safeharbour.org" },
    assign: true, resolved: true, resolutionNotes: "Confirmed duplicate invoice from a retry race; refunded the second $500 charge. Added idempotency note to billing.",
    csat: { rating: 5, feedback: "Refunded within the hour. Excellent support." },
    comments: [
      { who: "reporter", hrs: 0, message: "Please refund the duplicate — invoice #INV-2231 and #INV-2232." },
      { who: "agent", hrs: 0.7, message: "Confirmed it's a duplicate charge on our side. I've refunded the second $500 — it'll appear in 5–10 days. Apologies for the scare.", internal: false },
    ],
  },
  {
    summary: "Newsletter unsubscribe link is broken",
    description: "A supporter clicked 'unsubscribe' in our newsletter and got a 404 page.",
    category: "bug_report", priority: "medium", status: "solved", ageDays: 12,
    reporter: { name: "Owen Pierce", email: "owen@treesforall.org" },
    assign: true, resolved: true, resolutionNotes: "Unsubscribe token route was missing a redirect for already-unsubscribed users; fixed and deployed.",
    triage: "bug", kanban: "done", triageNotes: "Edge case: token valid but already unsubscribed → 404 instead of friendly page. Fixed.",
    csat: { rating: 4, feedback: "Resolved well, took a couple of days." },
    comments: [
      { who: "reporter", hrs: 0, message: "This could get us in trouble with anti-spam rules, please fix asap." },
      { who: "agent", hrs: 4, message: "Agreed, treating as priority. The unsubscribe still worked, but the confirmation page 404'd — fixing the redirect now.", internal: false },
    ],
  },
  {
    summary: "Export the full donor list to CSV",
    description: "I'd love a way to export all our donors (with totals) to a spreadsheet for our annual report.",
    category: "feature_request", priority: "low", status: "solved", ageDays: 16,
    reporter: { name: "Nadia Hassan", email: "nadia@shelterfirst.org" },
    assign: true, resolved: true, resolutionNotes: "Feature already exists — pointed them to Donors → Export. Logged the discoverability feedback.",
    triage: "feature", kanban: "done", triageNotes: "Already shipped; improve discoverability of the export button.",
    csat: { rating: 5, feedback: "" },
    comments: [
      { who: "agent", hrs: 1, message: "Good news — this already exists! Donors page → 'Export' top-right gives you a CSV with lifetime totals. I'll pass on the note that it was hard to find.", internal: false },
    ],
  },
  {
    summary: "Please add recurring donation reminder emails",
    description: "It would be great if monthly donors got a friendly reminder/receipt each time their gift renews.",
    category: "feature_request", priority: "medium", status: "new", ageDays: 5,
    reporter: { name: "Liam Foster", email: "liam@youthrising.org" },
    triage: "feature", kanban: "todo", triageNotes: "Reasonable — tie into the existing subscription renewal webhook to send a templated receipt. Medium effort.",
    comments: [
      { who: "reporter", hrs: 0, message: "Several donors have asked for this. Is it on the roadmap?" },
    ],
  },
  {
    summary: "Feature request: Gift Aid support for UK donors",
    description: "We're a UK charity and need to capture Gift Aid declarations at checkout and report on them.",
    category: "feature_request", priority: "medium", status: "new", ageDays: 8,
    reporter: { name: "Eleanor Whitcombe", email: "eleanor@thamesrelief.org.uk" },
    triage: "feature", kanban: "todo", triageNotes: "Bigger piece: declaration checkbox + storage + HMRC-format report. Cluster of UK tenants would benefit.",
    comments: [
      { who: "reporter", hrs: 0, message: "This is essential for UK charities — happy to be a beta tester." },
      { who: "agent", hrs: 26, message: "Thanks Eleanor — this is on our radar for UK orgs. I've logged your interest as a beta tester and our product team will follow up.", internal: false },
    ],
  },
  {
    summary: "Dark mode for the donor portal",
    description: "Some of our donors have asked for a dark theme on the donor dashboard.",
    category: "feature_request", priority: "low", status: "new", ageDays: 14,
    reporter: { name: "Internal", internal: true },
    triage: "feature", kanban: "todo", triageNotes: "Nice-to-have; low priority. Park until theming refactor lands.",
    comments: [
      { who: "reporter", hrs: 0, message: "Logging this from a few donor emails — not urgent." },
    ],
  },
  {
    summary: "Can't upload an event banner image",
    description: "When I try to add a banner to our gala event, the upload spins forever and never finishes.",
    category: "technical", priority: "medium", status: "solved", ageDays: 11,
    reporter: { name: "Internal", internal: true },
    assign: true, resolved: true, resolutionNotes: "Image was 14MB — over the 5MB limit. Advised to compress; upload succeeded. Considering a clearer error message.",
    csat: { rating: 4, feedback: "Would've helped to see the size limit error." },
    comments: [
      { who: "agent", hrs: 1, message: "The file was 14MB which is over our 5MB image limit, so it silently failed. Compressed it and it uploaded fine. We'll add a clearer size warning.", internal: false },
    ],
  },
  {
    summary: "GDPR data export request from a donor",
    description: "A donor has formally requested all the personal data we hold on them under GDPR. How do I fulfil this?",
    category: "data", priority: "medium", status: "in_progress", ageDays: 3,
    reporter: { name: "Internal", internal: true },
    assign: true,
    comments: [
      { who: "reporter", hrs: 0, message: "We have 30 days to respond. What's the process?" },
      { who: "agent", hrs: 5, message: "You can export the donor's full record from their profile, including donation history and contact details. I'm preparing a short GDPR-response guide for you now.", internal: false },
    ],
  },
  {
    summary: "Getting spam submissions through our contact form",
    description: "Our contact form is being hit with dozens of spam messages a day.",
    category: "other", priority: "medium", status: "declined", ageDays: 18,
    reporter: { name: "Internal", internal: true },
    assign: true, resolved: true, resolutionNotes: "Not a platform bug — recommended enabling the honeypot/rate-limit option and reviewing in the Contacts inbox. Closing as not-a-defect.",
    triage: "invalid", triageNotes: "Not actionable as a bug; product already has spam mitigation toggles.",
    comments: [
      { who: "agent", hrs: 3, message: "This is spam bots rather than a fault. Enable the spam-protection toggle in Settings → Contact, and the rate limiter will throttle them. Marking as resolved, but reopen if it continues.", internal: false },
    ],
  },
];

const pad2 = (n) => String(n).padStart(2, "0");

async function seed() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB");

    const orgs = await Organisation.find({}).select("name slug").limit(8);
    if (!orgs.length) {
      console.error("No organisations found — run `npm run seed:orgs` first.");
      return;
    }
    const superAdmin = await User.findOne({ role: "superadmin" }).select("_id name");

    // Idempotent: clear previously-seeded demo tickets (by their known summaries).
    const summaries = TICKETS.map((t) => t.summary);
    const del = await SupportTicket.deleteMany({ summary: { $in: summaries } });
    if (del.deletedCount) console.log(`Removed ${del.deletedCount} previously-seeded demo ticket(s).`);

    const now = Date.now();
    const counters = {};
    for (const org of orgs) {
      counters[org._id] = await SupportTicket.countDocuments({ organisationId: org._id });
    }
    // An admin per org for assignment + agent replies.
    const adminByOrg = {};
    for (const org of orgs) {
      adminByOrg[org._id] = await User.findOne({ organisationId: org._id, role: "admin" }).select("_id name email");
    }

    let created = 0;
    for (let i = 0; i < TICKETS.length; i++) {
      const t = TICKETS[i];
      const org = orgs[i % orgs.length];
      const admin = adminByOrg[org._id];
      const agentName = admin?.name || "Support Team";
      const createdAt = new Date(now - t.ageDays * DAY - (i % 5) * 2 * HOUR);

      const reporter = t.reporter?.internal
        ? {
            userId: admin?._id || null,
            name: admin?.name || "Team Member",
            email: admin?.email || `team@${org.slug}.org`,
            isExternal: false,
          }
        : { userId: null, name: t.reporter.name, email: t.reporter.email, isExternal: true };

      const reporterName = reporter.name;

      const comments = (t.comments || []).map((c) => ({
        message: c.message,
        createdBy: c.who === "agent" ? admin?._id || null : reporter.userId,
        authorName: c.who === "agent" ? agentName : reporterName,
        isInternal: !!c.internal,
        createdAt: new Date(createdAt.getTime() + (c.hrs || 0) * HOUR),
        updatedAt: new Date(createdAt.getTime() + (c.hrs || 0) * HOUR),
      }));

      const firstAgent = (t.comments || []).find((c) => c.who === "agent");
      const firstResponseAt = firstAgent ? new Date(createdAt.getTime() + (firstAgent.hrs || 0) * HOUR) : null;
      const lastCommentAt = comments.length ? comments[comments.length - 1].createdAt : createdAt;

      const isResolved = t.status === "solved" || t.status === "declined";
      const resolvedAt = isResolved ? new Date(lastCommentAt.getTime() + 1 * HOUR) : null;

      const doc = new SupportTicket({
        organisationId: org._id,
        ticketNumber: ++counters[org._id],
        reporter,
        summary: t.summary,
        description: t.description || "",
        priority: t.priority || "medium",
        status: t.status || "new",
        category: t.category || "general",
        assignee: t.assign && admin ? { userId: admin._id, assignedAt: new Date(createdAt.getTime() + 0.5 * HOUR) } : { userId: null, assignedAt: null },
        comments,
        firstResponseAt,
        satisfactionRating: t.csat?.rating ?? null,
        satisfactionFeedback: t.csat?.feedback || "",
        resolution: isResolved
          ? { notes: t.resolutionNotes || "", resolvedBy: admin?._id || null, resolvedAt }
          : { notes: "", resolvedBy: null, resolvedAt: null },
        triage: t.triage || "unclassified",
        kanbanStatus: t.kanban || "todo",
        triagedBy: t.triage ? superAdmin?._id || null : null,
        triagedAt: t.triage ? new Date(createdAt.getTime() + 8 * HOUR) : null,
        triageNotes: t.triageNotes || "",
      });
      doc.createdAt = createdAt;
      doc.updatedAt = isResolved ? resolvedAt : lastCommentAt;
      // Preserve our backdated timestamps (skip Mongoose auto-stamping).
      await doc.save({ timestamps: false });
      created += 1;
      console.log(`  #${pad2(doc.ticketNumber)} [${org.slug}] ${t.status.padEnd(11)} ${t.priority.padEnd(8)} ${t.summary}`);
    }

    const byStatus = await SupportTicket.aggregate([
      { $match: { summary: { $in: summaries } } },
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]);
    const kanban = await SupportTicket.countDocuments({ summary: { $in: summaries }, triage: { $in: ["bug", "feature"] } });

    console.log(`\nSeeded ${created} support tickets across ${orgs.length} organisation(s).`);
    console.log("  By status:", byStatus.map((r) => `${r._id}=${r.n}`).join("  "));
    console.log(`  On the Kanban board (bug/feature): ${kanban}`);
    console.log("\nView them in SuperAdmin → Support Tickets and Kanban, and per-tenant under Admin → Support Tickets.\n");
  } catch (error) {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

seed();
