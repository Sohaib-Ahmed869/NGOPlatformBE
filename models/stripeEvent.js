const mongoose = require("mongoose");

/**
 * Idempotency ledger for processed Stripe webhook events. The handler inserts the
 * event id BEFORE processing; a duplicate-key error means the event was already
 * handled (Stripe retried), so it is skipped. If processing then fails, the row
 * is removed so Stripe's retry reprocesses it.
 */
const stripeEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    type: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("StripeEvent", stripeEventSchema);
