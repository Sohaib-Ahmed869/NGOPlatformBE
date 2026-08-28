const mongoose = require("mongoose");

/**
 * An OVERRIDE of one entry in config/emailCatalog.js.
 *
 * There are two layers:
 *   organisationId = null  -> the platform default, edited in the SuperAdmin console
 *   organisationId = <id>  -> that tenant's own version, edited in their admin portal
 *
 * Resolution at send time is tenant -> platform -> the catalog file (see
 * services/emailTemplates.js). A row is never required: deleting one is exactly
 * what "Reset to default" does, which is why a reset can't leave a broken
 * template behind and a fresh install needs no seed.
 */
const emailTemplateSchema = new mongoose.Schema(
  {
    // Catalog key, e.g. "donation.receipt". Not an enum: the catalog is the
    // authority and validating here would mean a schema change per new email.
    key: { type: String, required: true, trim: true, index: true },

    // null = the platform-wide default. Sparse-friendly: see the compound index.
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      default: null,
      index: true,
    },

    subject: { type: String, default: "" },
    // Hidden preview text shown next to the subject in most inbox lists.
    preheader: { type: String, default: "" },

    // "blocks" = authored in the visual builder (the default and the safe path).
    // "html"   = raw HTML, for operators who want full control. Both are stored
    // so switching modes back and forth never loses the other version's work.
    mode: { type: String, enum: ["blocks", "html"], default: "blocks" },
    blocks: { type: [mongoose.Schema.Types.Mixed], default: [] },
    html: { type: String, default: "" },

    // Off = this email is not sent at all. Templates flagged `required` in the
    // catalog ignore this (the API refuses to set it) -- switching off a receipt
    // or a password reset breaks a legal or security obligation.
    enabled: { type: Boolean, default: true },

    // Denormalised so the console can show "edited by" without a second lookup.
    updatedBy: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      name: { type: String, default: "" },
      email: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

// One row per (email, layer). A second platform default for the same key would
// make "which template wins?" ambiguous, so the database refuses it.
emailTemplateSchema.index({ key: 1, organisationId: 1 }, { unique: true });

module.exports = mongoose.model("EmailTemplate", emailTemplateSchema);
