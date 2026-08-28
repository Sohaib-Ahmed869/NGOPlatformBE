/**
 * controllers/emailTemplateController.js
 *
 * Serves BOTH consoles from one implementation:
 *   - SuperAdmin  (/api/superadmin/email/*)  edits the PLATFORM layer, sees every
 *     template in the catalog, and reads the platform-wide send log.
 *   - Tenant admin (/api/admin/email-templates/*) edits its OWN layer, sees only
 *     tenant-scope templates, and reads only its own send log.
 *
 * The only difference between them is which organisationId the write lands on
 * and what the caller is allowed to see, so `scopeOf(req)` decides that once and
 * everything below is shared. Routes pick the layer by mounting with
 * `asPlatform` or `asTenant`; a tenant request can never reach the platform row.
 */
const mongoose = require("mongoose");
const catalog = require("../config/emailCatalog");
const EmailTemplate = require("../models/emailTemplate");
const EmailLayout = require("../models/emailLayout");
const EmailLog = require("../models/emailLog");
const emailTemplates = require("../services/emailTemplates");
const { BLOCK_TYPES, DEFAULT_THEME, DEFAULT_LAYOUT } = require("../services/emailBlocks");
const { collectTokens } = require("../services/emailRender");
const writeAudit = require("../utils/writeAudit");

/* -- scope ---------------------------------------------------------------- */

/**
 * Which layer this request edits.
 * `req.emailScope` is set by the route mount, NOT by anything the client sends --
 * a tenant cannot ask to edit the platform default by passing a flag.
 */
function scopeOf(req) {
  if (req.emailScope === "platform") {
    return { layer: "platform", organisationId: null };
  }
  const orgId = req.organisation?._id || req.user?.organisationId;
  return { layer: "tenant", organisationId: orgId ? String(orgId) : null };
}

/** Templates this caller may see. Tenants never see platform-scope mail. */
function visibleTemplates(layer) {
  return layer === "platform" ? catalog.TEMPLATES : catalog.TEMPLATES.filter((t) => t.scope === "tenant");
}

function guardTenantAccess(req, res, entry) {
  const { layer } = scopeOf(req);
  if (layer === "tenant" && entry.scope !== "tenant") {
    res.status(403).json({ error: "This email is managed by the platform team" });
    return false;
  }
  return true;
}

const actor = (req) => ({
  userId: req.user?._id,
  name: req.user?.name || req.user?.fullName || "",
  email: req.user?.email || "",
});

/* -- validation ----------------------------------------------------------- */

const MAX_HTML = 200_000; // Gmail clips around 102KB; this is a hard sanity bound.
const MAX_BLOCKS = 100;

/**
 * Sanitise a submitted template body. Anything unrecognised is dropped rather
 * than stored: the renderer skips unknown block types anyway, and keeping them
 * would let a typo sit invisibly in the document forever.
 */
function cleanBlocks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((b) => b && typeof b === "object" && BLOCK_TYPES.includes(b.type))
    .slice(0, MAX_BLOCKS)
    .map((b, i) => {
      const out = { ...b, id: String(b.id || `b${i + 1}`).slice(0, 40), type: b.type };
      delete out._id;
      if (Array.isArray(out.rows)) {
        out.rows = out.rows.slice(0, 30).map((r) => ({
          label: String(r?.label || "").slice(0, 200),
          value: String(r?.value || "").slice(0, 2000),
          ...(r?.showIf ? { showIf: String(r.showIf).slice(0, 200) } : {}),
        }));
      }
      if (Array.isArray(out.columns)) {
        out.columns = out.columns.slice(0, 8).map((c) => ({
          label: String(c?.label || "").slice(0, 120),
          value: String(c?.value || "").slice(0, 500),
          align: ["left", "center", "right"].includes(c?.align) ? c.align : "left",
        }));
      }
      if (Array.isArray(out.items)) {
        out.items = out.items.slice(0, 40).map((i) => String(typeof i === "string" ? i : i?.text || "").slice(0, 1000));
      }
      return out;
    });
}

