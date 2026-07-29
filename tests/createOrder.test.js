const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./_harness");
const { cancelAtUnix } = require("../services/recurringDates");

const donor = {
  name: "Sohaib Ahmed",
  phone: "+923105725514",
  email: "admin@calcite.org",
  streetAddress: "St 5",
  townCity: "Mirpur",
  state: "NSW",
  postcode: "10250",
  agreeToMessages: true,
  rememberDetails: false,
};
const items = [{ title: "Orphan Care", price: 100, quantity: 1, donationType: "Sadaqah" }];
const dateInDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const lastOrder = () => h.store[h.store.length - 1];

beforeEach(() => {
  h.resetStore();
  h.setStripe(h.makeStripe());
});

async function run(body) {
  const res = h.makeRes();
  await h.orderCtrl.createOrder(h.makeReq(body), res);
  return res;
}

/* ── ONE-TIME ───────────────────────────────────────────────────────────── */
test("one-time: charges once and stores the Stripe receipt", async () => {
  const res = await run({
    items, paymentType: "single", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 100, stripePaymentMethodId: "pm_x", donationType: "Sadaqah",
  });
  assert.equal(res.body.status, "Success");
  const order = lastOrder();
  assert.equal(order.paymentType, "single");
  assert.equal(order.paymentStatus, "completed", "a one-time payment is done");
  assert.ok(order.stripeReceiptUrl, "single order should keep a Stripe receipt");
});

test("one-time: PaymentIntent amount is totalAmount in cents", async () => {
  const stripe = h.makeStripe();
  h.setStripe(stripe);
  await run({
    items, paymentType: "single", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 100, stripePaymentMethodId: "pm_x",
  });
  assert.equal(stripe.count("paymentIntents.create"), 1);
  assert.equal(stripe.last("paymentIntents.create").amount, 10000);
});

/* ── RECURRING (all frequencies) ────────────────────────────────────────── */
for (const [frequency, interval] of [
  ["daily", "day"],
  ["weekly", "week"],
  ["monthly", "month"],
  ["yearly", "year"],
]) {
  test(`recurring ${frequency}: maps to Stripe interval "${interval}" and charges first invoice with a receipt`, async () => {
    const stripe = h.makeStripe();
    h.setStripe(stripe);
    const endDate = dateInDays(120);
    const res = await run({
      items, paymentType: "recurring", donorDetails: donor, paymentMethod: "visa",
      totalAmount: 51, stripePaymentMethodId: "pm_x",
      recurringDetails: { frequency, endDate },
    });
    assert.equal(res.body.status, "Success");
    const sub = stripe.last("subscriptions.create");
    assert.equal(sub.items[0].price_data.recurring.interval, interval);
    const order = lastOrder();
    assert.equal(order.recurringDetails.paymentHistory.length, 1, "first charge recorded");
    assert.ok(order.recurringDetails.paymentHistory[0].receiptUrl, "first payment keeps a receipt");
    assert.ok(order.stripeReceiptUrl, "order keeps latest receipt");
  });
}

test("recurring end date: cancel_at lands on the billing boundary AFTER the end date (full last charge, no proration)", async () => {
  const stripe = h.makeStripe();
  h.setStripe(stripe);
  const endDate = dateInDays(30);
  await run({
    items, paymentType: "recurring", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 51, stripePaymentMethodId: "pm_x",
    recurringDetails: { frequency: "monthly", endDate },
  });
  const order = lastOrder();
  // cancel_at is scheduled via a subscriptions.update (computed from Stripe's
  // real anchor), not on the create call.
  const upd = stripe.last("subscriptions.update");
  assert.ok(upd, "cancellation scheduled via subscriptions.update");
  assert.equal(upd.a.cancel_at, cancelAtUnix(order.recurringDetails.startDate, "monthly", endDate));
  assert.ok(upd.a.cancel_at * 1000 > new Date(endDate).getTime());
});

