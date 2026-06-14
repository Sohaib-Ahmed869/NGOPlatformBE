// Supporter-created, admin-moderated fundraising campaign ("GoFundMe"-style).
// Multi-tenant: every campaign belongs to one organisation. A signed-in user
// submits a request → admin approves → it goes live and collects donations
// (recorded in the GoFundMeDonation model) via the tenant's own Stripe/PayPal.
const mongoose = require("mongoose");

const goFundMeSchema = new mongoose.Schema(
  {
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    title: { type: String, required: [true, "Title is required"], trim: true, maxlength: 100 },
    description: { type: String, required: [true, "Description is required"], trim: true, maxlength: 2000 },
    personalStory: { type: String, required: [true, "Personal story is required"], trim: true, maxlength: 3000 },
    financialSituation: { type: String, required: [true, "Financial situation is required"], trim: true, maxlength: 1500 },
    reasonForFunding: { type: String, required: [true, "Reason for funding is required"], trim: true, maxlength: 1500 },

    targetAmount: { type: Number, required: [true, "Target amount is required"], min: 100, max: 1000000 },
    currentAmount: { type: Number, default: 0 },

    image: { type: String, required: [true, "Image is required"] },
    imagePath: { type: String, required: true }, // S3 key for cleanup

    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "completed", "deactivated"],
      default: "pending",
    },
    adminNotes: { type: String, trim: true },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    completedAt: { type: Date },

    slug: { type: String }, // unique per-org via the compound index below
    donationCount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },

    category: { type: String, required: true }, // free text; "other" pairs with customCategory
    customCategory: { type: String, trim: true },
    urgencyLevel: { type: String, enum: ["low", "medium", "high", "critical"], default: "medium" },
  },
  { timestamps: true }
);

// Slug is unique within a tenant (sparse so docs without one don't clash).
goFundMeSchema.index({ organisationId: 1, slug: 1 }, { unique: true, sparse: true });
goFundMeSchema.index({ organisationId: 1, status: 1 });

// Generate a tenant-safe slug from the title on first save.
goFundMeSchema.pre("save", function (next) {
  if (this.isModified("title") && !this.slug) {
    this.slug =
      this.title
        .toLowerCase()
        .replace(/[^a-zA-Z0-9]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") +
      "-" +
      Date.now();
  }
  next();
});

module.exports = mongoose.model("GoFundMe", goFundMeSchema);
