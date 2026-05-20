const mongoose = require("mongoose");

const brandingRequestSchema = new mongoose.Schema(
  {
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // What they want to change to
    requestedBranding: {
      logo: String,
      primaryColor: String,
      accentColor: String,
      backgroundColor: String,
      theme: String,
      tagline: String,
    },
    // Current branding at time of request (for comparison)
    currentBranding: {
      logo: String,
      primaryColor: String,
      accentColor: String,
      backgroundColor: String,
      theme: String,
      tagline: String,
    },
    message: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    reviewNote: {
      type: String,
      default: "",
    },
    reviewedAt: Date,
  },
  {
    timestamps: true,
  }
);

brandingRequestSchema.index({ organisationId: 1, status: 1 });

module.exports = mongoose.model("BrandingRequest", brandingRequestSchema);
