const Page = require("../models/page");
const {
  mergedContent,
  ensurePagesSeeded,
  seedPagesForOrg,
  getTemplate,
} = require("../services/pageService");
const { PAGE_TEMPLATES } = require("../config/pageTemplates");
const { pageMinPlan, planAllows } = require("../config/planTiers");

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
      content: mergedContent(template, page?.content),
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
        minPlan,
        locked: !planAllows(orgPlan, minPlan), // content editing requires this plan
        schema: t.schema || [],
        content: mergedContent(t, doc.content),
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
      minPlan: pageMinPlan(key),
      locked: !planAllows(req.organisation?.plan, pageMinPlan(key)),
      schema: template.schema || [],
      content: mergedContent(template, doc.content),
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
    // Content is only editable for pages that declare a schema.
    if (content !== undefined && template.editable) update.content = content;
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
        content: mergedContent(template, page.content),
        seo: page.seo || { title: "", description: "" },
      },
    });
  } catch (error) {
    console.error("Update page error:", error);
    res.status(500).json({ error: "Failed to update page" });
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

// Re-export for use by registration / scripts.
exports.seedPagesForOrg = seedPagesForOrg;
