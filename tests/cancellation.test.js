const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./_harness");

beforeEach(() => {
  h.resetStore();
  h.setStripe(h.makeStripe());
});

function seedActiveSub() {
  return h.seedOrder({
    _id: "sub1",
    user: "user1",
    paymentType: "recurring",
    paymentMethod: "card",
    paymentStatus: "active",
    organisationId: "org1",
    transactionDetails: { stripeSubscriptionId: "sub_x" },
    recurringDetails: { frequency: "monthly", paymentHistory: [], status: "active" },
  });
}
const req = (extra) => h.makeReq(extra.body || {}, { params: extra.params, user: extra.user || { _id: "user1" } });

/* ── user request ───────────────────────────────────────────────────────── */
test("user cancel = a REQUEST: marks pending_cancellation, records audit, does NOT cancel in Stripe", async () => {
  const stripe = h.makeStripe();
  h.setStripe(stripe);
  const order = seedActiveSub();

  const res = h.makeRes();
  await h.subCtrl.cancelSubscription(req({ params: { subscriptionId: "sub1" }, body: { reason: "Too expensive" } }), res);

  assert.equal(res.body.status, "Success");
  assert.equal(order.paymentStatus, "pending_cancellation");
  assert.equal(order.cancellationDetails.status, "pending");
  assert.equal(order.cancellationDetails.reason, "Too expensive");
  assert.equal(String(order.cancellationDetails.requestedBy), "user1");
  assert.ok(order.cancellationDetails.date);
  // The donor's request must NOT cancel the live Stripe subscription — admin moderates that.
  assert.equal(stripe.count("subscriptions.cancel"), 0, "Stripe not cancelled on user request");
});

test("user can only cancel their OWN subscription", async () => {
  seedActiveSub();
  const res = h.makeRes();
  await h.subCtrl.cancelSubscription(req({ params: { subscriptionId: "sub1" }, user: { _id: "someone-else" } }), res);
  assert.equal(res.statusCode, 404);
});

test("default reason is captured when none provided", async () => {
  const order = seedActiveSub();
  const res = h.makeRes();
  await h.subCtrl.cancelSubscription(req({ params: { subscriptionId: "sub1" }, body: {} }), res);
  assert.equal(order.cancellationDetails.reason, "User requested cancellation");
});

/* ── admin approval (this is when Stripe actually cancels) ───────────────── */
test("admin APPROVE: cancels in Stripe, marks cancelled, records approver + date", async () => {
  const stripe = h.makeStripe();
  h.setStripe(stripe);
  const order = seedActiveSub();
  order.paymentStatus = "pending_cancellation";
  order.cancellationDetails = { date: new Date(), reason: "Too expensive", requestedBy: "user1", status: "pending" };

  const res = h.makeRes();
  await h.adminSubCtrl.approveCancellationRequest(
    h.makeReq({}, { params: { subscriptionId: "sub1" }, user: { _id: "admin1" } }),
    res
  );

  assert.equal(res.body.status, "Success");
  assert.equal(stripe.count("subscriptions.cancel"), 1, "Stripe subscription cancelled on approval");
  assert.equal(stripe.last("subscriptions.cancel"), "sub_x");
  assert.equal(order.paymentStatus, "cancelled");
  assert.equal(order.cancellationDetails.status, "approved");
  assert.equal(String(order.cancellationDetails.approvedBy), "admin1");
  assert.ok(order.cancellationDetails.approvalDate);
});

test("admin DENY: reverts to active, records denier + reason, no Stripe cancel", async () => {
  const stripe = h.makeStripe();
  h.setStripe(stripe);
  const order = seedActiveSub();
  order.paymentStatus = "pending_cancellation";
  order.cancellationDetails = { date: new Date(), reason: "Too expensive", requestedBy: "user1", status: "pending" };

  const res = h.makeRes();
  await h.adminSubCtrl.denyCancellationRequest(
    h.makeReq({ reason: "Please stay one more month" }, { params: { subscriptionId: "sub1" }, user: { _id: "admin1" } }),
    res
  );

  assert.equal(res.body.status, "Success");
  assert.equal(stripe.count("subscriptions.cancel"), 0);
  assert.equal(order.paymentStatus, "active");
  assert.equal(order.cancellationDetails.status, "denied");
  assert.equal(String(order.cancellationDetails.deniedBy), "admin1");
  assert.equal(order.cancellationDetails.denialReason, "Please stay one more month");
});

test("approving a non-pending subscription is rejected", async () => {
  seedActiveSub(); // status "active", not pending
  const res = h.makeRes();
  await h.adminSubCtrl.approveCancellationRequest(
    h.makeReq({}, { params: { subscriptionId: "sub1" }, user: { _id: "admin1" } }),
    res
  );
  assert.equal(res.statusCode, 404);
});