/**
 * A preview/test payload. Carries CONTENT (the template editor), a LAYOUT (the
 * layout editor previewing its wrapper around a real email), or both -- so the
 * layout is passed through rather than dropped, and its theme is whitelisted
 * against the known token names.
 */
function cleanDraft(raw) {
  if (!raw || typeof raw !== "object") return null;
  const draft = { ...raw, blocks: cleanBlocks(raw.blocks) };
  if (raw.layout && typeof raw.layout === "object") {
    const layout = { ...raw.layout };
    const theme = {};
    for (const [k, val] of Object.entries(raw.layout.theme || {})) {
      if (k in DEFAULT_THEME) theme[k] = val;
    }
    layout.theme = theme;
    draft.layout = layout;
  }
  return draft;
}

/**
 * Warn (never block) about {{tokens}} the call site will not supply. Operators
 * legitimately invent variables while drafting, and a hard rejection mid-edit is
 * worse than a visible warning next to the field.
 */
function unknownTokens(key, draft) {
  const known = new Set(catalog.variablesFor(key).map((v) => v.key));
  // Loop bodies reference `this.*`, and `currency` is injected for every send.
  known.add("currency");
  const strings = [draft.subject || "", draft.preheader || "", draft.html || ""];
  for (const b of draft.blocks || []) {
    for (const val of Object.values(b)) {
      if (typeof val === "string") strings.push(val);
      else if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === "string") strings.push(item);
          else if (item && typeof item === "object") strings.push(...Object.values(item).filter((x) => typeof x === "string"));
        }
      }
    }
  }
  const used = new Set();
  for (const s of strings) for (const t of collectTokens(s)) used.add(t);

  return [...used].filter((t) => {
    if (known.has(t)) return false;
    // `items` inside {{#each items}} names an array declared as e.g.
    // `donation.items`; anything scoped under a known array is fine.
    if (t.startsWith("this.")) return false;
    return ![...known].some((k) => t.startsWith(`${k}.`) || k.startsWith(`${t}.`));
  });
}

/* -- templates: read ------------------------------------------------------ */

/**
 * 30-day send volume per template, cached briefly.
 *
 * This is the single most expensive thing the console does: a scan of every log
 * row written in the last 30 days, grouped by template. For the platform layer
 * that is the whole collection across every tenant -- and it was re-run on every
 * load of the screen, every Refresh, and every remount.
 *
 * The numbers it produces are 30-day counters shown as "1,204 sent". Nobody can
 * tell whether that figure is a minute old, so it is allowed to be. The window
 * matches the send-path template cache in services/emailTemplates.js.
 */
const VOLUME_TTL_MS = 60 * 1000;
const VOLUME_CACHE_MAX = 500; // one entry per active tenant, bounded
const volumeCache = new Map();

async function templateVolume(organisationId) {
  const key = organisationId ? String(organisationId) : "platform";
  const hit = volumeCache.get(key);
  if (hit && Date.now() - hit.at < VOLUME_TTL_MS) return hit.value;

  const since = new Date(Date.now() - 30 * 86400 * 1000);
  const match = { createdAt: { $gte: since } };
  if (organisationId) match.organisationId = new mongoose.Types.ObjectId(organisationId);

  const stats = await EmailLog.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$templateKey",
        sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
      },
    },
  ]);

  const byKey = new Map(stats.map((s) => [s._id, s]));
  // Insertion-ordered, so the first key is the oldest write.
  volumeCache.delete(key);
  volumeCache.set(key, { at: Date.now(), value: byKey });
  if (volumeCache.size > VOLUME_CACHE_MAX) {
    volumeCache.delete(volumeCache.keys().next().value);
  }
  return byKey;
}

/**
 * GET /email/templates
 * The catalog plus, for each entry, how it currently resolves for this layer.
 * One query for all overrides -- 41 templates would otherwise be 41 round trips.
 */
