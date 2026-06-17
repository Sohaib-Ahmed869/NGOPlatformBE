const Page = require("../models/page");
const {
  mergedContent,
  serveContent,
  ensurePagesSeeded,
  seedPagesForOrg,
  getTemplate,
} = require("../services/pageService");
const PageRevision = require("../models/pageRevision");
const { PAGE_TEMPLATES } = require("../config/pageTemplates");
const { SECTION_TYPES } = require("../config/sectionTypes");
const { pageMinPlan, planAllows } = require("../config/planTiers");
const { deleteByUrl, keyFromUrl } = require("../config/s3");

// Keep at most this many published revisions per (org × page).
const MAX_REVISIONS = 20;

// True when a page has saved-but-unpublished draft content.
const hasDraft = (page) =>
  page && page.draftContent != null && JSON.stringify(page.draftContent) !== JSON.stringify(page.content || {});

// The content the admin editor should load: the draft if one exists, else the
// published content.
const editableContent = (page) => (page && page.draftContent != null ? page.draftContent : page?.content);

// Walk any JSON value and collect every string that is one of OUR S3 object
// URLs (keyFromUrl returns null for external URLs like unsplash).
function collectBucketUrls(node, set = new Set()) {
  if (!node) return set;
  if (typeof node === "string") {
    if (keyFromUrl(node)) set.add(node);
  } else if (Array.isArray(node)) {
    node.forEach((v) => collectBucketUrls(v, set));
  } else if (typeof node === "object") {
    Object.values(node).forEach((v) => collectBucketUrls(v, set));
  }
  return set;
}

/**
 * GET /api/pages/:key   (public, tenant-scoped)
 * Full content for one page (template defaults + tenant edits).
 */
exports.getPageContent = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    const { key } = req.params;
    const template = getTemplate(key);
    if (!template) {
      return res.status(404).json({ error: "Unknown page" });
    }

    const page = await Page.findOne({ organisationId: orgId, key }).lean();

    res.json({
      key,
      path: template.path,
      editable: !!template.editable,
      enabled: page ? page.enabled : true,
      navLabel: page?.navLabel || template.navLabel,
      content: serveContent(template, page?.content),
      seo: page?.seo || { title: "", description: "" },
    });
  } catch (error) {
    console.error("Get page content error:", error);
    res.status(500).json({ error: "Failed to fetch page" });
  }
};

/**
 * GET /api/admin/pages   (admin, tenant-scoped)
 * All pages for the org with structure, schema and merged content — drives
 * the admin Pages screen and its generic editor.
 */
exports.listPages = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    await ensurePagesSeeded(orgId);
    const docs = await Page.find({ organisationId: orgId }).sort({ navOrder: 1 }).lean();
    const byKey = docs.reduce((acc, d) => ((acc[d.key] = d), acc), {});
    const orgPlan = req.organisation?.plan;

    // Return in template order so the admin list is stable.
    const pages = PAGE_TEMPLATES.map((t) => {
      const doc = byKey[t.key] || {};
      const minPlan = pageMinPlan(t.key);
      return {
        key: t.key,
        path: t.path,
        navLabel: doc.navLabel || t.navLabel,
        navParentKey: t.navParentKey || null,
        navOrder: typeof doc.navOrder === "number" ? doc.navOrder : t.navOrder || 0,
        showInNav: doc.showInNav !== undefined ? doc.showInNav : t.showInNav !== false,
        enabled: doc.enabled !== undefined ? doc.enabled : true,
        editable: !!t.editable,
        sectionBased: !!t.sectionBased,
        hasFixedContent: !!t.hasFixedContent,
        hasUnpublishedChanges: hasDraft(doc),
        publishedAt: doc.publishedAt || null,
        minPlan,
        locked: !planAllows(orgPlan, minPlan), // content editing requires this plan
        schema: t.schema || [],
        // The editor edits the DRAFT (falls back to published when none).
        content: serveContent(t, editableContent(doc)),
        seo: doc.seo || { title: "", description: "" },
      };
    });

    res.json({ pages });
  } catch (error) {
    console.error("List pages error:", error);
    res.status(500).json({ error: "Failed to fetch pages" });
  }
};

/**
 * GET /api/admin/pages/:key   (admin, tenant-scoped)
 */
