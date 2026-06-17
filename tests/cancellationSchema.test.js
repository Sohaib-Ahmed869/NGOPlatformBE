// Uses the REAL Mongoose Order model (this file does NOT load the harness, and
// node --test isolates each file in its own process). Guards against the schema
// silently dropping the cancellation audit fields.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Order = require("../models/order");

const ID = "507f1f77bcf86cd799439011";

test("Order.cancellationDetails persists the full request → moderation audit trail", () => {
  const doc = new Order({
    paymentType: "recurring",
    cancellationDetails: {
      date: new Date(),
      reason: "Too expensive",
      requestedBy: ID,
      status: "pending",
      approvedBy: ID,
      approvalDate: new Date(),
      deniedBy: ID,
      denialDate: new Date(),
      denialReason: "stay please",
    },
  });
  const cd = doc.cancellationDetails;
  assert.equal(cd.reason, "Too expensive");
  assert.ok(cd.requestedBy, "requestedBy must persist");
  assert.equal(cd.status, "pending", "status must persist");
  assert.ok(cd.approvedBy, "approvedBy must persist");
  assert.ok(cd.approvalDate, "approvalDate must persist");
  assert.ok(cd.deniedBy, "deniedBy must persist");
  assert.ok(cd.denialDate, "denialDate must persist");
  assert.equal(cd.denialReason, "stay please", "denialReason must persist");
});

test("cancellationDetails.status only accepts pending/approved/denied", () => {
  const doc = new Order({ paymentType: "recurring", cancellationDetails: { status: "bogus" } });
  const err = doc.validateSync();
  assert.ok(err && err.errors["cancellationDetails.status"], "invalid status should fail validation");
});