exports.listTemplates = async (req, res) => {
  try {
    const { layer, organisationId } = scopeOf(req);
    const entries = visibleTemplates(layer);

    const ids = organisationId ? [null, new mongoose.Types.ObjectId(organisationId)] : [null];
    // Independent reads: the override rows come from one collection and the
    // volume counters from another, so they have no reason to queue behind
    // each other.
    const [rows, statsByKey] = await Promise.all([
      EmailTemplate.find({ organisationId: { $in: ids } })
        .select("key organisationId enabled updatedAt updatedBy subject")
        .lean(),
      templateVolume(organisationId),
    ]);

    const platformRows = new Map(rows.filter((r) => !r.organisationId).map((r) => [r.key, r]));
    const tenantRows = new Map(rows.filter((r) => r.organisationId).map((r) => [r.key, r]));

    const templates = entries.map((t) => {
      const platformRow = platformRows.get(t.key);
      const tenantRow = tenantRows.get(t.key);
      const own = layer === "platform" ? platformRow : tenantRow;
      const stat = statsByKey.get(t.key) || { sent: 0, failed: 0 };
      return {
        key: t.key,
        label: t.label,
        group: t.group,
        scope: t.scope,
        audience: t.audience,
        description: t.description,
        required: !!t.required,
        hasAttachment: t.hasAttachment || "",
        variableCount: catalog.variablesFor(t.key).length,
        // "customised" = this layer has its own row. A tenant also sees whether
        // the platform default beneath it has been changed.
        customised: !!own,
        platformCustomised: !!platformRow,
        enabled: t.required ? true : (platformRow?.enabled !== false) && (tenantRow?.enabled !== false),
        updatedAt: own?.updatedAt || null,
        updatedBy: own?.updatedBy || null,
        sent30d: stat.sent,
        failed30d: stat.failed,
      };
    });

    res.json({
      layer,
      groups: catalog.GROUPS,
      templates,
      blockTypes: BLOCK_TYPES,
    });
  } catch (error) {
    console.error("listTemplates error:", error);
    res.status(500).json({ error: "Failed to load email templates" });
  }
};

/**
 * GET /email/templates/:key
 * Everything the editor needs in one payload: the catalog entry, the variable
 * palette, the shipped default, the row this layer owns (if any), and what the
 * layer beneath currently resolves to (so "Reset" can be previewed honestly).
 */
exports.getTemplate = async (req, res) => {
  try {
    const entry = catalog.get(req.params.key);
    if (!entry) return res.status(404).json({ error: "Unknown email template" });
    if (!guardTenantAccess(req, res, entry)) return;

    const { layer, organisationId } = scopeOf(req);
    const own = await EmailTemplate.findOne({
      key: entry.key,
      organisationId: layer === "platform" ? null : organisationId,
    }).lean();

    // What sending would use right now if this layer's row didn't exist.
    const inherited =
      layer === "tenant"
        ? await (async () => {
            const platformRow = await EmailTemplate.findOne({ key: entry.key, organisationId: null }).lean();
            return platformRow
              ? { subject: platformRow.subject, mode: platformRow.mode, blocks: platformRow.blocks, html: platformRow.html, preheader: platformRow.preheader, source: "platform" }
              : { ...catalog.defaultsFor(entry.key), source: "catalog" };
          })()
        : { ...catalog.defaultsFor(entry.key), source: "catalog" };

    res.json({
      layer,
      template: {
        key: entry.key,
        label: entry.label,
        group: entry.group,
        scope: entry.scope,
        audience: entry.audience,
        description: entry.description,
        required: !!entry.required,
        hasAttachment: entry.hasAttachment || "",
      },
      variables: catalog.variablesFor(entry.key),
      sample: catalog.sampleContext(entry.key),
      defaults: catalog.defaultsFor(entry.key),
      inherited,
      // null when this layer has never customised it -- the editor then opens
      // pre-filled with `inherited` and the header reads "using the default".
      current: own
        ? {
            subject: own.subject,
            preheader: own.preheader,
            mode: own.mode,
            blocks: own.blocks,
            html: own.html,
            enabled: own.enabled,
            updatedAt: own.updatedAt,
            updatedBy: own.updatedBy,
          }
        : null,
      blockTypes: BLOCK_TYPES,
    });
  } catch (error) {
    console.error("getTemplate error:", error);
    res.status(500).json({ error: "Failed to load email template" });
  }
};

/* -- templates: write ----------------------------------------------------- */