test("weekly end date mid-week: cancel_at is an exact multiple of the weekly interval (no partial/prorated charge)", async () => {
  const stripe = h.makeStripe();
  h.setStripe(stripe);
  const endDate = dateInDays(25); // falls mid-week relative to a weekly cadence
  await run({
    items, paymentType: "recurring", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 25.5, stripePaymentMethodId: "pm_x",
    recurringDetails: { frequency: "weekly", endDate },
  });
  const order = lastOrder();
  const upd = stripe.last("subscriptions.update");
  const startSec = Math.floor(new Date(order.recurringDetails.startDate).getTime() / 1000);
  assert.equal((upd.a.cancel_at - startSec) % (7 * 86400), 0, "cancel_at must be a weekly boundary from the start");
  assert.ok(upd.a.cancel_at * 1000 > new Date(endDate).getTime());
});

test("recurring: order anchors to the subscription's ACTUAL start (Stripe's clock), not the app clock", async () => {
  // Simulate a Stripe (test) clock that's ~3 weeks ahead of the app server.
  const periodStart = Math.floor(Date.now() / 1000) + 21 * 86400;
  const stripe = h.makeStripe({ periodStart, periodEnd: periodStart + 7 * 86400 });
  h.setStripe(stripe);
  await run({
    items, paymentType: "recurring", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 25.5, stripePaymentMethodId: "pm_x",
    recurringDetails: { frequency: "weekly", endDate: dateInDays(120) },
  });
  const order = lastOrder();
  assert.equal(
    Math.floor(new Date(order.recurringDetails.startDate).getTime() / 1000),
    periodStart,
    "startDate must equal the subscription's current_period_start from Stripe"
  );
  assert.equal(
    Math.floor(new Date(order.recurringDetails.nextPaymentDate).getTime() / 1000),
    periodStart + 7 * 86400,
    "nextPaymentDate must equal the subscription's current_period_end from Stripe"
  );
});

test("recurring with NO end date: subscription has no cancel_at (runs indefinitely)", async () => {
  const stripe = h.makeStripe();
  h.setStripe(stripe);
  await run({
    items, paymentType: "recurring", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 51, stripePaymentMethodId: "pm_x",
    recurringDetails: { frequency: "monthly" },
  });
  assert.equal(stripe.last("subscriptions.create").cancel_at, undefined);
  assert.equal(stripe.count("subscriptions.update"), 0, "no cancellation scheduled without an end date");
});

test("recurring monthly with a far-future end date: nextPaymentDate is set (not yet past the end)", async () => {
  h.setStripe(h.makeStripe());
  await run({
    items, paymentType: "recurring", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 51, stripePaymentMethodId: "pm_x",
    recurringDetails: { frequency: "monthly", endDate: dateInDays(120) },
  });
  assert.ok(lastOrder().recurringDetails.nextPaymentDate, "next payment should be scheduled");
});

/* ── INSTALLMENTS ───────────────────────────────────────────────────────── */
test("installments: charges the first installment and records it with a receipt", async () => {
  const stripe = h.makeStripe();
  h.setStripe(stripe);
  const res = await run({
    items, paymentType: "installments", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 102, stripePaymentMethodId: "pm_x",
    installmentDetails: { numberOfInstallments: 3, installmentAmount: 34 },
  });
  assert.equal(res.body.status, "Success");
  assert.equal(stripe.last("paymentIntents.create").amount, 3400, "first installment in cents");
  const order = lastOrder();
  assert.equal(order.installmentDetails.installmentsPaid, 1);
  assert.equal(order.installmentDetails.installmentHistory.length, 1);
  assert.ok(order.installmentDetails.installmentHistory[0].receiptUrl, "first installment keeps a receipt");
  assert.ok(order.stripeReceiptUrl);
});

/* ── SAVED CARD on recurring / installments (reuses the donor's customer) ── */
test("recurring with a SAVED card reuses the donor's Stripe customer (no new customer)", async () => {
  const stripe = h.makeStripe({ pmCustomer: "cus_saved" }); // PM already attached to a customer
  h.setStripe(stripe);
  const res = await run({
    items, paymentType: "recurring", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 51, stripePaymentMethodId: "pm_saved",
    recurringDetails: { frequency: "monthly", endDate: dateInDays(120) },
  });
  assert.equal(res.body.status, "Success");
  assert.equal(stripe.count("customers.create"), 0, "must NOT create a new customer for a saved card");
  assert.ok(stripe.count("customers.retrieve") >= 1, "reuses the saved card's customer");
  assert.equal(stripe.count("subscriptions.create"), 1);
  assert.ok(lastOrder().recurringDetails.paymentHistory[0].receiptUrl);
});

