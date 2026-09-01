/**
 * How a task's due date reads in an EMAIL.
 *
 * Deliberately not the same function as the console's dueMeta (see
 * config/taskOptions.js on the frontend). That one formats against the reader's
 * browser locale and timezone and is re-rendered continuously; this one is
 * baked into a message that will be read hours later, on a device this server
 * knows nothing about. So it says "Overdue by 2 days" and "Today, 5:00 pm" —
 * phrasings that stay true whichever way the reader's clock is set — and never
 * a bare date the reader would have to compare against today themselves.
 *
 * @param dueAt  the deadline
 * @param status the task's status (a finished task is never "overdue")
 * @param now    the instant to measure from — injectable so the digest's whole
 *               round is described from one consistent moment
 */
const TERMINAL = ["done", "cancelled"];

const TIME_FMT = { hour: "numeric", minute: "2-digit" };
const DATE_FMT = { weekday: "long", day: "numeric", month: "short" };

function dueMeta(dueAt, status, now = new Date()) {
  if (!dueAt) return { text: "No due date", tone: "none" };
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return { text: "No due date", tone: "none" };

  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((midnight(due) - midnight(now)) / 86400000);
  const time = due.toLocaleTimeString("en-AU", TIME_FMT);

  if (TERMINAL.includes(status)) {
    return { text: due.toLocaleDateString("en-AU", DATE_FMT), tone: "none" };
  }
  if (due.getTime() < now.getTime()) {
    if (days === 0) return { text: `Overdue · ${time}`, tone: "overdue" };
    const ago = Math.abs(days);
    return { text: ago === 1 ? "Overdue by a day" : `Overdue by ${ago} days`, tone: "overdue" };
  }
  if (days === 0) return { text: `Today, ${time}`, tone: "today" };
  if (days === 1) return { text: `Tomorrow, ${time}`, tone: "soon" };
  return { text: due.toLocaleDateString("en-AU", DATE_FMT), tone: "normal" };
}

module.exports = { dueMeta };
