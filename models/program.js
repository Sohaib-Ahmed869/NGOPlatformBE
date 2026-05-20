const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const programSchema = new Schema(
  {
    organisationId: {
      type: Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: [true, "Program title is required"],
      trim: true,
    },
    description: {
      type: String,
    },
    goalAmount: {
      type: Number,
      required: [true, "Goal amount is required"],
      min: 0,
    },
    raisedAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ["published", "hidden", "completed"],
      default: "published",
    },
    images: [
      {
        url: { type: String, required: true },
        key: { type: String, required: true },
      },
    ],
    coverImageIndex: {
      type: Number,
      default: 0,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    followUpUpdates: [
      {
        text: { type: String, required: true },
        images: [String],
        sentAt: { type: Date, default: Date.now },
      },
    ],
    followUpRequests: [
      {
        userId: { type: Schema.Types.ObjectId, ref: "User" },
        message: { type: String, default: "" },
        requestedAt: { type: Date, default: Date.now },
        status: {
          type: String,
          enum: ["pending", "acknowledged"],
          default: "pending",
        },
      },
    ],
    donors: [
      {
        userId: { type: Schema.Types.ObjectId, ref: "User" },
        donationId: { type: Schema.Types.ObjectId, ref: "Order" },
        email: String,
      },
    ],
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Program", programSchema);
