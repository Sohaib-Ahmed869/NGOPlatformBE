// models/PaymentMethod.js
const mongoose = require("mongoose");

const paymentMethodSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: ["credit_card", "debit_card", "bank_account"],
      required: true,
    },
    // For cards
    cardNumber: {
      type: String,
      // Store last 4 digits only for security
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
