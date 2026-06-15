// models/PaymentMethod.js
const mongoose = require("mongoose");

const paymentMethodSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Tenant the card was saved under (cards live on that tenant's Stripe acct).
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      default: null,
      index: true,
    },
    type: {
      type: String,
      enum: ["credit_card", "debit_card", "bank_account"],
      required: true,
    },
    // ── Stripe references (the card itself lives in Stripe, never here) ──
    stripePaymentMethodId: { type: String, default: "" },
    stripeCustomerId: { type: String, default: "" },
    // Card brand from Stripe (visa, mastercard, amex, discover, etc.).
    brand: { type: String, default: "" },
    // For cards — last 4 digits only (safe to store/display in cleartext).
    cardNumber: {
      type: String,
      maxlength: 4,
    },
    cardType: {
      type: String,
      enum: ["visa", "mastercard", "amex", "discover"],
    },
    expiryMonth: {
      type: Number,
      min: 1,
      max: 12,
    },
    expiryYear: {
      type: Number,
    },
    // For bank accounts
    bankName: String,
    accountLastFour: String,
    routingNumber: String,
    isDefault: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("PaymentMethod", paymentMethodSchema);
