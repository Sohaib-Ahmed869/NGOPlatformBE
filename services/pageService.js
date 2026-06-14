const Page = require("../models/page");
const { PAGE_TEMPLATES, getTemplate } = require("../config/pageTemplates");

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
 * Idempotently ensure every template page exists for an organisation.
 * Uses atomic upserts so concurrent calls can't create duplicates (guarded by
 * the {organisationId, key} unique index). Tenant-editable fields are only set
 * on insert; structural fields (path, navParentKey) are kept in sync.
 */
async function seedPagesForOrg(organisationId) {
  const ops = PAGE_TEMPLATES.map((t) => ({
    updateOne: {
      filter: { organisationId, key: t.key },
      update: {
        $setOnInsert: {
          organisationId,
          key: t.key,
          enabled: t.enabledByDefault !== false,
          showInNav: t.showInNav !== false,
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
  }));

  if (ops.length) {
    await Page.bulkWrite(ops, { ordered: false });
  }
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
  seedPagesForOrg,
  ensurePagesSeeded,
  getNavPages,
  PAGE_TEMPLATES,
  getTemplate,
};