test("recurring with a saved LINK payment method: subscription allows the 'link' type (no Stripe rejection)", async () => {
  const stripe = h.makeStripe({ pmCustomer: "cus_saved", pmType: "link" });
  h.setStripe(stripe);
  const res = await run({
    items, paymentType: "recurring", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 51, stripePaymentMethodId: "pm_link",
    recurringDetails: { frequency: "monthly", endDate: dateInDays(120) },
  });
  assert.equal(res.body.status, "Success");
  const types = stripe.last("subscriptions.create").payment_settings.payment_method_types;
  assert.ok(types.includes("link"), "payment_method_types must include the saved PM's type (link)");
  assert.ok(types.includes("card"));
});

test("installments with a SAVED card reuses the donor's Stripe customer (no new customer)", async () => {
  const stripe = h.makeStripe({ pmCustomer: "cus_saved" });
  h.setStripe(stripe);
  const res = await run({
    items, paymentType: "installments", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 102, stripePaymentMethodId: "pm_saved",
    installmentDetails: { numberOfInstallments: 3, installmentAmount: 34 },
  });
  assert.equal(res.body.status, "Success");
  assert.equal(stripe.count("customers.create"), 0, "must NOT create a new customer for a saved card");
  assert.ok(stripe.count("customers.retrieve") >= 1, "reuses the saved card's customer");
  assert.equal(lastOrder().installmentDetails.installmentsPaid, 1);
});

test("recurring with a saved card whose Stripe customer was DELETED: recovers by creating a fresh customer", async () => {
  // PM still references a customer that no longer exists in Stripe.
  const stripe = h.makeStripe({ pmCustomer: "cus_dead", customerDeleted: true });
  h.setStripe(stripe);
  const res = await run({
    items, paymentType: "recurring", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 51, stripePaymentMethodId: "pm_stale",
    recurringDetails: { frequency: "monthly", endDate: dateInDays(120) },
  });
  assert.equal(res.body.status, "Success", "stale saved card must not fail the donation");
  assert.ok(stripe.count("customers.create") >= 1, "creates a fresh customer when the saved one is gone");
  assert.ok(stripe.count("paymentMethods.attach") >= 1, "attaches the PM to the new customer");
  assert.equal(stripe.count("subscriptions.create"), 1);
});

test("recurring with a broken saved card (Link PM, customer gone, cannot re-attach): fails gracefully with a clear message", async () => {
  const stripe = h.makeStripe({ pmCustomer: "cus_dead", customerDeleted: true, attachFails: true, detachFails: true });
  h.setStripe(stripe);
  const res = await run({
    items, paymentType: "recurring", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 51, stripePaymentMethodId: "pm_link_stale",
    recurringDetails: { frequency: "monthly", endDate: dateInDays(120) },
  });
  assert.equal(res.statusCode, 400, "responds with an error, not a crash");
  assert.match(String(res.body.message || ""), /re-enter|saved card|no longer valid/i);
});

test("recurring with a stale CARD (customer gone, but PM detachable): recovers via detach + re-attach", async () => {
  // attach to the fresh customer fails first, but detach succeeds so re-attach works.
  const stripe = h.makeStripe({ pmCustomer: "cus_dead", customerDeleted: true, detachFails: false });
  // Make only the FIRST attach fail, then allow re-attach after detach.
  let attaches = 0;
  const origAttach = stripe.paymentMethods.attach;
  stripe.paymentMethods.attach = async (pm, a) => {
    attaches += 1;
    if (attaches === 1) throw Object.assign(new Error("already attached"), { code: "resource_already_exists" });
    return origAttach(pm, a);
  };
  h.setStripe(stripe);
  const res = await run({
    items, paymentType: "recurring", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 51, stripePaymentMethodId: "pm_card_stale",
    recurringDetails: { frequency: "monthly", endDate: dateInDays(120) },
  });
  assert.equal(res.body.status, "Success", "a detachable card recovers and the donation goes through");
  assert.ok(stripe.count("paymentMethods.detach") >= 1);
});

