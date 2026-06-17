const mongoose = require("mongoose");

/**
 * A published snapshot of a tenant page's content, kept for the revision
 * history / rollback feature. One document per publish (the version that was
 * live BEFORE a new publish replaced it). Capped to the most recent N per
 * (organisation × page) by the controller.
 */
const pageRevisionSchema = new mongoose.Schema(
  {
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
      index: true,
    },
    pageKey: { type: String, required: true },
    content: { type: mongoose.Schema.Types.Mixed, default: {} },
    note: { type: String, default: "" },
  },
  { timestamps: true }
);

pageRevisionSchema.index({ organisationId: 1, pageKey: 1, createdAt: -1 });

module.exports = mongoose.model("PageRevision", pageRevisionSchema);