exports.getPageAdmin = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    const { key } = req.params;
    const template = getTemplate(key);
    if (!template) {
      return res.status(404).json({ error: "Unknown page" });
    }

    await ensurePagesSeeded(orgId);
    const doc = (await Page.findOne({ organisationId: orgId, key }).lean()) || {};

    res.json({
      key,
      path: template.path,
      navLabel: doc.navLabel || template.navLabel,
      navParentKey: template.navParentKey || null,
      navOrder: typeof doc.navOrder === "number" ? doc.navOrder : template.navOrder || 0,
      showInNav: doc.showInNav !== undefined ? doc.showInNav : template.showInNav !== false,
      enabled: doc.enabled !== undefined ? doc.enabled : true,
      editable: !!template.editable,
      sectionBased: !!template.sectionBased,
      hasFixedContent: !!template.hasFixedContent,
      minPlan: pageMinPlan(key),
      locked: !planAllows(req.organisation?.plan, pageMinPlan(key)),
      schema: template.schema || [],
      content: serveContent(template, editableContent(doc)),
      hasUnpublishedChanges: hasDraft(doc),
      publishedAt: doc.publishedAt || null,
      seo: doc.seo || { title: "", description: "" },
    });
  } catch (error) {
    console.error("Get page (admin) error:", error);
    res.status(500).json({ error: "Failed to fetch page" });
  }
};

/**
 * PUT /api/admin/pages/:key   (admin, tenant-scoped)
 * Update toggle/nav/content/seo for a page.
 */
exports.updatePage = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    const { key } = req.params;
    const template = getTemplate(key);
    if (!template) {
      return res.status(404).json({ error: "Unknown page" });
    }

    const { enabled, showInNav, navLabel, navOrder, content, seo } = req.body;

    // Editing this page's CONTENT requires its minimum plan. Visibility/order
    // (enabled/showInNav/navLabel/navOrder) stay available on every plan.
    const minPlan = pageMinPlan(key);
    if (content !== undefined && !planAllows(req.organisation?.plan, minPlan)) {
      return res.status(403).json({
        error: `Editing this page's content requires the ${minPlan} plan.`,
        requiredPlan: minPlan,
      });
    }

    const update = {};
    if (enabled !== undefined) update.enabled = !!enabled;
    if (showInNav !== undefined) update.showInNav = !!showInNav;
    if (navLabel !== undefined) update.navLabel = String(navLabel).trim();
    if (navOrder !== undefined) update.navOrder = Number(navOrder) || 0;
    // Content edits land in the DRAFT — the public site keeps showing the
    // published `content` until the admin hits Publish.
    if (content !== undefined && template.editable) update.draftContent = content;
    if (seo !== undefined) {
      update.seo = {
        title: String(seo.title || "").trim(),
        description: String(seo.description || "").trim(),
      };
    }
    // Keep structural fields in sync.
    update.path = template.path;
    update.navParentKey = template.navParentKey || null;

    const page = await Page.findOneAndUpdate(
      { organisationId: orgId, key },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    res.json({
      message: "Page updated successfully",
      page: {
        key,
        path: template.path,
        navLabel: page.navLabel || template.navLabel,
        navParentKey: template.navParentKey || null,
        navOrder: page.navOrder,
        showInNav: page.showInNav,
        enabled: page.enabled,
        editable: !!template.editable,
        sectionBased: !!template.sectionBased,
        content: serveContent(template, editableContent(page)),
        hasUnpublishedChanges: hasDraft(page),
        seo: page.seo || { title: "", description: "" },
      },
    });
  } catch (error) {
    console.error("Update page error:", error);
    res.status(500).json({ error: "Failed to update page" });
  }
};

/**
 * POST /api/admin/pages/:key/publish   (admin, tenant-scoped)
 * Make the draft live: snapshot the current published content into a revision,
 * copy draft → content, then clean up S3 images no longer referenced anywhere.
 */
