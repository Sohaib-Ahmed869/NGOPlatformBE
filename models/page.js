const mongoose = require("mongoose");

/**
 * A single page of a tenant's public website.
 * One document per (organisation × page key). Structural fields (path,
 * navParentKey) are kept in sync from config/pageTemplates.js; content,
 * enabled, showInNav, navLabel and navOrder are tenant-editable.
 */
const pageSchema = new mongoose.Schema(
  {
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
      index: true,
    },
    key: {
      type: String,
      required: true,
    },
    path: {
      type: String,
      default: "",
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    showInNav: {
      type: Boolean,
      default: true,
    },
    navLabel: {
      type: String,
      default: "",
    },
    navOrder: {
      type: Number,
      default: 0,
    },
    navParentKey: {
      type: String,
      default: null,
    },
    // Per-template structured content (see config/pageTemplates.js).
    content: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    seo: {
      title: { type: String, default: "" },
      description: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

// One document per page per organisation.
pageSchema.index({ organisationId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model("Page", pageSchema);
