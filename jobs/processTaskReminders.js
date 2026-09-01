// Sends each operator their morning list of overdue and due-today CRM tasks.
const cron = require("node-cron");
const CrmTask = require("../models/crmTask");
const User = require("../models/user");
const { sendTemplateEmail } = require("../services/emailUtil");
const { platformConsoleUrl } = require("../utils/tenantUrls");
const { dueMeta } = require("../utils/taskDue");

/**
 * A due date nobody is reminded of is a due date nobody keeps.
 *
 * Everything else in the CRM is pull — an operator has to open the console and
 * look. This is the one push, and it is deliberately the smallest useful one:
 * once a day, only to people who actually owe something, listing only what is
 * late or due before the day is out. A digest that arrives when there is
 * nothing to do is the fastest way to teach someone to filter it away.
 *
 * TASK_DIGEST_CRON overrides the schedule; TASK_DIGEST_DISABLED=true turns it
 * off (useful on a second instance that shares the database, where two schedulers
 * would send everyone two copies).
 */

const SCHEDULE = process.env.TASK_DIGEST_CRON || "0 8 * * *"; // 08:00, server time

/** Group open, due-or-overdue tasks by the operator who owes them. */
async function collectDigests(now = new Date()) {
  // End of the server's today. The digest is a per-server morning routine, so
  // unlike the API's day boundary there is no operator timezone to consult —
  // whoever the schedule fires for gets the same window.
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  const tasks = await CrmTask.find({
    status: { $in: CrmTask.STATUSES.filter((s) => !CrmTask.TERMINAL_STATUSES.includes(s)) },
    "assignee.userId": { $ne: null },
    dueAt: { $ne: null, $lt: endOfToday },
  })
    .select("title dueAt status assignee lead")
    .populate("lead", "orgName")
    .sort({ dueAt: 1 })
    .limit(2000)
    .lean();

  const byUser = new Map();
  for (const t of tasks) {
    const key = String(t.assignee.userId);
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push(t);
  }
  return byUser;
}

async function runDigest() {
  const now = new Date();
  const byUser = await collectDigests(now);
  if (!byUser.size) return { sent: 0, recipients: 0 };

  // One query for every recipient rather than one per digest. Suspended
  // operators are excluded here rather than in the task query: a suspended
  // person's tasks still need to show up on the board for someone to reassign,
  // they just must not be emailed about them.
  const users = await User.find({
    _id: { $in: [...byUser.keys()] },
    platformStatus: { $ne: "suspended" },
  })
    .select("name email")
    .lean();

  let sent = 0;
  for (const user of users) {
    if (!user.email) continue;
    const items = byUser.get(String(user._id)) || [];
    if (!items.length) continue;

    const overdue = items.filter((t) => new Date(t.dueAt) < now);
    try {
      const result = await sendTemplateEmail("crm.taskDigest", {
        to: user.email,
        data: {
          recipient: { name: user.name || "", email: user.email },
          tasks: {
            overdueCount: overdue.length,
            todayCount: items.length - overdue.length,
            items: items.map((t) => ({
              title: t.title,
              lead: t.lead?.orgName || "—",
              due: dueMeta(t.dueAt, t.status, now).text,
            })),
            url: platformConsoleUrl("/tasks?due=today&assignee=me"),
          },
        },
        meta: { digest: "crm.tasks", count: items.length },
      });
      if (result?.success) sent += 1;
    } catch (err) {
      // One operator's bad address must not stop the rest of the round.
      console.error(`[tasks] digest to ${user.email} failed:`, err.message);
    }
  }
  return { sent, recipients: users.length };
}

function setupTaskDigestJob() {
  if (String(process.env.TASK_DIGEST_DISABLED).toLowerCase() === "true") {
    console.log("[tasks] daily digest disabled (TASK_DIGEST_DISABLED)");
    return;
  }
  if (!cron.validate(SCHEDULE)) {
    console.error(`[tasks] invalid TASK_DIGEST_CRON "${SCHEDULE}" — digest not scheduled`);
    return;
  }
  cron.schedule(SCHEDULE, async () => {
    try {
      const { sent, recipients } = await runDigest();
      if (recipients) console.log(`[tasks] daily digest: ${sent}/${recipients} sent`);
    } catch (err) {
      console.error("[tasks] daily digest failed:", err);
    }
  });
  console.log(`[${new Date().toISOString()}] CRM task digest scheduled (${SCHEDULE})`);
}

module.exports = { setupTaskDigestJob, runDigest, collectDigests };
