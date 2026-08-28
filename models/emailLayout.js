const mongoose = require("mongoose");

/**
 * The shared wrapper every transactional email renders inside: logo header,
 * card, footer, colours and type.
 *
 * This replaces the six divergent ad-hoc "shells" that used to live inline in
 * controllers (joinTeamController.emailShell, partnerInquiryController.shell,
 * and four one-off <div> wrappers) -- each of which styled the same email
 * furniture slightly differently. Edit this once and every email follows.
 *
 * Same two layers as EmailTemplate: organisationId = null is the platform
 * default; a row with an organisationId is that tenant's own wrapper.
 *
 * NOTHING here carries a default except organisationId. A row holds only the
 * fields an operator actually set, so a tenant who changes one colour keeps
 * inheriting the platform's header, footer and type. Give these fields Mongoose
 * defaults and every tenant row would arrive pre-filled with a complete layout,
 * silently overriding the platform's the moment it was created. The shipped
 * values live in services/emailBlocks.DEFAULT_LAYOUT, which resolveLayout()
 * merges each stored layer over.
 */
const emailLayoutSchema = new mongoose.Schema(
  {
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      // null IS the platform row -- the one default here that carries meaning.
      default: null,
      unique: true,
    },

    /* -- header -- */
    showHeader: { type: Boolean },
    showLogo: { type: Boolean },
    // "band" paints the header in the organisation's primary colour; "plain" is
    // the older bare-logo-on-the-page-background look.
    headerStyle: { type: String, enum: ["band", "plain"] },
    // Left unset this resolves to "{{org.logo}}" -- the tenant's own logo.
    logoUrl: { type: String },
    // The light-on-dark variant, used when the header is a band. Unset it
    // resolves to "{{org.logoLight}}".
    logoUrlOnDark: { type: String },
    logoHeight: { type: Number },
    headerAlign: { type: String, enum: ["left", "center", "right"] },
    headerTagline: { type: String },
    // The organisation's name set in type next to the logo. Off is for tenants
    // whose uploaded logo is already a wordmark.
    showBrandName: { type: Boolean },
    // A tiling texture on the header band -- see PATTERNS in emailBlocks.js.
    headerPattern: { type: String, enum: ["none", "mark", "rings", "dots", "grid", "weave", "waves"] },

    /* -- footer -- */
    footerText: { type: String },
    footerAlign: { type: String, enum: ["left", "center", "right"] },
    // "band" is the closing brand band joined to the card; "panel" is the same
    // shape in a pale tint; "plain" is the older bare text under the message.
    footerStyle: { type: String, enum: ["band", "panel", "plain"] },
    footerPattern: { type: String, enum: ["none", "mark", "rings", "dots", "grid", "weave", "waves"] },
    footerLinks: { type: [{ label: String, url: String, _id: false }] },
    legalText: { type: String },
    // "Powered by <platform>" -- off by default so a charity's mail looks like
    // the charity's mail. Plans can flip it on for the free tier.
    showPlatformCredit: { type: Boolean },
    platformCreditText: { type: String },

    // Text shown in the inbox preview line when a template doesn't set its own.
    preheader: { type: String },
    documentTitle: { type: String },

    /**
     * Design tokens consumed by services/emailBlocks.js. Anything left blank
     * falls back to DEFAULT_THEME there, so a partial theme is valid -- a tenant
     * that only wants to change the accent colour sets exactly one field.
     */
    theme: {
      fontFamily: { type: String },
      pageBg: { type: String },
      cardBg: { type: String },
      textColor: { type: String },
      mutedColor: { type: String },
      headingColor: { type: String },
      accentColor: { type: String },
      accentTextColor: { type: String },
      // The header band and the text on it.
      brandColor: { type: String },
      brandTextColor: { type: String },
      borderColor: { type: String },
      panelBg: { type: String },
      radius: { type: Number },
      contentWidth: { type: Number },
      fontSize: { type: Number },
    },

    updatedBy: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      name: { type: String },
      email: { type: String },
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("EmailLayout", emailLayoutSchema);
