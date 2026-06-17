const { test } = require("node:test");
const assert = require("node:assert/strict");
const { endOfDayUnix, clampNextPaymentDate, cancelAtUnix, countPayments } = require("../services/recurringDates");

test("endOfDayUnix → 23:59:59 UTC of the given day (so the end-date charge fires before cancel)", () => {
  const ts = endOfDayUnix("2026-07-15");
  assert.equal(new Date(ts * 1000).toISOString(), "2026-07-15T23:59:59.000Z");
});

test("endOfDayUnix is strictly after the day's midnight renewal instant", () => {
  const midnight = Math.floor(new Date("2026-07-15").getTime() / 1000);
  assert.ok(endOfDayUnix("2026-07-15") > midnight);
});

test("clampNextPaymentDate keeps a date ON the end date (inclusive)", () => {
  const r = clampNextPaymentDate(new Date("2026-07-15T07:00:00Z"), "2026-07-15");
  assert.ok(r instanceof Date);
  assert.equal(r.toISOString(), "2026-07-15T07:00:00.000Z");
});

test("clampNextPaymentDate nulls a date AFTER the end date (no further charge)", () => {
  assert.equal(clampNextPaymentDate(new Date("2026-08-15T00:00:00Z"), "2026-07-15"), null);
});

test("clampNextPaymentDate returns the date unchanged when there is no end date", () => {
  const d = new Date("2026-08-15T00:00:00Z");
  assert.equal(clampNextPaymentDate(d, null).toISOString(), d.toISOString());
});

test("clampNextPaymentDate null/invalid inputs → null", () => {
  assert.equal(clampNextPaymentDate(null, "2026-07-15"), null);
  assert.equal(clampNextPaymentDate(new Date("nonsense"), "2026-07-15"), null);
});

test("countPayments steps the cadence — weekly Jun16→Jul11 = 4 (not 5)", () => {
  assert.equal(countPayments(new Date("2026-06-16T06:00:00Z"), "weekly", "2026-07-11"), 4);
});

test("countPayments — monthly is inclusive when the end date is a billing day", () => {
  assert.equal(countPayments(new Date("2026-06-15T06:00:00Z"), "monthly", "2026-07-15"), 2);
  assert.equal(countPayments(new Date("2026-06-16T06:00:00Z"), "monthly", "2026-07-15"), 1);
});

test("countPayments — daily counts every day inclusive", () => {
  assert.equal(countPayments(new Date("2026-06-16T06:00:00Z"), "daily", "2026-06-20"), 5);
});

test("cancelAtUnix is the first boundary strictly after the end date", () => {
  // weekly from Jun 16, end Jul 11 → boundaries Jun16/23/30/Jul7/Jul14; cancel = Jul14
  const cancel = cancelAtUnix(new Date("2026-06-16T06:00:00Z"), "weekly", "2026-07-11");
  assert.equal(new Date(cancel * 1000).toISOString().slice(0, 10), "2026-07-14");
});
