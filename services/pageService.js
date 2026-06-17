const Page = require("../models/page");
const Organisation = require("../models/organisation");
const { PAGE_TEMPLATES, getTemplate } = require("../config/pageTemplates");
const { getSectionDefaults } = require("../config/sectionTypes");

// Page templates tagged with a `vertical` are only seeded enabled when the
// organisation matches that vertical. Today the only vertical is "muslim"
// (the Islamic giving pages); everything else is enabled for all tenants.
const isVerticalEnabled = (template, org) =>
  template.vertical === "muslim" ? !!org?.isMuslimCharity : true;

/**
 * Deep-merge `override` onto `base`. Plain objects merge recursively; arrays
 * and primitives in `override` replace the base value wholesale. Used to layer
 * a tenant's saved content over the template defaults.
 */
function deepMerge(base, override) {
  if (Array.isArray(override) || override === null || typeof override !== "object") {
    return override === undefined ? base : override;
  }
  if (Array.isArray(base) || base === null || typeof base !== "object") {
    base = {};
  }
  const out = { ...base };
  for (const key of Object.keys(override)) {
    out[key] = deepMerge(base[key], override[key]);
  }
  return out;
}

/**
 * The full content for a page = template defaults with the tenant's saved
 * content layered on top.
 */
function mergedContent(template, storedContent) {
  return deepMerge(template?.defaults || {}, storedContent || {});
}

/**
 * Content to serve to the FE: template defaults merged with the tenant's saved
 * content, then — for a section-based page that has a `buildSections` hook but
 * no stored `sections` yet — sections synthesised from the merged content. This
 * lets pages like the initiative details become block-based without duplicating
 * their rich content as default sections.
 */
function serveContent(template, storedContent) {
  const c = mergedContent(template, storedContent);
  if (
    template &&
    template.sectionBased &&
    typeof template.buildSections === "function" &&
    !(Array.isArray(c.sections) && c.sections.length)
  ) {
    c.sections = template.buildSections(c);
  }
  // Backfill each saved section's data with its type defaults (saved values
  // always win). So a field ADDED to a section type after a tenant saved their
  // page — e.g. the logosStrip `source` toggle — applies everywhere
  // automatically, with no per-tenant edit. (The sections array is replaced
  // wholesale by deepMerge, so newly-added fields would otherwise never reach
  // tenants who already have saved content.)
  if (Array.isArray(c.sections)) {
    c.sections = c.sections.map((s) =>
      s && s.type ? { ...s, data: { ...getSectionDefaults(s.type), ...(s.data || {}) } } : s,
    );
  }
  return c;
}

/**
 * Idempotently ensure every template page exists for an organisation.
 * Uses atomic upserts so concurrent calls can't create duplicates (guarded by
 * the {organisationId, key} unique index). Tenant-editable fields are only set
 * on insert; structural fields (path, navParentKey) are kept in sync.
 */
async function seedPagesForOrg(organisationId) {
  // Vertical-gated templates (Islamic giving pages) are seeded enabled only for
  // Muslim charities; for everyone else they're inserted Hidden (the docs still
  // exist so an admin can opt in later from the Pages screen).
  const org = await Organisation.findById(organisationId).select("isMuslimCharity").lean();

  const ops = PAGE_TEMPLATES.map((t) => {
    const gated = t.vertical && !isVerticalEnabled(t, org);
    return {
      updateOne: {
        filter: { organisationId, key: t.key },
        update: {
          $setOnInsert: {
            organisationId,
            key: t.key,
            enabled: gated ? false : t.enabledByDefault !== false,
            showInNav: gated ? false : t.showInNav !== false,
            navLabel: t.navLabel || t.key,
            navOrder: typeof t.navOrder === "number" ? t.navOrder : 0,
            content: t.defaults || {},
            seo: { title: "", description: "" },
          },
          $set: {
            path: t.path,
            navParentKey: t.navParentKey || null,
          },
        },
        upsert: true,
      },
    };
  });

  if (ops.length) {
    await Page.bulkWrite(ops, { ordered: false });
  }
}

/**
 * Re-apply the vertical-gated page defaults for an org — call after the org's
 * `isMuslimCharity` flag changes. Forces the Islamic pages on (In menu) for
 * Muslim charities and off (Hidden) for everyone else. Other pages untouched.
 */
async function applyVerticalDefaults(organisationId) {
  const verticalKeys = PAGE_TEMPLATES.filter((t) => t.vertical === "muslim").map((t) => t.key);
  if (!verticalKeys.length) return;
  // Make sure the pages exist first (older tenants may predate them).
  await ensurePagesSeeded(organisationId);
  const org = await Organisation.findById(organisationId).select("isMuslimCharity").lean();
  const on = !!org?.isMuslimCharity;
  await Page.updateMany(
    { organisationId, key: { $in: verticalKeys } },
    { $set: { enabled: on, showInNav: on } },
  );
}

/**
 * Seed pages only when some are missing (cheap guard for the bootstrap path).
 */
async function ensurePagesSeeded(organisationId) {
  const count = await Page.countDocuments({ organisationId });
  if (count < PAGE_TEMPLATES.length) {
    await seedPagesForOrg(organisationId);
  }
}

/**
 * Lightweight page list used by the public site (nav + route gating).
 * No content — just structure.
 */
async function getNavPages(organisationId) {
  await ensurePagesSeeded(organisationId);
  const pages = await Page.find({ organisationId })
    .select("key path navLabel navParentKey navOrder showInNav enabled")
    .sort({ navOrder: 1 })
    .lean();
  return pages;
}

module.exports = {
  deepMerge,
  mergedContent,
  serveContent,
  seedPagesForOrg,
  applyVerticalDefaults,
  ensurePagesSeeded,
  getNavPages,
  PAGE_TEMPLATES,
  getTemplate,
};
