/**
 * services/emailTemplates.js
 *
 * The send path for every transactional email: resolve which template wins,
 * build the data context, render it inside the shared layout, hand it to the
 * tenant-aware transport, and log the outcome.
 *
 * Resolution is three-layered and always terminates:
 *
 *   1. the tenant's own row      (EmailTemplate with this organisationId)
 *   2. the platform default row  (EmailTemplate with organisationId: null)
 *   3. config/emailCatalog.js    (shipped in the repo -- can't be deleted)
 *
 * Layer 3 is why nothing here can ever fail for want of content, and why
 * "Reset to default" is implemented as a DELETE.
 *
 * The public entry point is sendTemplateEmail(). Call sites pass a `data`
 * object matching the variables the catalog declares for that key; everything
 * else (org identity, platform identity, layout, transport) is resolved here.
 */
const mongoose = require("mongoose");
const catalog = require("../config/emailCatalog");
const EmailTemplate = require("../models/emailTemplate");
const EmailLayout = require("../models/emailLayout");
const { renderString } = require("./emailRender");
const { blocksToHtml, wrapInLayout, htmlToText, DEFAULT_LAYOUT } = require("./emailBlocks");
const { getOrgIdentity } = require("../utils/orgIdentity");

/* -- caches ---------------------------------------------------------------- */

// Templates change at operator speed but are read on every send, so they are
// cached with a short TTL AND invalidated explicitly on save. The TTL is the
// safety net for multi-instance deploys where the save happened on another box.
const TTL_MS = 60 * 1000;
const templateCache = new Map(); // `${key}:${orgId}` -> { at, value }
const layoutCache = new Map(); // orgId -> { at, value }
let platformIdentityCache = null;

const cacheKey = (key, orgId) => `${key}:${orgId || "platform"}`;

/**
 * Mongoose BUFFERS queries when it isn't connected and only rejects them after
 * bufferTimeoutMS (10s by default). On a send path that would turn a database
 * blip into a ten-second stall per email rather than an instant fall-through to
 * the shipped defaults -- which are perfectly good content. Scripts and tests
 * that render without connecting get the same fast path.
 */
const dbReady = () => mongoose.connection.readyState === 1;

function readCache(map, k) {
  const hit = map.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  return undefined;
}
const writeCache = (map, k, value) => map.set(k, { at: Date.now(), value });

/**
 * Drop cached copies after an edit. Called by the controllers on every write --
 * without it an operator would save a template and keep seeing the old one for
 * up to a minute, which reads as "saving is broken".
 */
function invalidate({ key, organisationId } = {}) {
  if (!key && organisationId === undefined) {
    templateCache.clear();
    layoutCache.clear();
    platformIdentityCache = null;
    return;
  }
  if (key) {
    // A change to the PLATFORM default also changes what every tenant without
    // an override resolves to, so drop that key everywhere rather than guessing.
    for (const k of templateCache.keys()) if (k.startsWith(`${key}:`)) templateCache.delete(k);
  }
  if (organisationId !== undefined) layoutCache.delete(String(organisationId || "platform"));
  if (organisationId === null || organisationId === undefined) layoutCache.clear();
}

/* -- identity -------------------------------------------------------------- */

/** The platform's own name/links, used by platform-scope mail and the footer. */
async function platformIdentity() {
  if (platformIdentityCache && Date.now() - platformIdentityCache.at < TTL_MS) {
    return platformIdentityCache.value;
  }
  let value = {
    name: process.env.EMAIL_FROM_NAME || "NGO Platform",
    url: process.env.CLIENT_URL || "",
    supportEmail: process.env.ADMIN_EMAIL || "",
  };
  try {
    if (!dbReady()) throw new Error("database not connected");
    const PlatformSettings = require("../models/platformSettings");
    const s = await PlatformSettings.findOne({ key: "platform" })
      .select(
        "name tagline contactEmail contactPhone branding.logo branding.logoDark " +
          "branding.primaryColor branding.accentColor branding.backgroundColor",
      )
      .lean();
    if (s) {
      const b = s.branding || {};
      value = {
        name: s.name || value.name,
        tagline: s.tagline || "",
        url: value.url,
        supportEmail: s.contactEmail || value.supportEmail,
        phone: s.contactPhone || "",
        // Same two-variant rule as a tenant: dark-on-light for the body, the
        // light mark for the branded header band.
        logo: b.logoDark || b.logo || "",
        logoLight: b.logo || b.logoDark || "",
        primaryColor: b.primaryColor || "",
        accentColor: b.accentColor || "",
        backgroundColor: b.backgroundColor || "",
      };
    }
  } catch (err) {
    // A settings read must never stop an email -- fall back to env.
    console.error("[emailTemplates] platform identity unavailable:", err.message);
  }
  platformIdentityCache = { at: Date.now(), value };
  return value;
}