/* ── SAVED CARD on a ONE-TIME donation (customer ids are only a hint) ────── */
test("one-time with a brand-new card charges without a customer", async () => {
  const stripe = h.makeStripe();
  h.setStripe(stripe);
  await run({
    items, paymentType: "single", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 100, stripePaymentMethodId: "pm_new",
  });
  assert.equal(stripe.last("paymentIntents.create").customer, undefined, "no customer for a one-off card");
  assert.equal(stripe.count("customers.create"), 0);
});

test("one-time with a SAVED card charges on the customer the PM is attached to", async () => {
  const stripe = h.makeStripe({ pmCustomer: "cus_saved" });
  h.setStripe(stripe);
  const res = await run({
    items, paymentType: "single", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 100, stripePaymentMethodId: "pm_saved", stripeCustomerId: "cus_saved",
  });
  assert.equal(res.body.status, "Success");
  assert.equal(stripe.last("paymentIntents.create").customer, "cus_saved");
  assert.equal(stripe.count("customers.create"), 0, "must not mint a customer for a working saved card");
});

test("one-time with a saved card whose customer was DELETED: re-vaults instead of failing with 'No such customer'", async () => {
  // Exactly the reported failure: the customer was deleted in Stripe, which
  // detaches its payment methods — the client still posts the dead customer id.
  const stripe = h.makeStripe({ deadCustomers: ["cus_dead"] }); // PM now unattached
  h.setStripe(stripe);
  const res = await run({
    items, paymentType: "single", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 25.5, stripePaymentMethodId: "pm_saved", stripeCustomerId: "cus_dead",
  });
  assert.equal(res.body.status, "Success", "a stale customer id must not fail the donation");
  const pi = stripe.last("paymentIntents.create");
  assert.notEqual(pi.customer, "cus_dead", "never charges on the dead customer");
  assert.ok(pi.customer, "charges on the donor's live customer");
  assert.ok(stripe.count("paymentMethods.attach") >= 1, "re-vaults the card");
  assert.ok(
    h.pmUpdates.some((u) => u.update.$set?.stripeCustomerId === pi.customer),
    "heals the saved-card row so the next donation doesn't repeat the lookup"
  );
});

test("one-time with a saved card whose customer id is stale but still live: charges the customer the PM really has", async () => {
  const stripe = h.makeStripe({ pmCustomer: "cus_real" });
  h.setStripe(stripe);
  await run({
    items, paymentType: "single", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 100, stripePaymentMethodId: "pm_saved", stripeCustomerId: "cus_stale",
  });
  assert.equal(stripe.last("paymentIntents.create").customer, "cus_real", "the PM's own customer wins over the client's");
  assert.ok(h.pmUpdates.some((u) => u.update.$set?.stripeCustomerId === "cus_real"));
});

test("one-time with a permanently detached card: clear message and the dead card is retired", async () => {
  // Stripe burns a payment method once detached ("may not be used again").
  const stripe = h.makeStripe({ deadCustomers: ["cus_dead"], attachFails: true, detachFails: true });
  h.setStripe(stripe);
  const res = await run({
    items, paymentType: "single", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 25.5, stripePaymentMethodId: "pm_burned", stripeCustomerId: "cus_dead",
  });
  assert.equal(res.statusCode, 400, "responds with an error, not a Stripe stack trace");
  assert.match(String(res.body.message || ""), /no longer valid|add your card again/i);
  assert.ok(
    h.pmUpdates.some((u) => u.update.$set?.isActive === false),
    "the unusable card is deactivated so it stops appearing at checkout"
  );
});

/* ── VALIDATION ─────────────────────────────────────────────────────────── */
test("recurring without a frequency is rejected", async () => {
  const res = await run({
    items, paymentType: "recurring", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 51, stripePaymentMethodId: "pm_x", recurringDetails: {},
  });
  assert.equal(res.statusCode, 400);
});

test("installments outside 1–12 are rejected", async () => {
  const res = await run({
    items, paymentType: "installments", donorDetails: donor, paymentMethod: "visa",
    totalAmount: 102, stripePaymentMethodId: "pm_x",
    installmentDetails: { numberOfInstallments: 24, installmentAmount: 5 },
  });
  assert.equal(res.statusCode, 400);
});