/** PUT /email/templates/:key */
exports.saveTemplate = async (req, res) => {
  try {
    const entry = catalog.get(req.params.key);
    if (!entry) return res.status(404).json({ error: "Unknown email template" });
    if (!guardTenantAccess(req, res, entry)) return;

    const { layer, organisationId } = scopeOf(req);
    if (layer === "tenant" && !organisationId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    const mode = req.body.mode === "html" ? "html" : "blocks";
    const html = String(req.body.html || "").slice(0, MAX_HTML);
    const blocks = cleanBlocks(req.body.blocks);

    if (mode === "blocks" && !blocks.length) {
      return res.status(400).json({ error: "Add at least one block before saving" });
    }
    if (mode === "html" && !html.trim()) {
      return res.status(400).json({ error: "The HTML body can't be empty" });
    }
    const subject = String(req.body.subject || "").trim().slice(0, 300);
    if (!subject) return res.status(400).json({ error: "A subject is required" });

    const doc = {
      subject,
      preheader: String(req.body.preheader || "").trim().slice(0, 300),
      mode,
      blocks,
      html,
      updatedBy: actor(req),
    };
    // `enabled` is only ever changed through the toggle endpoint, so a save
    // can't silently re-enable an email an operator deliberately switched off.
    if (entry.required) doc.enabled = true;

    const saved = await EmailTemplate.findOneAndUpdate(
      { key: entry.key, organisationId: layer === "platform" ? null : organisationId },
      { $set: doc, $setOnInsert: { key: entry.key, organisationId: layer === "platform" ? null : organisationId } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();

    emailTemplates.invalidate({ key: entry.key });
    if (layer === "platform") {
      await writeAudit(req, "email.template.updated", {
        targetType: "emailTemplate",
        targetId: entry.key,
        meta: { mode, blocks: blocks.length },
      });
    }

    res.json({ message: "Template saved", template: saved, warnings: unknownTokens(entry.key, { ...doc }) });
  } catch (error) {
    console.error("saveTemplate error:", error);
    res.status(500).json({ error: "Failed to save email template" });
  }
};

/**
 * POST /email/templates/:key/reset
 * Implemented as a DELETE of this layer's row, so the template falls through to
 * the layer beneath. That is why a reset can never leave a broken template.
 */
exports.resetTemplate = async (req, res) => {
  try {
    const entry = catalog.get(req.params.key);
    if (!entry) return res.status(404).json({ error: "Unknown email template" });
    if (!guardTenantAccess(req, res, entry)) return;

    const { layer, organisationId } = scopeOf(req);
    await EmailTemplate.deleteOne({
      key: entry.key,
      organisationId: layer === "platform" ? null : organisationId,
    });

    emailTemplates.invalidate({ key: entry.key });
    if (layer === "platform") {
      await writeAudit(req, "email.template.reset", { targetType: "emailTemplate", targetId: entry.key });
    }
    res.json({ message: "Reverted to the default", defaults: catalog.defaultsFor(entry.key) });
  } catch (error) {
    console.error("resetTemplate error:", error);
    res.status(500).json({ error: "Failed to reset email template" });
  }
};

/** PATCH /email/templates/:key/toggle  { enabled } */
exports.toggleTemplate = async (req, res) => {
  try {
    const entry = catalog.get(req.params.key);
    if (!entry) return res.status(404).json({ error: "Unknown email template" });
    if (!guardTenantAccess(req, res, entry)) return;

    // Receipts, password resets and activation mail carry a legal or security
    // obligation -- the switch is refused rather than hidden, so the reason is
    // visible to whoever tries.
    if (entry.required) {
      return res.status(400).json({
        error: `"${entry.label}" can't be switched off — it's required for legal or security reasons.`,
      });
    }

    const { layer, organisationId } = scopeOf(req);
    const enabled = !!req.body.enabled;
    await EmailTemplate.findOneAndUpdate(
      { key: entry.key, organisationId: layer === "platform" ? null : organisationId },
      { $set: { enabled, updatedBy: actor(req) }, $setOnInsert: { key: entry.key } },
      { upsert: true, setDefaultsOnInsert: true },
    );

    emailTemplates.invalidate({ key: entry.key });
    if (layer === "platform") {
      await writeAudit(req, enabled ? "email.template.enabled" : "email.template.disabled", {
        targetType: "emailTemplate",
        targetId: entry.key,
      });
    }
    res.json({ message: enabled ? "Email switched on" : "Email switched off", enabled });
  } catch (error) {
    console.error("toggleTemplate error:", error);
    res.status(500).json({ error: "Failed to update email template" });
  }
};

/* -- preview + test ------------------------------------------------------- */

/**
 * POST /email/templates/:key/preview
 * Renders an UNSAVED draft against sample data. This is what makes the split
 * pane live -- the editor never has to save to see the result.
 */
exports.previewTemplate = async (req, res) => {
  try {
    const entry = catalog.get(req.params.key);
    if (!entry) return res.status(404).json({ error: "Unknown email template" });
    if (!guardTenantAccess(req, res, entry)) return;

    const { organisationId } = scopeOf(req);
    const draft = cleanDraft(req.body.draft);

    const out = await emailTemplates.previewTemplate(entry.key, {
      draft,
      organisationId: entry.scope === "platform" ? null : organisationId,
    });

    res.json({
      subject: out.subject,
      html: out.html,
      text: out.text,
      warnings: draft ? unknownTokens(entry.key, draft) : [],
    });
  } catch (error) {
    console.error("previewTemplate error:", error);
    res.status(500).json({ error: "Failed to render preview" });
  }
};

/**
 * POST /email/templates/:key/test  { to?, draft? }
 * Sends the draft to the signed-in user (or a nominated address) using the real
 * transport, so deliverability and rendering are both exercised.
 */
exports.sendTest = async (req, res) => {
  try {
    const entry = catalog.get(req.params.key);
    if (!entry) return res.status(404).json({ error: "Unknown email template" });
    if (!guardTenantAccess(req, res, entry)) return;

    const to = String(req.body.to || req.user?.email || "").trim();
    if (!to || !/\S+@\S+\.\S+/.test(to)) {
      return res.status(400).json({ error: "A valid recipient address is required" });
    }

    const { organisationId } = scopeOf(req);
    const draft = cleanDraft(req.body.draft);

    const rendered = await emailTemplates.previewTemplate(entry.key, {
      draft,
      organisationId: entry.scope === "platform" ? null : organisationId,
    });

    // Deliberately bypasses sendTemplateEmail: a test must render the DRAFT and
    // must ignore the enabled switch (you test an email before turning it on).
    const { sendEmail } = require("../services/emailUtil");
    const org = entry.scope === "platform" ? null : req.organisation || null;
    const result = await sendEmail(to, rendered.html, `[TEST] ${rendered.subject}`, [], {
      org,
      organisationId: entry.scope === "platform" ? undefined : organisationId,
      text: rendered.text,
      preRendered: true,
      log: { templateKey: entry.key, source: rendered.source, meta: { test: true } },
    });

    if (!result.success) {
      return res.status(502).json({
        error: "The email couldn't be sent — check the SMTP settings.",
        detail: result.error?.message || "",
      });
    }
    res.json({ message: `Test email sent to ${to}` });
  } catch (error) {
    console.error("sendTest error:", error);
    res.status(500).json({ error: "Failed to send the test email" });
  }
};

/* -- layout --------------------------------------------------------------- */

/** GET /email/layout */
exports.getLayout = async (req, res) => {
  try {
    const { layer, organisationId } = scopeOf(req);
    const own = await EmailLayout.findOne({
      organisationId: layer === "platform" ? null : organisationId,
    }).lean();

    res.json({
      layer,
      // What sending actually uses right now, all layers merged.
      resolved: await emailTemplates.resolveLayout(layer === "platform" ? null : organisationId),
      current: own || null,
      // The layer beneath this one -- what "revert" would fall back to.
      inherited: await inheritedLayout(layer, organisationId),
      defaults: DEFAULT_LAYOUT,
      themeDefaults: DEFAULT_THEME,
    });
  } catch (error) {
    console.error("getLayout error:", error);
    res.status(500).json({ error: "Failed to load the email layout" });
  }
};

const LAYOUT_FIELDS = [
  "showHeader",
  "showLogo",
  "headerStyle",
  "logoUrl",
  "logoUrlOnDark",
  "logoHeight",
  "headerAlign",
  "headerTagline",
  "showBrandName",
  "headerPattern",
  "footerText",
  "footerAlign",
  "footerStyle",
  "footerPattern",
  "legalText",
  "showPlatformCredit",
  "platformCreditText",
  "preheader",
  "documentTitle",
];

/**
 * What the layout would resolve to for this layer if its own row didn't exist —
 * i.e. what a field is being compared against to decide "is this an override?".
 * For the platform layer that's the shipped default; for a tenant it's the
 * platform layer (which already includes the shipped default beneath it).
 */
async function inheritedLayout(layer, organisationId) {
  if (layer === "platform") return { ...DEFAULT_LAYOUT, theme: { ...DEFAULT_LAYOUT.theme } };
  return emailTemplates.resolveLayout(null);
}

/** PUT /email/layout */
exports.saveLayout = async (req, res) => {
  try {
    const { layer, organisationId } = scopeOf(req);
    if (layer === "tenant" && !organisationId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    // The editor submits the whole resolved form, not a diff — so a field that
    // still matches the layer beneath is UNSET rather than stored. Without this
    // a tenant who changed one colour would freeze a copy of the platform's
    // entire layout and stop inheriting later changes to it.
    const inherited = await inheritedLayout(layer, organisationId);

    const set = { updatedBy: actor(req) };
    const unset = {};
    const put = (path, value, base) => {
      if (value === undefined) return;
      if (value === "" || value === null || JSON.stringify(value) === JSON.stringify(base)) {
        unset[path] = "";
      } else {
        set[path] = value;
      }
    };

    for (const field of LAYOUT_FIELDS) put(field, req.body[field], inherited[field]);

    if (Array.isArray(req.body.footerLinks)) {
      const links = req.body.footerLinks
        .slice(0, 6)
        .map((l) => ({ label: String(l?.label || "").slice(0, 60), url: String(l?.url || "").slice(0, 500) }))
        .filter((l) => l.label && l.url);
      put("footerLinks", links, inherited.footerLinks || []);
    }

    if (req.body.theme && typeof req.body.theme === "object") {
      for (const [k, val] of Object.entries(req.body.theme)) {
        if (k in DEFAULT_THEME) put(`theme.${k}`, val, (inherited.theme || {})[k]);
      }
    }

    const update = { $set: set, $setOnInsert: { organisationId: layer === "platform" ? null : organisationId } };
    if (Object.keys(unset).length) update.$unset = unset;

    await EmailLayout.findOneAndUpdate(
      { organisationId: layer === "platform" ? null : organisationId },
      update,
      { upsert: true, setDefaultsOnInsert: true },
    );

    // The layout wraps EVERY email, so its cache has to go platform-wide.
    emailTemplates.invalidate({});
    if (layer === "platform") await writeAudit(req, "email.layout.updated", { targetType: "emailLayout" });

    res.json({
      message: "Layout saved",
      resolved: await emailTemplates.resolveLayout(layer === "platform" ? null : organisationId),
    });
  } catch (error) {
    console.error("saveLayout error:", error);
    res.status(500).json({ error: "Failed to save the email layout" });
  }
};

/** POST /email/layout/reset */
exports.resetLayout = async (req, res) => {
  try {
    const { layer, organisationId } = scopeOf(req);
    await EmailLayout.deleteOne({ organisationId: layer === "platform" ? null : organisationId });
    emailTemplates.invalidate({});
    if (layer === "platform") await writeAudit(req, "email.layout.reset", { targetType: "emailLayout" });
    res.json({
      message: "Layout reverted to the default",
      resolved: await emailTemplates.resolveLayout(layer === "platform" ? null : organisationId),
    });
  } catch (error) {
    console.error("resetLayout error:", error);
    res.status(500).json({ error: "Failed to reset the email layout" });
  }
};

/* -- send log ------------------------------------------------------------- */

/** GET /email/logs?status=&templateKey=&organisationId=&search=&page=&limit= */
exports.listLogs = async (req, res) => {
  try {
    const { layer, organisationId } = scopeOf(req);
    const filter = {};

    // A tenant sees only its own mail. A platform operator may filter by tenant.
    if (layer === "tenant") {
      if (!organisationId) return res.status(400).json({ error: "Organisation context required" });
      filter.organisationId = new mongoose.Types.ObjectId(organisationId);
    } else if (req.query.organisationId && mongoose.isValidObjectId(req.query.organisationId)) {
      filter.organisationId = new mongoose.Types.ObjectId(req.query.organisationId);
    }

    if (["sent", "failed", "skipped"].includes(req.query.status)) filter.status = req.query.status;
    if (req.query.templateKey && catalog.has(req.query.templateKey)) filter.templateKey = req.query.templateKey;

    const search = String(req.query.search || "").trim();
    if (search) {
      // Escaped: an operator pasting an address with a "+" would otherwise be a
      // regex quantifier and throw.
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [{ to: new RegExp(safe, "i") }, { subject: new RegExp(safe, "i") }];
    }
    if (req.query.since) {
      const since = new Date(req.query.since);
      if (!isNaN(since.getTime())) filter.createdAt = { $gte: since };
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

    const [rows, total] = await Promise.all([
      EmailLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("organisationId", "name slug")
        .lean(),
      EmailLog.countDocuments(filter),
    ]);

    const labels = new Map(catalog.TEMPLATES.map((t) => [t.key, t.label]));
    res.json({
      logs: rows.map((r) => ({ ...r, templateLabel: labels.get(r.templateKey) || "" })),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    console.error("listLogs error:", error);
    res.status(500).json({ error: "Failed to load the email log" });
  }
};

/**
 * GET /email/logs/stats?days=30
 * Headline counters plus a per-day series and the worst-performing templates.
 */
exports.logStats = async (req, res) => {
  try {
    const { layer, organisationId } = scopeOf(req);
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
    const since = new Date(Date.now() - days * 86400 * 1000);

    const match = { createdAt: { $gte: since } };
    if (layer === "tenant") {
      if (!organisationId) return res.status(400).json({ error: "Organisation context required" });
      match.organisationId = new mongoose.Types.ObjectId(organisationId);
    }

    const [totals, series, worst] = await Promise.all([
      EmailLog.aggregate([{ $match: match }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
      EmailLog.aggregate([
        { $match: match },
        {
          $group: {
            _id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, status: "$status" },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.day": 1 } },
      ]),
      EmailLog.aggregate([
        { $match: { ...match, status: "failed" } },
        { $group: { _id: "$templateKey", failed: { $sum: 1 }, lastError: { $last: "$error" } } },
        { $sort: { failed: -1 } },
        { $limit: 5 },
      ]),
    ]);

    const byStatus = { sent: 0, failed: 0, skipped: 0 };
    for (const t of totals) byStatus[t._id] = t.count;

    // Collapse the (day, status) pairs into one row per day for the chart.
    const daily = new Map();
    for (const s of series) {
      const row = daily.get(s._id.day) || { day: s._id.day, sent: 0, failed: 0, skipped: 0 };
      row[s._id.status] = s.count;
      daily.set(s._id.day, row);
    }

    const attempted = byStatus.sent + byStatus.failed;
    const labels = new Map(catalog.TEMPLATES.map((t) => [t.key, t.label]));

    res.json({
      days,
      ...byStatus,
      total: byStatus.sent + byStatus.failed + byStatus.skipped,
      // Of the sends we actually attempted -- skips aren't delivery failures.
      successRate: attempted ? Math.round((byStatus.sent / attempted) * 1000) / 10 : 100,
      daily: [...daily.values()],
      worstTemplates: worst.map((w) => ({
        key: w._id,
        label: labels.get(w._id) || w._id || "Ad-hoc",
        failed: w.failed,
        lastError: w.lastError || "",
      })),
    });
  } catch (error) {
    console.error("logStats error:", error);
    res.status(500).json({ error: "Failed to load email statistics" });
  }
};
