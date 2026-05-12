// Update your Order model with subscription-related fields
const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const OrderSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId, 
      ref: "User",
      required: false, // Allow anonymous donations
    },
    donationId: {
      type: String,
      required: true,
      unique: true,
    },
    items: [
      {
        title: String,
        price: Number,
        quantity: {
          type: Number,
          default: 1,
        },
        onBehalfOf: String,
      },
    ],
    paymentType: {
      type: String,
      enum: ["single", "recurring", "installments"],
      required: true,
    },
    donationType:{
      type:String,
      require:true,
    },
    adminCostContribution: {
      included: {
        type: Boolean,
        default: false,
      },
      amount: {
        type: Number,
        default: 0,
      },
    },
    donorDetails: {
      name: String,
      phone: String,
      email: String,
      address: {
        street: String,
        city: String,
        state: String,
        postcode: String,
      },
      agreeToMessages: Boolean,
    },
    paymentMethod: {
      type: String,
      enum: ["visa", "mastercard", "bank", "card"],
      required: true,
    }    
    ,
    paymentStatus: {
      type: String,
      enum: [
        "pending",
        "processing",
        "completed",
        "failed",
        "requires_action",
        "active",
        "paused",
        "cancelled",
        "past_due",
        "ended",
        "pending_cancellation"
      ],
      default: "pending",
    },
    totalAmount: {
      type: Number,
      required: true,
    },
    // Recurring payment details
    // recurringDetails: {
    //   frequency: {
    //     type: String,
    //     enum: ["daily", "weekly", "monthly", "yearly"],
    //     required: true,
    //   },
    //   amount: {
    //     type: Number,
    //     required: true,
    //   },
    //   startDate: {
    //     type: Date,
    //     default: Date.now,
    //   },
    //   endDate: {
    //     type: Date,
    //     validate: {
    //       validator: function (value) {
    //         if (!value) return true;
    //         return value > this.startDate;
    //       },
    //       message: "End date must be after the start date",
    //     },
    //   },
    //   status: {
    //     type: String,
    //     enum: ["active", "paused", "cancelled"],
    //     default: "active",
    //   },
    //   nextPaymentDate: {
    //     type: Date,
    //   },
    //   totalPayments: {
    //     type: Number,
    //     default: 0,
    //   },
    //   paymentHistory: [
    //     {
    //       date: Date,
    //       amount: Number,
    //       invoiceId: String,
    //       status: {
    //         type: String,
    //         enum: ["succeeded", "failed", "pending"],
    //       },
    //       failureReason: String,
    //     },
    //   ],
    // },
    
    // // Installment payment details
    // installmentDetails: {
    //   numberOfInstallments: Number,
    //   installmentAmount: Number,
    //   startDate: Date,
    //   status: {
    //     type: String,
    //     enum: ["active", "paused", "cancelled", "completed"],
    //     default: "active",
    //   },
    //   installmentsPaid: {
    //     type: Number,
    //     default: 0,
    //   },
    //   nextInstallmentDate: Date,
    //   installmentHistory: [
    //     {
    //       installmentNumber: Number,
    //       date: Date,
    //       amount: Number,
    //       status: String,
    //       transactionId: String,
    //       failureReason: String,
    //     },
    //   ],
    // },

    recurringDetails: {
      type: new Schema(
        {
          frequency: {
            type: String,
            enum: ["daily", "weekly", "monthly", "yearly"],
            required: true,
          },
          amount: {
            type: Number,
            required: true,
          },
          startDate: {
            type: Date,
            default: Date.now,
          },
          endDate: {
            type: Date,
            validate: {
              validator: function (value) {
                if (!value) return true;
                return value > this.startDate;
              },
              message: "End date must be after the start date",
            },
          },
          status: {
            type: String,
            enum: ["active", "paused", "cancelled","ended"],
            default: "active",
          },
          nextPaymentDate: Date,
          totalPayments: {
            type: Number,
            default: 0,
          },
          paymentHistory: [
            {
              date: Date,
              amount: Number,
              invoiceId: String,
              status: {
                type: String,
                enum: ["succeeded", "failed", "pending"],
              },
              failureReason: String,
            },
          ],
        },
        { _id: false }
      ),
      default: undefined, // Do not instantiate an empty object by default
    },
    installmentDetails: {
      type: new Schema(
        {
          numberOfInstallments: Number,
          installmentAmount: Number,
          startDate: Date,
          status: {
            type: String,
            enum: ["active", "paused", "cancelled", "completed","ended"],
            default: "active",
          },
          installmentsPaid: {
            type: Number,
            default: 0,
          },
          nextInstallmentDate: Date,
          installmentHistory: [
            {
              installmentNumber: Number,
              date: Date,
              amount: Number,
              status: String,
              transactionId: String,
              failureReason: String,
            },
          ],
          paymentIntervalDays: Number,
        },
        { _id: false }
      ),
      default: undefined,
    },
    // Transaction details
    transactionDetails: {
      type: Schema.Types.Mixed, // Flexible schema for different payment methods
      default: {},
    },
    // Pause history
    pauseHistory: [
      {
        startDate: Date,
        endDate: Date,
        actualEndDate: Date, // When the pause was actually ended
        reason: String,
      },
    ],
    // Amount update history
    amountHistory: [
      {
        oldAmount: Number,
        newAmount: Number,
        date: Date,
      },
    ],
    // Cancellation details
    cancellationDetails: {
      date: Date,
      reason: String,
      cancelledBy: Schema.Types.ObjectId, // User or admin ID
    },
    receiptUrl: {
      type: String,
      default: "",
    },
    lastPaymentDate: Date,
  },
  {
    timestamps: true,
  }
);