exports.publishPage = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const { key } = req.params;
    const template = getTemplate(key);
    if (!template) return res.status(404).json({ error: "Unknown page" });

    const minPlan = pageMinPlan(key);
    if (!planAllows(req.organisation?.plan, minPlan)) {
      return res.status(403).json({ error: `Publishing this page requires the ${minPlan} plan.`, requiredPlan: minPlan });
    }

    const page = await Page.findOne({ organisationId: orgId, key });
    if (!page) return res.status(404).json({ error: "Page not found" });
    if (!hasDraft(page)) {
      return res.json({ message: "Nothing to publish", hasUnpublishedChanges: false, publishedAt: page.publishedAt || null });
    }

    const oldContent = page.content || {};
    const newContent = page.draftContent;

    // Snapshot the version being replaced so it can be restored later, then
    // trim to the most recent MAX_REVISIONS — collecting the images that fall
    // out of history so they can be cleaned up below.
    const trimmedUrls = new Set();
    if (oldContent && Object.keys(oldContent).length) {
      await PageRevision.create({ organisationId: orgId, pageKey: key, content: oldContent, note: req.body?.note || "" });
      const extra = await PageRevision.find({ organisationId: orgId, pageKey: key })
        .sort({ createdAt: -1 })
        .skip(MAX_REVISIONS)
        .select("content")
        .lean();
      if (extra.length) {
        extra.forEach((r) => collectBucketUrls(r.content, trimmedUrls));
        await PageRevision.deleteMany({ _id: { $in: extra.map((d) => d._id) } });
      }
    }

    page.content = newContent;
    page.draftContent = null;
    page.publishedAt = new Date();
    page.markModified("content");
    page.markModified("draftContent");
    await page.save();

    // S3 cleanup — an image is orphaned when it's removed from the published
    // content (or fell out of revision history) AND isn't referenced by any
    // page (content/draft) or any retained revision. Rollback stays safe:
    // retained revisions keep their images alive.
    try {
      const newUrls = collectBucketUrls(newContent);
      const candidates = new Set(trimmedUrls);
      collectBucketUrls(oldContent).forEach((u) => { if (!newUrls.has(u)) candidates.add(u); });
      if (candidates.size) {
        const stillUsed = new Set();
        const pages = await Page.find({ organisationId: orgId }).select("content draftContent").lean();
        pages.forEach((p) => { collectBucketUrls(p.content, stillUsed); collectBucketUrls(p.draftContent, stillUsed); });
        const revs = await PageRevision.find({ organisationId: orgId }).select("content").lean();
        revs.forEach((r) => collectBucketUrls(r.content, stillUsed));
        await Promise.all([...candidates].filter((u) => !stillUsed.has(u)).map((u) => deleteByUrl(u).catch(() => {})));
      }
    } catch (e) {
      console.error("Page image cleanup error:", e.message);
    }

    res.json({
      message: "Page published",
      hasUnpublishedChanges: false,
      publishedAt: page.publishedAt,
      content: serveContent(template, page.content),
    });
  } catch (error) {
    console.error("Publish page error:", error);
    res.status(500).json({ error: "Failed to publish page" });
  }
};

/**
 * POST /api/admin/pages/:key/discard   (admin)
 * Drop the unpublished draft and revert the editor to the published content.
 */
exports.discardDraft = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });
    const { key } = req.params;
    const template = getTemplate(key);
    if (!template) return res.status(404).json({ error: "Unknown page" });

    const page = await Page.findOneAndUpdate(
      { organisationId: orgId, key },
      { $set: { draftContent: null } },
      { new: true }
    ).lean();

    res.json({
      message: "Draft discarded",
      hasUnpublishedChanges: false,
      content: serveContent(template, page?.content),
    });
  } catch (error) {
    console.error("Discard draft error:", error);
    res.status(500).json({ error: "Failed to discard draft" });
  }
};

/**
 * GET /api/admin/pages/:key/revisions   (admin)
 * Published-version history (newest first), without the content blobs.
 */
exports.getRevisions = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });
    const { key } = req.params;
    const revisions = await PageRevision.find({ organisationId: orgId, pageKey: key })
      .sort({ createdAt: -1 })
      .select("_id note createdAt")
      .lean();
    res.json({ revisions });
  } catch (error) {
    console.error("Get revisions error:", error);
    res.status(500).json({ error: "Failed to fetch revisions" });
  }
};

/**
 * POST /api/admin/pages/:key/revisions/:revId/restore   (admin)
 * Load a past revision into the DRAFT (review, then Publish to go live).
 */
exports.restoreRevision = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });
    const { key, revId } = req.params;
    const template = getTemplate(key);
    if (!template) return res.status(404).json({ error: "Unknown page" });

    const rev = await PageRevision.findOne({ _id: revId, organisationId: orgId, pageKey: key }).lean();
    if (!rev) return res.status(404).json({ error: "Revision not found" });

    const page = await Page.findOneAndUpdate(
      { organisationId: orgId, key },
      { $set: { draftContent: rev.content || {} } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    res.json({
      message: "Revision restored to draft",
      hasUnpublishedChanges: hasDraft(page),
      content: serveContent(template, editableContent(page)),
    });
  } catch (error) {
    console.error("Restore revision error:", error);
    res.status(500).json({ error: "Failed to restore revision" });
  }
};

/**
 * POST /api/admin/pages/:key/image   (admin, tenant-scoped)
 * Upload an image for a page content field; returns the S3 URL. The actual
 * multer middleware is attached in the route file.
 */
exports.uploadPageImage = async (req, res) => {
  try {
    if (!req.file || !req.file.location) {
      return res.status(400).json({ error: "No image uploaded" });
    }
    res.json({ url: req.file.location });
  } catch (error) {
    console.error("Upload page image error:", error);
    res.status(500).json({ error: "Failed to upload image" });
  }
};

/**
 * GET /api/admin/pages/section-types   (admin)
 * The section (block) type catalog — labels, editor schemas and defaults — that
 * drives the admin section builder for section-based pages.
 */
exports.getSectionTypes = (req, res) => {
  res.json({ sectionTypes: SECTION_TYPES });
};

// Re-export for use by registration / scripts.
exports.seedPagesForOrg = seedPagesForOrg;
