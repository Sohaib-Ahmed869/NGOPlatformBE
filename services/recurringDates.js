// Date helpers shared by the order + subscription controllers for end-dated
// recurring donations.
//
// The donor's chosen end date is *inclusive*: the charge that lands ON the end
// date should still happen, then the subscription cancels. Stripe's `cancel_at`
// is an exact instant, so if we set it to the end date's midnight it collides
// with that day's renewal and Stripe cancels INSTEAD of charging. Pushing it to
// the end of the day lets the final charge fire first, then cancels.

/**
 * End of the given day (UTC) as a Stripe Unix timestamp (seconds).
 * Use as a subscription's `cancel_at` so the end-date charge still fires.
 */
const endOfDayUnix = (date) => {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 0);
  return Math.floor(d.getTime() / 1000);
};

/**
 * The next-payment date to show the donor — or null if it falls after the end
 * date, i.e. the subscription will already have cancelled (no further charge).
 * @param {Date|string|number} candidate - the computed next payment date
 * @param {Date|string|null} endDate - the recurring end date (cancel date)
 * @returns {Date|null}
 */
const clampNextPaymentDate = (candidate, endDate) => {
  if (!candidate) return null;
  const c = candidate instanceof Date ? candidate : new Date(candidate);
  if (isNaN(c.getTime())) return null;
  if (!endDate) return c;
  if (c.getTime() > endOfDayUnix(endDate) * 1000) return null;
  return c;
};

const STEP_UTC = {
  daily: (d) => d.setUTCDate(d.getUTCDate() + 1),
  weekly: (d) => d.setUTCDate(d.getUTCDate() + 7),
  monthly: (d) => d.setUTCMonth(d.getUTCMonth() + 1),
  yearly: (d) => d.setUTCFullYear(d.getUTCFullYear() + 1),
};
const dayKey = (d) => d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();

/**
 * Stripe `cancel_at` for an end-dated recurring donation: the first billing
 * boundary STRICTLY AFTER the end date, stepping the cadence from the start.
 *
 * Cancelling on a boundary (not mid-period) means the final charge is a FULL
 * charge — Stripe never shortens/​prorates the last period. The donor is charged
 * on every billing date up to and including the last one on/before the end date.
 */
const cancelAtUnix = (startDate, frequency, endDate) => {
  const step = STEP_UTC[frequency] || STEP_UTC.monthly;
  const endKey = dayKey(new Date(endDate));
  const b = new Date(startDate);
  let guard = 0;
  while (dayKey(b) <= endKey && guard++ < 100000) step(b);
  return Math.floor(b.getTime() / 1000);
};

/**
 * How many full charges fall on/before the end date — the boundaries the cancel
 * lands after. Mirrors cancelAtUnix so previews/records match what Stripe bills.
 */
const countPayments = (startDate, frequency, endDate) => {
  const step = STEP_UTC[frequency];
  if (!step) return 0;
  const endKey = dayKey(new Date(endDate));
  const b = new Date(startDate);
  let count = 0;
  let guard = 0;
  while (dayKey(b) <= endKey && guard++ < 100000) {
    count += 1;
    step(b);
  }
  return count;
};

module.exports = { endOfDayUnix, clampNextPaymentDate, cancelAtUnix, countPayments };