const asId = (v) => {
  if (!v) return null;
  if (typeof v === "object" && v._id) return String(v._id);
  return String(v);
};

/* -- resolution ------------------------------------------------------------ */

/**
 * Which template content actually gets sent for `key`, for this tenant.
 * Returns `{ subject, preheader, mode, blocks, html, enabled, source }` where
 * `source` says which layer won -- shown in the console and written to the log.
 */
async function resolveTemplate(key, organisationId) {
  const entry = catalog.get(key);
  if (!entry) return null;

  const orgId = entry.scope === "platform" ? null : asId(organisationId);
  const ck = cacheKey(key, orgId);
  const cached = readCache(templateCache, ck);
  if (cached !== undefined) return cached;

  const fallback = { ...catalog.defaultsFor(key), enabled: true, source: "catalog" };
  let resolved = fallback;
  if (!dbReady()) return fallback;

  try {
    // Both layers in one query -- two round trips per email adds up in a burst.
    const ids = orgId ? [null, new mongoose.Types.ObjectId(orgId)] : [null];
    const rows = await EmailTemplate.find({ key, organisationId: { $in: ids } }).lean();
    const platformRow = rows.find((r) => !r.organisationId);
    const tenantRow = orgId ? rows.find((r) => String(r.organisationId) === orgId) : null;

    const base = platformRow ? merge(fallback, platformRow, "platform") : fallback;
    resolved = tenantRow ? merge(base, tenantRow, "tenant") : base;

    // `enabled` is a switch, not content: a tenant may turn an email off that
    // the platform leaves on, and turning it off at platform level turns it off
    // everywhere. So the layers AND together rather than the tenant overriding.
    const platformEnabled = platformRow ? platformRow.enabled !== false : true;
    const tenantEnabled = tenantRow ? tenantRow.enabled !== false : true;
    resolved.enabled = entry.required ? true : platformEnabled && tenantEnabled;
  } catch (err) {
    console.error(`[emailTemplates] resolve "${key}" failed, using catalog default:`, err.message);
    resolved = fallback;
  }

  writeCache(templateCache, ck, resolved);
  return resolved;
}

/**
 * Layer a stored row over the layer beneath it. A blank subject or an empty
 * block list means "not customised at this layer" rather than "send nothing" --
 * an operator who clears the subject box should fall through to the default,
 * not send a subject-less email.
 */
