const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./_harness");

beforeEach(() => {
  h.resetStore();
  h.setStripe(h.makeStripe());
});

async function fireWebhook(event) {
  const res = h.makeRes();
  const req = h.makeReq(undefined, {
    params: { slug: "test" },
    headers: { "stripe-signature": "sig" },
    rawBody: JSON.stringify(event),
  });
  await h.subCtrl.handleStripeWebhook(req, res);
  return res;
}

const future = () => new Date(Date.now() + 120 * 86400000);

/* ── recurring renewal ──────────────────────────────────────────────────── */
test("invoice.payment_succeeded (recurring): records the renewal WITH its Stripe receipt", async () => {
  const order = h.seedOrder({
    paymentType: "recurring",
    organisationId: "org1",
    transactionDetails: { stripeSubscriptionId: "sub_x" },
    recurringDetails: { frequency: "monthly", endDate: future(), totalPayments: 1, paymentHistory: [] },
  });

  await fireWebhook({
    type: "invoice.payment_succeeded",
    data: { object: { id: "in_2", subscription: "sub_x", amount_paid: 5100, charge: "ch_2", status_transitions: { paid_at: Math.floor(Date.now() / 1000) } } },
  });

  assert.equal(order.recurringDetails.paymentHistory.length, 1, "renewal appended to the trail");
  const entry = order.recurringDetails.paymentHistory[0];
  assert.equal(entry.invoiceId, "in_2");
  assert.equal(entry.status, "succeeded");
  assert.equal(entry.receiptUrl, "https://receipt/charge/ch_2", "per-payment receipt stored");
  assert.equal(order.stripeReceiptUrl, "https://receipt/charge/ch_2", "latest receipt on order");
  assert.equal(order.recurringDetails.totalPayments, 2);
});

test("invoice.payment_succeeded is idempotent (same invoice twice → one history entry)", async () => {
  const order = h.seedOrder({
    paymentType: "recurring",
    organisationId: "org1",
    transactionDetails: { stripeSubscriptionId: "sub_x" },
    recurringDetails: { frequency: "monthly", endDate: future(), totalPayments: 1, paymentHistory: [] },
  });
  const ev = {
    type: "invoice.payment_succeeded",
    data: { object: { id: "in_dup", subscription: "sub_x", amount_paid: 5100, charge: "ch_d", status_transitions: { paid_at: Math.floor(Date.now() / 1000) } } },
  };
  await fireWebhook(ev);
  await fireWebhook(ev);
  assert.equal(order.recurringDetails.paymentHistory.length, 1, "duplicate invoice not double-counted");
});

/* ── installment renewal via PaymentIntent ──────────────────────────────── */
test("payment_intent.succeeded (installment): records the installment WITH its Stripe receipt", async () => {
  const order = h.seedOrder({
    paymentType: "installments",
    organisationId: "org1",
    installmentDetails: { numberOfInstallments: 3, installmentsPaid: 1, installmentHistory: [] },
  });

  await fireWebhook({
    type: "payment_intent.succeeded",
    data: { object: { id: "pi_inst2", amount: 3400, metadata: { orderId: String(order._id), installment: "2" }, latest_charge: { receipt_url: "https://receipt/pi_inst2" } } },
  });

  const entry = order.installmentDetails.installmentHistory.find((e) => e.transactionId === "pi_inst2");
  assert.ok(entry, "installment recorded in history");
  assert.equal(entry.receiptUrl, "https://receipt/pi_inst2", "per-installment receipt stored");
  assert.equal(order.installmentDetails.installmentsPaid, 2);
  assert.equal(order.stripeReceiptUrl, "https://receipt/pi_inst2");
});

/* ── failed renewal ─────────────────────────────────────────────────────── */
test("invoice.payment_failed (recurring): records a FAILED entry with no receipt", async () => {
  const order = h.seedOrder({
    paymentType: "recurring",
    organisationId: "org1",
    transactionDetails: { stripeSubscriptionId: "sub_x" },
    recurringDetails: { frequency: "monthly", endDate: future(), totalPayments: 1, paymentHistory: [] },
  });

  await fireWebhook({
    type: "invoice.payment_failed",
    data: { object: { id: "in_f", subscription: "sub_x", amount_due: 5100, attempt_count: 1, last_payment_error: { message: "card declined" } } },
  });

  const entry = order.recurringDetails.paymentHistory[0];
  assert.equal(entry.status, "failed");
  assert.ok(!entry.receiptUrl, "failed charge has no receipt");
});

/* ── nextPaymentDate after a renewal (intended: advances to a future date) ── */
test("recurring renewal advances nextPaymentDate to a valid future date", async () => {
  const order = h.seedOrder({
    paymentType: "recurring",
    organisationId: "org1",
    transactionDetails: { stripeSubscriptionId: "sub_x" },
    recurringDetails: { frequency: "monthly", endDate: future(), totalPayments: 1, paymentHistory: [], nextPaymentDate: new Date() },
  });

  await fireWebhook({
    type: "invoice.payment_succeeded",
    data: { object: { id: "in_3", subscription: "sub_x", amount_paid: 5100, charge: "ch_3", status_transitions: { paid_at: Math.floor(Date.now() / 1000) } } },
  });

  const npd = order.recurringDetails.nextPaymentDate;
  assert.ok(npd, "nextPaymentDate should be set after a renewal (not null)");
  assert.ok(!isNaN(new Date(npd).getTime()), "nextPaymentDate should be a valid date");
  assert.ok(new Date(npd).getTime() > Date.now(), "nextPaymentDate should be in the future");
});
