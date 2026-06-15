// Partner Inquiry Model
//
// One document per "Become a partner" enquiry submitted from the public Our
// Partners page. Org-scoped like every other operational model; managed from
// the admin portal (status workflow + internal notes).
const mongoose = require("mongoose");

const partnerInquirySchema = new mongoose.Schema(
  {
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      default: null,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    organisationName: { type: String, default: "", trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, default: "" },
    website: { type: String, default: "" },

    partnershipType: {
      type: String,
      enum: ["corporate", "community", "in-kind", "ambassador", "other"],
      default: "other",
    },
    message: { type: String, default: "" },

    // Optional brand logo the applicant uploads (stored in S3, like avatars).
    logoUrl: { type: String, default: "" },
    logoKey: { type: String, default: "" }, // S3 object key (for cleanup on delete)

    // Admin workflow
    status: {
      type: String,
      enum: ["new", "in_review", "contacted", "approved", "declined"],
      default: "new",
    },
    adminNotes: { type: String, default: "" },

    source: { type: String, default: "website" },
  },
  { timestamps: true }
);

partnerInquirySchema.index({ organisationId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("PartnerInquiry", partnerInquirySchema);