function merge(base, row, source) {
  const mode = row.mode === "html" || row.mode === "blocks" ? row.mode : base.mode;
  const hasBlocks = Array.isArray(row.blocks) && row.blocks.length > 0;
  const hasHtml = typeof row.html === "string" && row.html.trim().length > 0;
  const contributes = (mode === "html" && hasHtml) || (mode === "blocks" && hasBlocks);
  return {
    subject: String(row.subject || "").trim() || base.subject,
    preheader: String(row.preheader || "").trim() || base.preheader,
    mode: contributes ? mode : base.mode,
    blocks: hasBlocks ? row.blocks : base.blocks,
    html: hasHtml ? row.html : base.html,
    enabled: true, // computed by the caller across both layers
    source: contributes ? source : base.source,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/** The layout wrapper for this tenant: tenant row -> platform row -> schema defaults. */
async function resolveLayout(organisationId) {
  const orgId = asId(organisationId);
  const ck = String(orgId || "platform");
  const cached = readCache(layoutCache, ck);
  if (cached !== undefined) return cached;

  // With no rows at all, the shipped layout IS the answer -- and it is the
  // base both stored layers merge over.
  let layout = { ...DEFAULT_LAYOUT, theme: { ...DEFAULT_LAYOUT.theme } };
  if (!dbReady()) return layout;
  try {
    const ids = orgId ? [null, new mongoose.Types.ObjectId(orgId)] : [null];
    const rows = await EmailLayout.find({ organisationId: { $in: ids } }).lean();
    const platformRow = rows.find((r) => !r.organisationId);
    const tenantRow = orgId ? rows.find((r) => String(r.organisationId) === orgId) : null;
    if (platformRow) layout = mergeLayout(layout, platformRow);
    if (tenantRow) layout = mergeLayout(layout, tenantRow);
  } catch (err) {
    console.error("[emailTemplates] resolve layout failed, using defaults:", err.message);
  }

  writeCache(layoutCache, ck, layout);
  return layout;
}

// Blank strings and null numbers mean "inherit", so they must not clobber the
// layer below -- a tenant who only sets an accent colour keeps everything else.
function mergeLayout(base, row) {
  const out = { ...base };
  for (const [k, val] of Object.entries(row)) {
    if (k === "_id" || k === "theme" || k === "organisationId" || k === "__v") continue;
    if (val === undefined || val === null || val === "") continue;
    out[k] = val;
  }
  out.theme = { ...(base.theme || {}) };
  for (const [k, val] of Object.entries(row.theme || {})) {
    if (val === undefined || val === null || val === "") continue;
    out.theme[k] = val;
  }
  return out;
}

/* -- context --------------------------------------------------------------- */

/**
 * The data every template is rendered against: the call site's own `data`, plus
 * the org and platform identity blocks the layout and the shared copy rely on.
 *
 * Call-site data wins on collision -- a template that passes its own `org` (a
 * cross-tenant staff alert, say) means it.
 */
async function buildContext(entry, org, data = {}) {
  const platform = await platformIdentity();
  const ctx = { ...data };

  if (!ctx.platform) {
    ctx.platform = {
      name: platform.name,
      url: platform.url,
      supportEmail: platform.supportEmail,
      logo: platform.logo || "",
      logoLight: platform.logoLight || "",
    };
  }

  if (!ctx.org) {
    // Platform-scope mail still gets an `org` block so the shared layout can
    // render a header -- it just holds the PLATFORM's identity, branding and
    // links. That is what makes an operator invite or a billing notice look
    // like the SaaS product rather than like a charity's donor receipt.
    if (entry.scope === "platform" && !org) {
      const base = String(platform.url || "").replace(/\/+$/, "");
      const at = (path) => (base ? `${base}${path}` : "");
      ctx.org = {
        name: platform.name,
        email: platform.supportEmail,
        phone: platform.phone || "",
        website: base,
        logo: platform.logo || "",
        logoLight: platform.logoLight || "",
        primaryColor: platform.primaryColor || "",
        accentColor: platform.accentColor || "",
        backgroundColor: platform.backgroundColor || "",
        portalUrl: base,
        loginUrl: at("/login"),
        // The marketing site's real routes — see the platform router.
        donateUrl: "",
        contactUrl: at("/contact"),
        aboutUrl: at("/plans"),
        dashboardUrl: at("/get-started"),
        footer: [base.replace(/^https?:\/\//, ""), platform.supportEmail].filter(Boolean).join(" | "),
      };
    } else {
      ctx.org = await getOrgIdentity(org);
    }
  }

  // A default currency so `{{ amount | money }}` with no argument is sensible.
  if (!ctx.currency) ctx.currency = data.currency || "AUD";

  // Convenience: most templates greet by first name and most call sites only
  // have a full name. Deriving it here means no call site has to remember.
  if (ctx.recipient && !ctx.recipient.firstName && ctx.recipient.name) {
    ctx.recipient = { ...ctx.recipient, firstName: String(ctx.recipient.name).trim().split(/\s+/)[0] };
  }
  if (ctx.donor && !ctx.donor.firstName && ctx.donor.name) {
    ctx.donor = { ...ctx.donor, firstName: String(ctx.donor.name).trim().split(/\s+/)[0] };
  }
  return ctx;
}

/**
 * Scope-specific defaults the shared layout row cannot express.
 *
 * "Donate / My giving / Contact us" is the right footer for a charity's donor
 * mail and the wrong one for an operator invite, and the mark watermark is the
 * platform's own logo -- but one layout row serves both layers. Anything an
 * operator has actually customised is left exactly as they set it.
 */
const PLATFORM_FOOTER_LINKS = [
  { label: "Sign in", url: "{{org.loginUrl}}" },
  { label: "Plans", url: "{{org.aboutUrl}}" },
  { label: "Contact support", url: "{{org.contactUrl}}" },
];

const sameLinks = (a, b) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === b.length &&
  a.every((l, i) => l?.label === b[i]?.label && l?.url === b[i]?.url);

function platformDefaults(entry, layout) {
  if (entry.scope !== "platform") return layout;
  const next = { ...layout };
  if (sameLinks(layout?.footerLinks, DEFAULT_LAYOUT.footerLinks)) {
    next.footerLinks = PLATFORM_FOOTER_LINKS;
  }
  // The "mark" texture IS the platform's own logo, so it belongs on platform
  // mail and nowhere else -- a charity's receipt keeps the neutral tile unless
  // an operator picks the mark deliberately in the layout editor.
  if (layout?.headerPattern === DEFAULT_LAYOUT.headerPattern) next.headerPattern = "mark";
  if (layout?.footerPattern === DEFAULT_LAYOUT.footerPattern) next.footerPattern = "mark";
  return next;
}

/* -- rendering ------------------------------------------------------------- */

/**
 * Render a resolved template to a finished email.
 * `template` may be a draft from the editor rather than the stored one, which
 * is how the live preview and "send test" work without saving first.
 */
async function renderTemplate(key, { org, organisationId, data = {}, template, layout } = {}) {
  const entry = catalog.get(key);
  if (!entry) throw new Error(`Unknown email template "${key}"`);

  const orgId = organisationId !== undefined ? organisationId : asId(org);
  const tpl = template || (await resolveTemplate(key, orgId));
  const lay = platformDefaults(
    entry,
    layout || (await resolveLayout(entry.scope === "platform" ? null : orgId)),
  );

  // Most call sites have only an organisationId, not the document. Passing the
  // id straight through matters: getOrgIdentity() would otherwise be handed
  // `undefined` and every such email would be signed by the generic fallback
  // name instead of the tenant's -- the exact bug utils/orgIdentity.js exists
  // to prevent. It is stringified because an ObjectId is `typeof "object"`,
  // which that helper reads as an already-loaded document.
  const orgForContext = org || (orgId ? String(orgId) : null);
  const ctx = await buildContext(entry, orgForContext, data);

  // The organisation's OWN branding, straight from the Branding screen, seeds
  // the theme before any layout override is applied. This is what makes a
  // tenant's email look like their portal without anyone editing a template —
  // and what makes platform mail look like the SaaS product, since the platform
  // `org` block above carries PlatformSettings' branding instead.
  const brand = {
    primaryColor: ctx.org?.primaryColor,
    accentColor: ctx.org?.accentColor,
    backgroundColor: ctx.org?.backgroundColor,
  };

  const subject = renderString(tpl.subject || "", ctx).trim();
  const inner =
    tpl.mode === "html"
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td>${renderString(tpl.html || "", ctx)}</td></tr></table>`
      : blocksToHtml(tpl.blocks, ctx, lay.theme, brand);

  // A template's own preheader beats the layout's generic one.
  const layoutWithPreheader = { ...lay, preheader: tpl.preheader || lay.preheader };
  const html = wrapInLayout(inner, layoutWithPreheader, ctx, brand);

  return { subject, html, text: htmlToText(html), context: ctx, source: tpl.source };
}

/* -- sending --------------------------------------------------------------- */

/**
 * Send one catalogued email.
 *
 * @param {string} key                 catalog key, e.g. "donation.receipt"
 * @param {object} opts
 * @param {string|string[]} opts.to    recipient(s)
 * @param {object} [opts.org]          Organisation doc (preferred -- avoids a lookup)
 * @param {string} [opts.organisationId]
 * @param {object} [opts.data]         template variables
 * @param {Array}  [opts.attachments]  nodemailer attachments
 * @param {string} [opts.replyTo]
 * @param {object} [opts.meta]         breadcrumbs written to the email log
 * @returns {Promise<{success:boolean, skipped?:boolean, reason?:string}>}
 *
 * Never throws: transactional email is always a side effect of something more
 * important (a donation, a password reset) and must not be able to fail it.
 */
async function sendTemplateEmail(key, opts = {}) {
  // Required late so emailUtil can require this module without a cycle.
  const { sendEmail } = require("./emailUtil");

  const entry = catalog.get(key);
  if (!entry) {
    console.error(`[emailTemplates] unknown template key "${key}" -- not sending`);
    return { success: false, reason: "unknown_template" };
  }

  const to = Array.isArray(opts.to) ? opts.to.filter(Boolean).join(", ") : opts.to;
  if (!to) return { success: false, skipped: true, reason: "no_recipient" };

  try {
    const orgId = opts.organisationId !== undefined ? opts.organisationId : asId(opts.org);
    const tpl = await resolveTemplate(key, orgId);

    if (!tpl.enabled) {
      await logSkipped(key, { to, organisationId: orgId, reason: "template_disabled", meta: opts.meta });
      return { success: false, skipped: true, reason: "template_disabled" };
    }

    const { subject, html, text, source } = await renderTemplate(key, {
      org: opts.org,
      organisationId: orgId,
      data: opts.data,
      template: tpl,
    });

    if (!subject) {
      await logSkipped(key, { to, organisationId: orgId, reason: "empty_subject", meta: opts.meta });
      return { success: false, skipped: true, reason: "empty_subject" };
    }

    return await sendEmail(to, html, subject, opts.attachments || [], {
      org: opts.org,
      organisationId: orgId,
      replyTo: opts.replyTo,
      cc: opts.cc,
      headers: opts.headers,
      fromName: opts.fromName,
      text,
      // Sent HTML is already a complete document -- emailUtil must not re-wrap it.
      preRendered: true,
      log: { templateKey: key, source, meta: opts.meta },
    });
  } catch (err) {
    console.error(`[emailTemplates] send "${key}" failed:`, err.message);
    await logSkipped(key, {
      to,
      organisationId: asId(opts.org) || opts.organisationId,
      reason: "render_error",
      error: err.message,
      meta: opts.meta,
    });
    return { success: false, reason: "render_error", error: err };
  }
}

// A skip is worth a row: "we never even tried" is a different support answer
// from "the provider rejected it", and only the log can tell them apart.
async function logSkipped(key, { to, organisationId, reason, error, meta }) {
  try {
    const EmailLog = require("../models/emailLog");
    await EmailLog.create({
      templateKey: key,
      organisationId: organisationId && mongoose.isValidObjectId(organisationId) ? organisationId : null,
      to: String(to || "").slice(0, 320),
      status: "skipped",
      reason,
      error: error || "",
      meta: meta || {},
    });
  } catch {
    /* logging must never be the thing that breaks a send */
  }
}

/* -- editor support -------------------------------------------------------- */

/**
 * Render a template against the catalog's SAMPLE data, for the console's live
 * preview. Accepts an unsaved draft so the preview updates as it is typed.
 */
async function previewTemplate(key, { draft, organisationId, data } = {}) {
  const entry = catalog.get(key);
  if (!entry) throw new Error(`Unknown email template "${key}"`);

  // A draft may carry CONTENT (the template editor), a LAYOUT (the layout
  // editor previewing its wrapper around a real email), or both. A layout-only
  // draft must keep the stored content rather than rendering an empty card.
  const hasContent =
    !!draft &&
    (String(draft.subject || "").trim() ||
      (Array.isArray(draft.blocks) && draft.blocks.length) ||
      String(draft.html || "").trim());

  const template = hasContent
    ? {
        subject: draft.subject || "",
        preheader: draft.preheader || "",
        mode: draft.mode === "html" ? "html" : "blocks",
        blocks: Array.isArray(draft.blocks) ? draft.blocks : [],
        html: draft.html || "",
        source: "draft",
      }
    : await resolveTemplate(key, organisationId);

  // Sample values, overlaid with any real data the caller supplied.
  const sample = { ...catalog.sampleContext(key), ...(data || {}) };
  const layout = draft?.layout || (await resolveLayout(entry.scope === "platform" ? null : organisationId));

  return renderTemplate(key, {
    organisationId,
    data: sample,
    template,
    layout,
    // The sample context already carries a full `org` block, so buildContext
    // won't hit the database for one.
    org: null,
  });
}

module.exports = {
  resolveTemplate,
  resolveLayout,
  renderTemplate,
  previewTemplate,
  sendTemplateEmail,
  buildContext,
  platformIdentity,
  invalidate,
  // Exported for the tests: the swap is easy to break silently, since a wrong
  // footer still renders perfectly well.
  platformDefaults,
  PLATFORM_FOOTER_LINKS,
};
