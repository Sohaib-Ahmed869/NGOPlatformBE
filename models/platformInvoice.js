const mongoose = require("mongoose");

/**
 * Local mirror of the platform's SaaS Stripe invoices (the platform billing the
 * tenant orgs for their subscription). Written by the SaaS webhook so the
 * operator console can show billing history without live Stripe calls.
 */
const platformInvoiceSchema = new mongoose.Schema(
  {
    organisationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organisation", default: null },
    stripeInvoiceId: { type: String, required: true, unique: true },
    stripeCustomerId: { type: String, default: "" },
    stripeSubscriptionId: { type: String, default: "" },
    number: { type: String, default: "" }, // Stripe's human invoice number
    amountDue: { type: Number, default: 0 }, // major units
    amountPaid: { type: Number, default: 0 },
    currency: { type: String, default: "usd" },
    status: { type: String, default: "open" }, // paid | open | failed | void | uncollectible
    hostedInvoiceUrl: { type: String, default: "" },
    invoicePdf: { type: String, default: "" },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true }
);

platformInvoiceSchema.index({ organisationId: 1, createdAt: -1 });
platformInvoiceSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("PlatformInvoice", platformInvoiceSchema);
