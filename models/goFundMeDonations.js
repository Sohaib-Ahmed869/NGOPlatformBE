// One donation to a GoFundMe campaign. Org-scoped like every operational model.
// Works for Stripe (stripePaymentIntentId) and PayPal (the same field stores the
// PayPal order/capture id) — `paymentMethod` distinguishes them.
const mongoose = require("mongoose");

const goFundMeDonationSchema = new mongoose.Schema(
  {
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
      index: true,
    },
    goFundMeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GoFundMe",
      required: true,
      index: true,
    },
    // The signed-in donor, when there was one (donations can be anonymous/guest).
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    donorName: { type: String, required: true },
    donorEmail: { type: String, required: true, lowercase: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    message: { type: String, default: "", trim: true },
    isAnonymous: { type: Boolean, default: false },

    // Stripe PaymentIntent id OR PayPal order id (unique guards against double-record).
    stripePaymentIntentId: { type: String, required: true },
    paymentStatus: {
      type: String,
      enum: ["pending", "completed", "failed", "refunded"],
      default: "pending",
    },
    paymentMethod: { type: String, default: "stripe" }, // visa | mastercard | paypal | stripe …
    transactionFee: { type: Number, default: 0 },
    netAmount: { type: Number, default: 0 },
    // Stripe's hosted receipt URL for the charge (captured on process-donation).
    stripeReceiptUrl: { type: String, default: "" },
  },
  { timestamps: true }
);

goFundMeDonationSchema.index({ stripePaymentIntentId: 1 }, { unique: true });
goFundMeDonationSchema.index({ goFundMeId: 1, paymentStatus: 1 });
goFundMeDonationSchema.index({ organisationId: 1, donorEmail: 1 });

module.exports = mongoose.model("GoFundMeDonation", goFundMeDonationSchema);