// Pre-save hook to update lastPaymentDate when payment history is updated
OrderSchema.pre("save", function (next) {
  const order = this;

  // Update lastPaymentDate for recurring payments
  if (
    order.recurringDetails &&
    order.recurringDetails.paymentHistory &&
    order.recurringDetails.paymentHistory.length > 0
  ) {
    const lastPayment =
      order.recurringDetails.paymentHistory[
        order.recurringDetails.paymentHistory.length - 1
      ];
    if (lastPayment.status === "succeeded") {
      order.lastPaymentDate = lastPayment.date;
    }
  }

  // Update lastPaymentDate for installment payments
  if (
    order.installmentDetails &&
    order.installmentDetails.installmentHistory &&
    order.installmentDetails.installmentHistory.length > 0
  ) {
    const lastInstallment =
      order.installmentDetails.installmentHistory[
        order.installmentDetails.installmentHistory.length - 1
      ];
    if (lastInstallment.status === "completed") {
      order.lastPaymentDate = lastInstallment.date;
    }
  }

  next();
});

// Create virtual property for remaining installments
OrderSchema.virtual("remainingInstallments").get(function () {
  if (!this.installmentDetails) return 0;
  return Math.max(
    0,
    this.installmentDetails.numberOfInstallments -
      this.installmentDetails.installmentsPaid
  );
});

// Create virtual property for subscription status
OrderSchema.virtual("subscriptionStatus").get(function () {
  if (this.paymentType === "single") return null;

  if (this.paymentStatus === "cancelled") return "Cancelled";
  if (this.paymentStatus === "paused") return "Paused";
  if (this.paymentStatus === "ended") return "Ended";
  if (this.paymentStatus === "failed") return "Failed";
  if (this.paymentStatus === "past_due") return "Past Due";
  if (this.paymentStatus === "pending_cancellation") return "Cancellation Pending";

  if (
    this.paymentType === "installments" &&
    this.installmentDetails &&
    this.installmentDetails.installmentsPaid >=
      this.installmentDetails.numberOfInstallments
  ) {
    return "Completed";
  }

  return "Active";
});

const Order = mongoose.model("Order", OrderSchema);

module.exports = Order;
