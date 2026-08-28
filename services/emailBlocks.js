/**
 * services/emailBlocks.js
 *
 * Compiles the visual builder's block JSON into email-client-safe HTML, and
 * wraps a rendered body in the shared branded layout.
 *
 * Email HTML is not web HTML: Outlook renders through Word, Gmail strips <style>
 * blocks and clips messages past ~102KB, and flexbox/grid do not exist. So every
 * block below is a <table> with inline styles only, and colours/fonts come from a
 * resolved theme object rather than CSS variables.
 *
 * A block is `{ id, type, showIf?, ...props }`. `showIf` is a variable path --
 * the block is dropped when that path is empty, which is how the builder does
 * conditionals without asking an operator to type {{#if}}.
 */

const { renderString, escapeHtml, safeUrl, absoluteUrl } = require("./emailRender");

/* -- theme ---------------------------------------------------------------- */

// Falls back to a neutral, legible palette so a tenant with no branding still
// gets a decent email rather than an unstyled one.
const DEFAULT_THEME = {
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  // Headings get a serif and the body keeps the sans. Webfonts don't load in
  // Outlook or Gmail, so the only way to make an email read as *composed*
  // rather than *generated* is to use a face that is already on the machine —
  // and the mixture is what does the work, not the font itself.
  headingFontFamily: "Georgia, 'Times New Roman', Times, serif",
  // Deliberately neutral. The page is the paper an email is printed on; a
  // tinted field of brand colour around a white card reads as decoration.
  pageBg: "#f4f4f5",
  cardBg: "#ffffff",
  textColor: "#1f2937",
  mutedColor: "#6b7280",
  headingColor: "#111827",
  accentColor: "#047857",
  accentTextColor: "#ffffff",
  borderColor: "#e5e7eb",
  panelBg: "#f9fafb",
  // The header band: the organisation's primary colour, with text picked for
  // contrast rather than assumed white.
  brandColor: "#102a23",
  brandTextColor: "#ffffff",
  radius: 10,
  contentWidth: 600,
  fontSize: 15,
};

/* -- colour maths ---------------------------------------------------------
 * Brand colours are operator-chosen and can be anything — a pale gold, a near
 * white. Assuming white text on them is how you ship an unreadable header, so
 * every colour used as a background has its foreground computed.
 */

function parseHex(hex) {
  const h = String(hex || "").trim().replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb
    .map((c) => c / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Ink or paper, whichever is legible on `bg`. */
function readableOn(bg, dark = "#1f2937", light = "#ffffff") {
  const l = luminance(bg);
  if (l === null) return light;
  return l > 0.45 ? dark : light;
}

/**
 * The same colour with its saturation taken out — a grey at the brand's own
 * perceived lightness, with a whisper of the original mixed back so a warm
 * brand still gets warm paper.
 *
 * A brand's `backgroundColor` is chosen for a whole web page, where it sits
 * behind text and imagery. Six hundred pixels of it around a white email card
 * reads as a coloured field instead of as paper, which is why the page behind
 * an email is ash rather than the brand tint itself.
 */
function ash(hex, keep = 0.12) {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const v = Math.round(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]);
  const grey = `#${[v, v, v].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  return mix(grey, hex, keep);
}

/** Blend `hex` toward `target` — used to tint a page background from a brand. */
function mix(hex, target, ratio) {
  const a = parseHex(hex);
  const b = parseHex(target);
  if (!a || !b) return hex;
  const out = a.map((c, i) => Math.round(c + (b[i] - c) * ratio));
  return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The shipped layout, and the base every stored EmailLayout row is merged over.
 *
 * These deliberately do NOT live as Mongoose defaults on the model. A stored row
 * must contain only what an operator explicitly set: if a tenant's row carried a
 * full set of defaults, it would silently override every field of the platform
 * layout the moment they changed a single colour, and partial inheritance —
 * "just my accent, everything else follows the platform" — would be impossible.
 */
const DEFAULT_LAYOUT = {
  showHeader: true,
  showLogo: true,
  // "band" paints the header in the organisation's primary colour; "plain" is
  // the older bare-logo-on-the-page-background look, kept for anyone who wants
  // it. The band is the default because a logo floating on grey reads as an
  // unstyled system message, which is what these emails used to look like.
  headerStyle: "band",
  logoUrl: "{{org.logo}}",
  // The band is dark, so it takes the light logo variant; `logoUrl` is used
  // when the header is plain (and as the fallback when only one exists).
  logoUrlOnDark: "{{org.logoLight}}",
  logoHeight: 40,
  headerAlign: "left",
  // The organisation's name, set in type beside the logo. On by default: many
  // clients block images, and a header that identifies the sender only through
  // an image identifies nothing the moment that image fails.
  showBrandName: true,
  // A tiling texture on the band -- see PATTERNS. Enhancement only; clients
  // that drop background images still get the solid brand colour.
  headerPattern: "rings",
  // A one-line strapline under the logo. Empty by default — a tenant's tagline
  // is theirs to write.
  headerTagline: "",
  footerText: "{{org.footer}}",
  footerAlign: "center",
  // Real destinations, not decoration. Each renders only if its URL resolves,
  // so a tenant with no portal simply gets fewer links rather than dead ones.
  footerLinks: [
    { label: "Donate", url: "{{org.donateUrl}}" },
    { label: "My giving", url: "{{org.dashboardUrl}}" },
    { label: "Contact us", url: "{{org.contactUrl}}" },
  ],
  // "band" closes the letter the way the header opened it, joined to the card;
  // "panel" is the same shape in a pale tint; "plain" is bare text under it.
  footerStyle: "band",
  footerPattern: "rings",
  legalText: "You're receiving this because you interacted with {{org.name}}.",
  showPlatformCredit: false,
  platformCreditText: 'Powered by <a href="{{platform.url}}">{{platform.name}}</a>',
  preheader: "",
  documentTitle: "{{org.name}}",
  theme: {},
};

const TONE_COLORS = {
  info: { bg: "#eff6ff", border: "#bfdbfe", text: "#1e3a8a" },
  success: { bg: "#ecfdf5", border: "#a7f3d0", text: "#065f46" },
  warning: { bg: "#fffbeb", border: "#fde68a", text: "#92400e" },
  danger: { bg: "#fef2f2", border: "#fecaca", text: "#991b1b" },
  neutral: { bg: "#f9fafb", border: "#e5e7eb", text: "#374151" },
};

const ALIGNS = new Set(["left", "center", "right"]);
const align = (v) => (ALIGNS.has(v) ? v : "left");
const px = (v, fallback) => {
  const n = Number(v);
  return isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * The theme, in three layers: shipped defaults, then the ORGANISATION'S OWN
 * BRANDING, then whatever an operator explicitly set in the layout editor.
 *
 * The middle layer is the point. A tenant who has uploaded a logo and picked
 * colours on the Branding screen should get emails that look like their portal
 * without touching this editor at all — that is what "their branding" means.
 * Anything they then set here is a deliberate override and still wins.
 *
 * @param {object} overrides  the stored layout's `theme`
 * @param {object} brand      { primaryColor, accentColor, backgroundColor }
 */
function resolveTheme(overrides, brand) {
  const theme = { ...DEFAULT_THEME };

  const primary = String(brand?.primaryColor || "").trim();
  const accent = String(brand?.accentColor || "").trim();
  const background = String(brand?.backgroundColor || "").trim();

  if (primary && parseHex(primary)) {
    theme.brandColor = primary;
    theme.brandTextColor = readableOn(primary);
    theme.headingColor = primary;
  }
  if (accent && parseHex(accent)) {
    theme.accentColor = accent;
    theme.accentTextColor = readableOn(accent);
  }
  if (background && parseHex(background)) {
    // Desaturated, not used raw: see ash(). An operator who genuinely wants the
    // brand tint can still set theme.pageBg in the layout editor.
    theme.pageBg = ash(background);
  }

  for (const [k, v] of Object.entries(overrides || {})) {
    if (v !== undefined && v !== null && v !== "") theme[k] = v;
  }

  // An operator who sets an accent but not its text colour should still get a
  // legible button, so recompute unless they said otherwise explicitly.
  if (overrides?.accentColor && !overrides?.accentTextColor) {
    theme.accentTextColor = readableOn(theme.accentColor);
  }
  if (overrides?.brandColor && !overrides?.brandTextColor) {
    theme.brandTextColor = readableOn(theme.brandColor);
  }
  return theme;
}

/* -- block compilers ------------------------------------------------------ */

// One shared full-width row so every block sits on the same grid.
const row = (inner, pad = "0 0 16px 0") =>
  `<tr><td style="padding:${pad};">${inner}</td></tr>`;

const HEADING_SIZES = { 1: 32, 2: 25, 3: 18 };

/**
 * The small letterspaced label that sits above a heading ("YOUR RECEIPT",
 * "STEP 2 OF 3"). It costs one line and does more for how considered an email
 * looks than any other single thing here.
 */
const eyebrow = (text, t, colour) =>
  text
    ? `<div style="margin:0 0 10px 0;font-family:${t.fontFamily};font-size:11px;font-weight:700;` +
      `letter-spacing:.14em;text-transform:uppercase;color:${colour || t.accentColor};">${text}</div>`
    : "";

const COMPILERS = {
  heading(b, ctx, t) {
    const level = [1, 2, 3].includes(Number(b.level)) ? Number(b.level) : 2;
    const size = HEADING_SIZES[level];
    const text = renderString(b.text || "", ctx);
    if (!text.trim()) return "";
    const face = b.font === "sans" ? t.fontFamily : t.headingFontFamily;
    const weight = b.font === "sans" ? 700 : 600;
    return row(
      `<div style="text-align:${align(b.align)};">` +
        eyebrow(renderString(b.eyebrow || "", ctx), t) +
        `<h${level} style="margin:0;font-family:${face};font-size:${size}px;line-height:1.25;` +
        `font-weight:${weight};letter-spacing:-.01em;color:${b.color || t.headingColor};">${text}</h${level}>` +
        `</div>`,
      "6px 0 14px 0",
    );
  },

  /**
   * The one number that matters, set large: an amount received, a total raised,
   * a countdown. Receipts used to bury the figure inside a details panel, where
   * it read as a field rather than as the point of the email.
   */
  hero(b, ctx, t) {
    const figure = renderString(b.figure || "", ctx);
    if (!figure.trim()) return "";
    const label = renderString(b.label || "", ctx);
    const caption = renderString(b.caption || "", ctx);
    const a = align(b.align || "center");
    const tint = b.background || mix(t.accentColor, t.cardBg, 0.92);
    return row(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
        `style="background:${tint};border-radius:${px(t.radius, 10) * 1.2}px;">` +
        `<tr><td style="padding:26px 24px;text-align:${a};">` +
        eyebrow(label, t) +
        // `mono` is for codes and references, where the character shapes have to
        // be unambiguous and the tracking wants to be open rather than tight.
        `<div style="font-family:${b.mono ? "SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace" : t.headingFontFamily};` +
        `font-size:${b.mono ? 36 : 40}px;line-height:1.1;font-weight:${b.mono ? 700 : 600};` +
        `letter-spacing:${b.mono ? ".18em;padding-left:.18em" : "-.02em"};color:${b.color || t.headingColor};">${figure}</div>` +
        (caption
          ? `<div style="padding-top:8px;font-family:${t.fontFamily};font-size:14px;line-height:1.5;color:${t.mutedColor};">${caption}</div>`
          : "") +
        `</td></tr></table>`,
    );
  },

  /**
   * "What happens next", numbered. Ordered lists in email are styled
   * inconsistently across clients, so the numerals are drawn as accent discs in
   * a table instead of left to <ol>.
   */
  steps(b, ctx, t) {
    const items = (Array.isArray(b.items) ? b.items : [])
      .map((it) => ({
        title: renderString((typeof it === "string" ? it : it && it.title) || "", ctx),
        text: renderString((it && it.text) || "", ctx),
      }))
      .filter((it) => it.title || it.text);
    if (!items.length) return "";

    const rows = items
      .map((it, i) => {
        const last = i === items.length - 1;
        return (
          `<tr>` +
          `<td width="34" style="width:34px;padding:0 14px ${last ? 0 : 16}px 0;vertical-align:top;">` +
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
          `<td style="width:28px;height:28px;border-radius:14px;background:${t.accentColor};` +
          `text-align:center;vertical-align:middle;font-family:${t.fontFamily};font-size:13px;` +
          `font-weight:700;color:${t.accentTextColor};">${i + 1}</td>` +
          `</tr></table></td>` +
          `<td style="padding:0 0 ${last ? 0 : 16}px 0;vertical-align:top;">` +
          (it.title
            ? `<div style="font-family:${t.fontFamily};font-size:15px;font-weight:700;line-height:1.45;color:${t.headingColor};">${it.title}</div>`
            : "") +
          (it.text
            ? `<div style="padding-top:3px;font-family:${t.fontFamily};font-size:14px;line-height:1.6;color:${t.mutedColor};">${it.text}</div>`
            : "") +
          `</td></tr>`
        );
      })
      .join("");

    return row(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`,
      "4px 0 20px 0",
    );
  },

  /** Two or three figures side by side — payments made, total given, days left. */
  stats(b, ctx, t) {
    const items = (Array.isArray(b.items) ? b.items : [])
      .map((it) => ({
        value: renderString((it && it.value) || "", ctx),
        label: renderString((it && it.label) || "", ctx),
      }))
      .filter((it) => String(it.value).trim())
      .slice(0, 3);
    if (!items.length) return "";
    const w = Math.floor(100 / items.length);
    const cells = items
      .map(
        (it, i) =>
          `<td width="${w}%" style="width:${w}%;padding:14px 12px;text-align:center;vertical-align:top;` +
          `${i ? `border-left:1px solid ${t.borderColor};` : ""}">` +
          `<div style="font-family:${t.headingFontFamily};font-size:24px;line-height:1.2;font-weight:600;color:${t.headingColor};">${it.value}</div>` +
          `<div style="padding-top:5px;font-family:${t.fontFamily};font-size:11px;font-weight:600;` +
          `letter-spacing:.1em;text-transform:uppercase;color:${t.mutedColor};">${it.label}</div></td>`,
      )
      .join("");
    return row(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
        `style="border:1px solid ${t.borderColor};border-radius:${px(t.radius, 10)}px;">` +
        `<tr>${cells}</tr></table>`,
    );
  },

  /**
   * A human sign-off: a monogram, a name, a role. An email that ends with a
   * person on it reads as written rather than triggered.
   */
  signature(b, ctx, t) {
    const name = renderString(b.name || "", ctx);
    if (!name.trim()) return "";
    const role = renderString(b.role || "", ctx);
    const note = renderString(b.note || "", ctx);
    const initials = String(name)
      .replace(/&[a-z]+;/gi, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
    return row(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0">` +
        (note
          ? `<tr><td colspan="2" style="padding:0 0 14px 0;font-family:${t.fontFamily};font-size:${t.fontSize}px;line-height:1.65;color:${t.textColor};">${note}</td></tr>`
          : "") +
        `<tr><td width="44" style="width:44px;padding-right:12px;vertical-align:middle;">` +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td style="width:40px;height:40px;border-radius:20px;background:${mix(t.accentColor, t.cardBg, 0.82)};` +
        `text-align:center;vertical-align:middle;font-family:${t.fontFamily};font-size:14px;` +
        `font-weight:700;color:${t.accentColor};">${escapeHtml(initials)}</td></tr></table></td>` +
        `<td style="vertical-align:middle;">` +
        `<div style="font-family:${t.fontFamily};font-size:14px;font-weight:700;color:${t.headingColor};">${name}</div>` +
        (role
          ? `<div style="padding-top:2px;font-family:${t.fontFamily};font-size:13px;color:${t.mutedColor};">${role}</div>`
          : "") +
        `</td></tr></table>`,
      "8px 0 4px 0",
    );
  },

  paragraph(b, ctx, t) {
    const text = renderString(b.text || "", ctx);
    if (!text.trim()) return "";
    const size = px(b.size, t.fontSize);
    return row(
      `<p style="margin:0;font-family:${t.fontFamily};font-size:${size}px;line-height:1.65;` +
        `color:${b.color || t.textColor};text-align:${align(b.align)};">${text}</p>`,
    );
  },

  button(b, ctx, t) {
    const label = renderString(b.label || "", ctx);
    const url = safeUrl(renderString(b.url || "", ctx));
    // No destination means no button, rather than a dead one.
    if (!label.trim() || !url) return "";

    const outline = b.style === "outline";
    const base = b.color || t.accentColor;
    const bg = outline ? "transparent" : base;
    const fg = outline ? base : t.accentTextColor;
    const radius = px(t.radius, 10);
    const arrow = b.arrow === false ? "" : ' <span style="font-family:Arial,sans-serif;">&rarr;</span>';
    const a = align(b.align || "center");
    const margin = a === "center" ? "0 auto" : a === "right" ? "0 0 0 auto" : "0";

    // Outlook renders through Word, which ignores border-radius — so desktop
    // Outlook alone gets a VML rounded rectangle. The width is estimated from
    // the label because VML needs an explicit one; the text is centred inside,
    // so being a few pixels out is invisible.
    const plain = label.replace(/<[^>]*>/g, "");
    const vmlWidth = Math.min(420, Math.max(160, plain.length * 9 + 62));
    const vml =
      `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" ` +
      `href="${url}" style="height:46px;v-text-anchor:middle;width:${vmlWidth}px;" arcsize="${Math.round(
        (radius / 46) * 100,
      )}%" ` +
      `${outline ? `strokecolor="${base}" fillcolor="${t.cardBg}"` : `stroke="f" fillcolor="${base}"`}>` +
      `<w:anchorlock/><center style="color:${fg};font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${plain}</center>` +
      `</v:roundrect><![endif]-->`;

    const note = renderString(b.note || "", ctx);
    const noteHtml = note
      ? `<div style="padding-top:12px;font-family:${t.fontFamily};font-size:12px;line-height:1.6;color:${t.mutedColor};text-align:${a};">${note}</div>`
      : "";

    return row(
      `<div style="text-align:${a};">${vml}` +
        `<!--[if !mso]><!-- -->` +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:${margin};">` +
        `<tr><td style="border-radius:${radius}px;background:${bg};border:1.5px solid ${base};mso-padding-alt:0;">` +
        `<a class="ep-btn" href="${url}" style="display:inline-block;padding:14px 30px;font-family:${t.fontFamily};` +
        `font-size:15px;font-weight:600;line-height:1.2;letter-spacing:.01em;color:${fg};text-decoration:none;` +
        `border-radius:${radius}px;">${label}${arrow}</a>` +
        `</td></tr></table>` +
        `<!--<![endif]-->` +
        `</div>${noteHtml}`,
      "10px 0 22px 0",
    );
  },

  divider(b, ctx, t) {
    const line = `<td style="border-top:1px solid ${b.color || t.borderColor};font-size:0;line-height:0;">&nbsp;</td>`;
    // A mark in the gap turns a plain rule into a section break.
    const inner = b.mark
      ? line +
        `<td width="34" style="width:34px;text-align:center;font-family:${t.fontFamily};font-size:11px;` +
        `line-height:1;color:${t.accentColor};">&#9670;</td>` +
        line
      : line;
    return row(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${inner}</tr></table>`,
      "14px 0 24px 0",
    );
  },

  spacer(b) {
    const h = px(b.size, 16);
    return `<tr><td style="height:${h}px;font-size:0;line-height:0;">&nbsp;</td></tr>`;
  },

  // The grey "here are the details" box used by receipts, registrations, etc.
  panel(b, ctx, t) {
    const rows = (Array.isArray(b.rows) ? b.rows : [])
      .filter((r) => visible(r, ctx))
      .map((r) => {
        const label = renderString(r.label || "", ctx);
        const value = renderString(r.value || "", ctx);
        if (!String(value).trim()) return "";
        // A row marked `strong` is the one the reader is looking for — the
        // amount, the reference — so it is set larger rather than uniform.
        const big = !!r.strong;
        return (
          `<tr>` +
          `<td style="padding:6px 14px 6px 0;font-family:${t.fontFamily};font-size:13px;` +
          `color:${t.mutedColor};white-space:nowrap;vertical-align:top;">${label}</td>` +
          `<td style="padding:6px 0;font-family:${big ? t.headingFontFamily : t.fontFamily};` +
          `font-size:${big ? 18 : 14}px;font-weight:600;text-align:right;` +
          `color:${big ? t.headingColor : t.textColor};vertical-align:top;">${value}</td>` +
          `</tr>`
        );
      })
      .join("");
    if (!rows) return "";
    const title = renderString(b.title || "", ctx);
    return row(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
        `style="background:${b.background || t.panelBg};border:1px solid ${t.borderColor};` +
        `border-left:3px solid ${t.accentColor};` +
        `border-radius:${px(t.radius, 10)}px;"><tr><td style="padding:18px 20px;">` +
        (title
          ? `<div style="font-family:${t.fontFamily};font-size:11px;font-weight:700;` +
            `letter-spacing:.14em;text-transform:uppercase;color:${t.accentColor};` +
            `padding-bottom:12px;">${title}</div>`
          : "") +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>` +
        `</td></tr></table>`,
    );
  },

  callout(b, ctx, t) {
    const text = renderString(b.text || "", ctx);
    if (!text.trim()) return "";
    const tone = TONE_COLORS[b.tone] || TONE_COLORS.neutral;
    return row(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
        `style="background:${tone.bg};border:1px solid ${tone.border};border-radius:${px(t.radius, 10)}px;">` +
        `<tr><td style="padding:14px 18px;font-family:${t.fontFamily};font-size:14px;line-height:1.6;` +
        `color:${tone.text};">${text}</td></tr></table>`,
    );
  },

  list(b, ctx, t) {
    const items = (Array.isArray(b.items) ? b.items : [])
      .map((i) => renderString(typeof i === "string" ? i : i && i.text, ctx))
      .filter((s) => String(s).trim());
    if (!items.length) return "";
    const tag = b.style === "number" ? "ol" : "ul";
    return row(
      `<${tag} style="margin:0;padding-left:22px;font-family:${t.fontFamily};font-size:${t.fontSize}px;` +
        `line-height:1.7;color:${t.textColor};">` +
        items.map((i) => `<li style="margin:0 0 6px 0;">${i}</li>`).join("") +
        `</${tag}>`,
    );
  },

  image(b, ctx, t) {
    const src = absoluteUrl(renderString(b.src || "", ctx));
    if (!src) return "";
    const alt = escapeHtml(renderString(b.alt || "", ctx));
    const width = px(b.width, 0);
    const img =
      `<img src="${src}" alt="${alt}" ${width ? `width="${width}" ` : ""}` +
      `style="display:block;border:0;outline:none;text-decoration:none;max-width:100%;height:auto;` +
      `${width ? `width:${width}px;` : ""}border-radius:${px(t.radius, 10)}px;" />`;
    const href = safeUrl(renderString(b.href || "", ctx));
    const wrapped = href ? `<a href="${href}" style="text-decoration:none;">${img}</a>` : img;
    return row(`<div style="text-align:${align(b.align)};">${wrapped}</div>`);
  },

  quote(b, ctx, t) {
    const text = renderString(b.text || "", ctx);
    if (!text.trim()) return "";
    const cite = renderString(b.cite || "", ctx);
    return row(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td style="border-left:3px solid ${t.accentColor};padding:6px 0 6px 20px;">` +
        `<div style="font-family:${t.headingFontFamily};font-size:19px;line-height:1.55;` +
        `font-style:italic;color:${t.headingColor};">${text}</div>` +
        (cite
          ? `<div style="font-family:${t.fontFamily};font-size:13px;color:${t.mutedColor};padding-top:6px;">— ${cite}</div>`
          : "") +
        `</td></tr></table>`,
    );
  },

  // Repeats over an array variable -- the itemised rows of a receipt, the
  // installment schedule, a campaign's donations.
  table(b, ctx, t) {
    const columns = (Array.isArray(b.columns) ? b.columns : []).filter((c) => c && c.value);
    if (!columns.length) return "";
    const source = String(b.source || "").trim();
    if (!source) return "";

    const head = columns
      .map(
        (c) =>
          `<th style="padding:8px 10px;font-family:${t.fontFamily};font-size:12px;font-weight:700;` +
          `letter-spacing:.05em;text-transform:uppercase;color:${t.mutedColor};text-align:${align(c.align)};` +
          `border-bottom:1px solid ${t.borderColor};">${renderString(c.label || "", ctx)}</th>`,
      )
      .join("");

    // One {{#each}} pass rendered by the same engine, so cells can use `this.x`
    // and still reach the outer context for things like the currency code.
    const bodyTpl =
      `{{#each ${source}}}<tr>` +
      columns
        .map(
          (c) =>
            `<td style="padding:10px;font-family:${t.fontFamily};font-size:14px;color:${t.textColor};` +
            `text-align:${align(c.align)};border-bottom:1px solid ${t.borderColor};">${c.value}</td>`,
        )
        .join("") +
      `</tr>{{/each}}`;
    const body = renderString(bodyTpl, ctx);
    if (!body.trim()) return "";

    const totalValue = b.totalValue ? renderString(b.totalValue, ctx) : "";
    const foot =
      b.showTotal && String(totalValue).trim()
        ? `<tr><td colspan="${columns.length - 1}" style="padding:12px 10px;font-family:${t.fontFamily};` +
          `font-size:14px;font-weight:700;color:${t.textColor};text-align:right;">` +
          `${renderString(b.totalLabel || "Total", ctx)}</td>` +
          `<td style="padding:12px 10px;font-family:${t.fontFamily};font-size:15px;font-weight:700;` +
          `color:${t.accentColor};text-align:${align(columns[columns.length - 1].align)};">${totalValue}</td></tr>`
        : "";

    return row(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
        `style="border-collapse:collapse;"><thead><tr>${head}</tr></thead>` +
        `<tbody>${body}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ""}</table>`,
    );
  },

  // Escape hatch: raw operator HTML, variables still interpolated + escaped.
  html(b, ctx) {
    const html = renderString(b.html || "", ctx);
    return html.trim() ? row(html) : "";
  },
};

/**
 * A block is shown unless its `showIf` path resolves to something empty.
 * A leading "!" inverts it ("!tenant.setPasswordUrl" = show only when that is
 * NOT set), which is what lets two mutually exclusive blocks — a "set your
 * password" button and a "log in" button — live in one template without asking
 * an operator to hand-write {{#unless}}.
 */
function visible(block, ctx) {
  if (block.hidden) return false;
  let cond = String(block.showIf || "").trim();
  if (!cond) return true;
  const negated = cond.startsWith("!");
  if (negated) cond = cond.slice(1).trim();
  if (!cond) return true;
  // Reuse the engine's own truthiness so `showIf` and {{#if}} agree.
  const helper = negated ? "unless" : "if";
  return renderString(`{{#${helper} ${cond}}}1{{/${helper}}}`, ctx) === "1";
}

/**
 * Compile an array of blocks into the inner HTML of the email card.
 * Unknown block types are skipped rather than throwing -- a template saved by a
 * newer build must not break sending on an older one.
 */
function blocksToHtml(blocks, ctx, themeOverrides, brand) {
  const t = resolveTheme(themeOverrides, brand);
  const rows = (Array.isArray(blocks) ? blocks : [])
    .filter((b) => b && COMPILERS[b.type] && visible(b, ctx))
    .map((b) => {
      try {
        return COMPILERS[b.type](b, ctx, t);
      } catch (err) {
        console.error(`[emailBlocks] block "${b.type}" failed:`, err.message);
        return "";
      }
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`;
}

/* -- layout --------------------------------------------------------------- */

/**
 * Wrap rendered body HTML in the shared branded shell: preheader, logo header,
 * content card, footer with contact details and optional platform credit.
 *
 * `layout` is the stored EmailLayout document (already resolved tenant ->
 * platform), `ctx` the same data context the body was rendered with.
 */
/* -- decorative patterns -------------------------------------------------
 * A flat colour band reads as a system notification; a texture reads as
 * stationery. These tile as CSS background-images, which Apple Mail,
 * Outlook.com, Yahoo and the iOS clients honour. Gmail and desktop Outlook drop
 * background images entirely, so the pattern is enhancement only -- the solid
 * colour underneath is always painted first, and ruleStrip() below carries the
 * same idea in plain table cells, which every client renders.
 *
 * No parentheses or apostrophes in these strings: they end up inside an
 * unquoted CSS url() inside an HTML style="" attribute.
 */
// The platform mark, traced from src/assets/Donexus Logo/Donexus-268.png with
// a marching-squares contour trace and simplified to ~275 points in a 200x200
// box. It has to be a PATH rather than the PNG: a watermark is drawn at a low
// fill-opacity, and CSS gives no way to fade a background raster. `fill-rule`
// is evenodd because the eight ribbon loops are hollow.
const MARK_PATH =
  "M70 0L64 2L59 7L60 14L68 8L81 6L81 4L78 1L71 0ZM125 0L122 1L118 6L129 7L136 10L139 14L141 12L140 6L133 1L127 0ZM82 3L84 19L81 34L86 38L90 34L92 18L89 8L84 3ZM116 3L109 12L108 29L120 63L123 76L145 82L150 79L151 75L136 70L132 67L121 42L116 21L116 11L118 3ZM58 11L56 14L56 23L59 31L71 43L94 58L98 62L102 62L114 53L111 44L108 44L102 50L98 50L76 34L62 20L58 12ZM142 11L138 20L123 34L125 44L127 44L131 41L140 32L143 27L144 23L143 12ZM76 49L68 66L63 70L29 82L24 84L8 84L5 82L4 84L9 89L14 92L24 93L35 90L61 80L75 78L77 76L80 63L82 58L82 54L76 49ZM16 55L12 57L23 63L35 78L43 76L45 74L41 69L29 59L21 55L17 55ZM177 55L169 59L161 66L142 94L137 99L137 101L148 114L156 110L150 101L150 99L164 77L175 66L188 57L184 55L179 55ZM189 59L186 60L193 69L193 81L197 80L199 76L199 68L197 64L193 60L190 59ZM8 60L3 64L1 69L1 76L6 81L7 81L7 71L11 64L14 60L9 60ZM165 81L161 88L173 92L188 90L192 88L196 83L179 84L177 82L166 81ZM52 86L44 90L50 99L50 101L36 123L24 136L12 143L16 145L23 145L31 141L39 134L47 124L50 117L63 101L63 99L53 86ZM175 107L165 110L139 120L123 123L120 137L118 142L118 146L124 151L131 135L133 131L139 130L156 122L175 116L197 118L191 111L186 108L176 107ZM16 108L8 112L4 116L5 118L8 116L23 116L29 119L35 119L39 114L38 112L28 108L17 108ZM54 118L49 124L58 129L68 133L79 158L84 178L84 197L91 188L92 171L80 137L77 124L55 118ZM6 119L1 124L1 131L3 136L7 140L10 141L14 140L8 133L7 119ZM193 119L193 129L186 140L194 139L198 134L199 124L194 119ZM163 122L155 126L167 139L179 145L184 145L188 143L175 134L167 124L164 122ZM101 137L86 147L89 156L92 156L101 149L105 154L112 157L131 172L141 184L142 188L144 187L144 176L141 169L129 157L110 145L101 137ZM73 156L60 168L56 177L56 186L58 189L62 180L77 166L77 162L75 156ZM113 162L110 166L108 181L111 192L116 197L118 196L116 189L116 181L119 166L114 162ZM61 186L59 188L60 194L68 199L72 200L78 199L82 194L72 193L64 190L62 187ZM139 186L132 192L120 193L119 196L125 200L136 198L141 193L140 186Z";

const TILE = "background-repeat:repeat;";

/**
 * Each entry is { svg(colour, opacity), css, alpha } -- `css` places it and
 * `alpha` scales the caller's opacity, because a solid shape carries far more
 * weight than hairlines do at the same value.
 */
const PATTERNS = {
  // The mark itself, large and faint, bleeding off the right edge: the same
  // move as the watermark behind the platform sign-in screen. This is the
  // PLATFORM's mark, so platform-scope mail opts into it and a charity's email
  // keeps a neutral texture unless an operator picks this one deliberately.
  mark: {
    svg: (c, o, size) =>
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + (size || 330) + '" height="' + (size || 330) +
      '" viewBox="0 0 200 200">' +
      '<path fill="' + c + '" fill-opacity="' + o + '" fill-rule="evenodd" d="' + MARK_PATH + '"/></svg>',
    css: "background-repeat:no-repeat;background-position:112% 50%;",
    alpha: 0.5,
  },
  // Overlapping circles -- a lattice of connections, which is the right motif
  // for this product and the least "corporate wallpaper" of the set.
  rings: {
    svg: (c, o) =>
      '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">' +
      '<g fill="none" stroke="' + c + '" stroke-opacity="' + o + '" stroke-width="1.25">' +
      '<circle cx="0" cy="36" r="17"/><circle cx="36" cy="36" r="17"/><circle cx="72" cy="36" r="17"/>' +
      '<circle cx="18" cy="0" r="17"/><circle cx="54" cy="0" r="17"/>' +
      '<circle cx="18" cy="72" r="17"/><circle cx="54" cy="72" r="17"/></g></svg>',
    css: TILE,
  },
  dots: {
    svg: (c, o) =>
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
      '<g fill="' + c + '" fill-opacity="' + o + '"><circle cx="4" cy="4" r="1.6"/>' +
      '<circle cx="16" cy="16" r="1.6"/></g></svg>',
    css: TILE,
  },
  grid: {
    svg: (c, o) =>
      '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">' +
      '<path d="M28 0 L0 0 L0 28" fill="none" stroke="' + c + '" stroke-opacity="' + o + '" stroke-width="1"/></svg>',
    css: TILE,
  },
  weave: {
    svg: (c, o) =>
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
      '<path d="M-4 4 L4 -4 M0 16 L16 0 M12 20 L20 12" fill="none" stroke="' + c + '" ' +
      'stroke-opacity="' + o + '" stroke-width="1.4"/></svg>',
    css: TILE,
  },
  waves: {
    svg: (c, o) =>
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="24" viewBox="0 0 80 24">' +
      '<g fill="none" stroke="' + c + '" stroke-opacity="' + o + '" stroke-width="1.25">' +
      '<path d="M0 18 Q10 6 20 18 T40 18 T60 18 T80 18"/>' +
      '<path d="M0 8 Q10 -4 20 8 T40 8 T60 8 T80 8"/></g></svg>',
    css: TILE,
  },
};

const PATTERN_NAMES = ["none", ...Object.keys(PATTERNS)];

/**
 * A background-image declaration, or "" for "none" / an unknown name.
 *
 * `opts.place` overrides where the pattern sits and `opts.size` how large it is
 * drawn. The footer uses both: there the mark is a centred seal rather than the
 * header's crop bleeding off the right edge.
 */
function patternCss(name, colour, opacity, opts) {
  const pat = PATTERNS[name];
  if (!pat || !colour) return "";
  const alpha = Math.round(opacity * (pat.alpha || 1) * 1000) / 1000;
  const svg = encodeURIComponent(pat.svg(colour, alpha, opts && opts.size))
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/'/g, "%27");
  return `background-image:url(data:image/svg+xml,${svg});${(opts && opts.place) || pat.css}`;
}

/**
 * The accent rule that edges a band: a gradient, faked with solid table cells
 * because email has no gradient Outlook will honour.
 *
 * Twenty EQUAL steps, not a handful of uneven ones. An earlier version
 * alternated between the accent and the band colour to suggest a dissolve, and
 * read as a row of broken blocks instead. At 5% each the steps are 30px wide on
 * a 600px email, fine enough to pass for a fade.
 *
 * `reverse` turns it through 180 degrees for the closing rule above the footer:
 * dark on the left running back up to the accent on the right. Two rules facing
 * each other frame the message; one on its own reads as a lid.
 */
const RULE_STEPS = 20;

function ruleStrip(accent, into, height = 4, reverse = false) {
  const cells = [];
  for (let i = 0; i < RULE_STEPS; i += 1) {
    // Eased, so the accent holds through the first third before falling away.
    const p = i / (RULE_STEPS - 1);
    cells.push(mix(accent, into, p * p));
  }
  if (reverse) cells.reverse();
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;border-collapse:collapse;"><tr>` +
    cells
      .map(
        (c) =>
          `<td width="5%" height="${height}" style="height:${height}px;` +
          `background-color:${c};font-size:0;line-height:0;">&nbsp;</td>`,
      )
      .join("") +
    `</tr></table>`
  );
}

/**
 * Wrap bare email addresses and domains in an anchor with an explicit colour.
 *
 * Mail clients auto-link them otherwise, in their own default blue, which on a
 * dark footer band is close to unreadable — and a link the client invented
 * cannot be styled. Wrapping them first is the only fix. Used on the footer's
 * contact and legal lines only, where the text is short and structured.
 */
function autoLink(html, colour) {
  const style = `color:${colour};text-decoration:none;`;
  const TOKEN =
    /([\w.+-]+@[\w-]+(?:\.[\w-]+)+)|((?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s<)]*)?)/gi;
  let depth = 0;
  return String(html || "")
    .split(/(<[^>]*>)/)
    .map((chunk) => {
      if (/^<\/a/i.test(chunk)) {
        depth = Math.max(0, depth - 1);
        return chunk;
      }
      if (/^<a\b/i.test(chunk)) {
        depth += 1;
        return chunk;
      }
      // Tags pass through, and so does anything already inside a link.
      if (chunk.startsWith("<") || depth) return chunk;
      return chunk.replace(TOKEN, (m, email) =>
        email
          ? `<a class="ep-link" href="mailto:${m}" style="${style}">${m}</a>`
          : `<a class="ep-link" href="${/^https?:/i.test(m) ? m : `https://${m}`}" style="${style}">${m}</a>`,
      );
    })
    .join("");
}

function wrapInLayout(bodyHtml, layout, ctx, brand) {
  const l = layout || {};
  const t = resolveTheme(l.theme, brand);
  const width = px(t.contentWidth, 600);
  const r = px(t.radius, 10);
  const cardRadius = Math.round(r * 1.4);

  // Hidden text some clients show next to the subject in the inbox list.
  const preheader = renderString(l.preheader || "", ctx).replace(/<[^>]*>/g, "").trim();
  const preheaderHtml = preheader
    ? `<div style="display:none;font-size:1px;color:${t.pageBg};line-height:1px;max-height:0;` +
      `max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheader)}` +
      `${"&#847;&zwnj;&nbsp;".repeat(30)}</div>`
    : "";

  // renderString already escapes {{ }}, so this must NOT be escaped again or an
  // organisation with "&" in its name renders as "&amp;".
  const orgName = renderString("{{org.name}}", ctx);
  const headerAlign = align(l.headerAlign || "left");
  const banded = (l.headerStyle || "band") !== "plain";
  const showHeader = l.showHeader !== false;

  // The band is dark, so it wants the light logo; a plain header sits on the
  // page background and wants the dark one. Either falls back to the other.
  // Absolute only. A root-relative or data: logo renders as a broken box in an
  // inbox, and the monogram below is a far better failure than that.
  const darkLogo = absoluteUrl(renderString(l.logoUrl || "{{org.logo}}", ctx));
  const lightLogo = absoluteUrl(renderString(l.logoUrlOnDark || "{{org.logoLight}}", ctx));
  const logo = l.showLogo === false ? "" : banded ? lightLogo || darkLogo : darkLogo || lightLogo;
  const logoH = px(l.logoHeight, 40);

  const onBand = t.brandTextColor;
  const bandBg = t.brandColor;
  const nameColor = banded ? onBand : t.headingColor;
  // Softened versions of the on-band ink, for the strapline and the divider.
  // You cannot fade a colour with opacity inside a table cell, so blend it.
  const onBandSoft = banded ? mix(bandBg, onBand, 0.68) : t.mutedColor;
  const onBandLine = banded ? mix(bandBg, onBand, 0.26) : t.borderColor;

  // No logo uploaded is the common case for a new tenant, and a blank header
  // looks broken. Their initials in the accent colour is a real mark, and it
  // still carries the brand.
  const initials = String(orgName)
    .replace(/&[a-z]+;/gi, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  const chip = (size, bg, fg, fontSize, al = "left") =>
    initials
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${al}" ` +
        `style="${al === "center" ? "margin:0 auto;" : al === "right" ? "margin-left:auto;" : ""}">` +
        `<tr><td style="width:${size}px;height:${size}px;border-radius:${Math.round(r * (size / 38))}px;` +
        `background-color:${bg};text-align:center;vertical-align:middle;font-family:${t.fontFamily};` +
        `font-size:${fontSize}px;font-weight:700;color:${fg};letter-spacing:.02em;">` +
        `${escapeHtml(initials)}</td></tr></table>`
      : "";

  // An image that 404s or is blocked by the client falls back to its alt text,
  // so that text is styled too -- a broken logo should still read as the brand.
  const logoImg = logo
    ? `<img src="${logo}" alt="${orgName}" height="${logoH}" ` +
      `style="display:block;border:0;outline:none;text-decoration:none;max-height:${logoH}px;width:auto;` +
      `font-family:${t.headingFontFamily};font-size:17px;font-weight:700;color:${nameColor};" />`
    : "";

  const mark =
    logoImg ||
    chip(38, banded ? t.accentColor : t.brandColor, banded ? t.accentTextColor : t.brandTextColor, 15);

  // The name is set in TYPE, always. Images are blocked by default in a lot of
  // clients, and a header that identifies the sender only through an image
  // identifies nothing the moment that image fails to load. Turn it off when
  // the uploaded logo is already a wordmark.
  const showName = l.showBrandName !== false && !!orgName;
  const nameHtml = showName
    ? `<div style="font-family:${t.headingFontFamily};font-size:19px;line-height:1.2;font-weight:700;` +
      `letter-spacing:-.01em;color:${nameColor};">${orgName}</div>`
    : "";

  const tagline = renderString(l.headerTagline || "", ctx);
  const taglineHtml = tagline
    ? `<div style="padding-top:${nameHtml ? "5px" : "0"};font-family:${t.fontFamily};font-size:11px;` +
      `line-height:1.5;font-weight:600;letter-spacing:.1em;text-transform:uppercase;` +
      `color:${onBandSoft};">${tagline}</div>`
    : "";

  const textSide = nameHtml || taglineHtml;
  const dividerCell =
    mark && textSide
      ? `<td width="1" style="width:1px;padding:0 16px;font-size:0;line-height:0;">` +
        `<div style="width:1px;height:${Math.max(28, logoH - 4)}px;background-color:${onBandLine};` +
        `font-size:0;line-height:0;">&nbsp;</div></td>`
      : "";

  const brandTable =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${headerAlign}" ` +
    `style="${headerAlign === "center" ? "margin:0 auto;" : headerAlign === "right" ? "margin-left:auto;" : ""}">` +
    `<tr>` +
    (mark ? `<td valign="middle">${mark}</td>` : "") +
    dividerCell +
    (textSide ? `<td valign="middle" style="text-align:left;">${nameHtml}${taglineHtml}</td>` : "") +
    `</tr></table>`;

  const headerPattern = l.headerPattern === undefined ? "rings" : l.headerPattern;

  let header = "";
  if (showHeader && (mark || textSide)) {
    header = banded
      ? `<tr><td class="ep-head" bgcolor="${bandBg}" style="background-color:${bandBg};` +
        `${patternCss(headerPattern, onBand, 0.16)}` +
        `border-radius:${cardRadius}px ${cardRadius}px 0 0;padding:26px 32px;">${brandTable}</td></tr>` +
        // The band's edge. One flat accent line read as a default; a rule that
        // dissolves reads as drawn.
        `<tr><td style="font-size:0;line-height:0;">${ruleStrip(t.accentColor, bandBg)}</td></tr>`
      : `<tr><td style="padding:0 4px 22px 4px;">${brandTable}</td></tr>`;
  }

  /* -- footer --
   * The footer belongs to the card, not to the page. A detached panel floating
   * under the message reads as a second, unrelated block; joined, the band, the
   * body and the footer are one piece of stationery.
   *
   *   "band"  (default) closes the letter the way the header opened it
   *   "panel"           a pale tint, joined, for a lighter finish
   *   "plain"           the old bare text under the card
   */

  const FOOTER_STYLES = new Set(["band", "panel", "plain"]);
  const footerMode = FOOTER_STYLES.has(l.footerStyle) ? l.footerStyle : "band";
  const attached = footerMode !== "plain";
  const onDark = footerMode === "band";

  const footerPattern = l.footerPattern === undefined ? "rings" : l.footerPattern;
  const footerBg = onDark ? bandBg : mix(t.cardBg, t.brandColor, 0.05);
  // Everything in the footer is coloured against its own background, so the
  // same markup works whether it is a brand band or a pale tint.
  const footerInk = onDark ? mix(footerBg, onBand, 0.72) : t.mutedColor;
  const footerHead = onDark ? onBand : t.headingColor;
  const footerLine = onDark ? mix(footerBg, onBand, 0.22) : mix(t.borderColor, t.brandColor, 0.18);
  const footerAlign = align(l.footerAlign || "center");

  const footerText = renderString(l.footerText || "", ctx);
  const legalText = renderString(l.legalText || "", ctx);

  // The first link that resolves becomes the footer's action -- filled, so the
  // row reads as one thing to do plus two places to go, rather than three equal
  // grey capsules. `primary: false` on a link opts it out.
  let claimedPrimary = false;
  const footerLinks = (Array.isArray(l.footerLinks) ? l.footerLinks : [])
    .map((link) => {
      const url = safeUrl(renderString(link.url || "", ctx));
      const label = renderString(link.label || "", ctx);
      // A link whose URL didn't resolve is dropped rather than rendered dead.
      if (!url || !label) return "";
      if (!attached) {
        return (
          `<a class="ep-link" href="${url}" ` +
          `style="color:${t.accentColor};text-decoration:none;font-weight:600;">${label}</a>`
        );
      }
      const primary = link.primary !== false && !claimedPrimary;
      if (primary) claimedPrimary = true;
      const bg = primary ? t.accentColor : onDark ? mix(footerBg, onBand, 0.1) : t.cardBg;
      const fg = primary ? t.accentTextColor : onDark ? onBand : t.headingColor;
      const edge = primary ? t.accentColor : footerLine;
      return (
        `<a class="${primary ? "ep-pill-primary" : "ep-pill"}" href="${url}" ` +
        `style="display:inline-block;margin:0 3px 8px 3px;padding:11px 18px;` +
        `border:1px solid ${edge};border-radius:999px;background-color:${bg};` +
        `font-family:${t.fontFamily};font-size:12.5px;font-weight:600;line-height:1;` +
        `color:${fg};text-decoration:none;">${label}</a>`
      );
    })
    .filter(Boolean)
    .join(attached ? "" : ` <span style="color:${t.borderColor};">&nbsp;&#183;&nbsp;</span> `);

  const poweredBy =
    l.showPlatformCredit && l.platformCreditText
      ? `<div style="padding-top:10px;font-size:11px;color:${footerInk};">${renderString(l.platformCreditText, ctx)}</div>`
      : "";

  const hairline =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">` +
    `<tr><td style="height:18px;font-size:0;line-height:0;">&nbsp;</td></tr>` +
    `<tr><td style="height:1px;background-color:${footerLine};font-size:0;line-height:0;">&nbsp;</td></tr>` +
    `<tr><td style="height:14px;font-size:0;line-height:0;">&nbsp;</td></tr></table>`;

  const linkInk = onDark ? onBand : t.accentColor;
  const smallPrint = [
    legalText ? `<div style="font-size:11px;opacity:.9;">${autoLink(legalText, linkInk)}</div>` : "",
    poweredBy,
  ]
    .filter(Boolean)
    .join("");

  // No logo down here -- the header carries it, and a second copy above the
  // name was repetition rather than a letterhead.
  //
  // When the watermark behind the band IS the mark, it already says who sent
  // this, and setting the name in type as well is the same stutter. A generic
  // texture says nothing, so there the name still has to sign off.
  const signedByMark = attached && footerPattern === "mark";
  const footerName =
    orgName && !signedByMark
      ? `<div style="font-family:${t.headingFontFamily};font-size:18px;font-weight:700;` +
        `letter-spacing:-.01em;color:${footerHead};">${orgName}</div>`
      : "";

  // The mark is doing the signing now, so it is drawn as a centred seal at
  // roughly twice the header's strength -- at watermark opacity, off the edge
  // and half-cropped, it read as nothing at all.
  const footerPatternCss = !attached
    ? ""
    : signedByMark
      ? patternCss(footerPattern, onDark ? onBand : t.brandColor, onDark ? 0.28 : 0.22, {
          place: "background-repeat:no-repeat;background-position:50% 44%;",
          size: 190,
        })
      : patternCss(footerPattern, onDark ? onBand : t.brandColor, onDark ? 0.16 : 0.14);

  // Attached: mark, then what you can do, then a rule, then the small print.
  // Contact details are reference material and belong under the line, not
  // between the mark and the actions.
  const footerRows = attached
    ? [
        footerName,
        footerLinks ? `<div style="padding:${footerName ? "18px" : "2px"} 0 0 0;">${footerLinks}</div>` : "",
        // The rule only earns its place when it divides two things. With no
        // name and no links above it, it was a line drawn under nothing.
        (footerName || footerLinks) && (footerText || smallPrint) ? hairline : "",
        footerText ? `<div style="padding-bottom:6px;">${autoLink(footerText, linkInk)}</div>` : "",
        smallPrint,
      ].filter(Boolean)
    : [
        orgName
          ? `<div style="font-family:${t.headingFontFamily};font-size:17px;font-weight:700;` +
            `letter-spacing:-.01em;color:${footerHead};padding-bottom:5px;">${orgName}</div>`
          : "",
        footerText ? `<div style="padding-bottom:2px;">${autoLink(footerText, t.accentColor)}</div>` : "",
        footerLinks ? `<div style="padding:12px 0 4px 0;font-size:13px;">${footerLinks}</div>` : "",
        smallPrint ? `<div style="padding-top:8px;">${smallPrint}</div>` : "",
      ].filter(Boolean);

  // Joined = the card gives up its bottom corners and its bottom border, and
  // the footer carries both instead.
  const joined = attached && footerRows.length > 0;

  const bandedHeader = !!header && banded;
  const topR = bandedHeader ? 0 : cardRadius;
  const botR = joined ? 0 : cardRadius;
  const cardStyle =
    `background:${t.cardBg};padding:38px 40px;border:1px solid ${t.borderColor};` +
    (bandedHeader ? "border-top:0;" : "") +
    (joined ? "border-bottom:0;" : "") +
    `border-radius:${topR}px ${topR}px ${botR}px ${botR}px;`;

  const footerEdge = joined
    ? `border:1px solid ${onDark ? footerBg : t.borderColor};` +
      (onDark ? "border-top:0;" : "") +
      `border-radius:0 0 ${cardRadius}px ${cardRadius}px;`
    : `border:1px solid ${onDark ? footerBg : t.borderColor};border-radius:${cardRadius}px;`;

  const footer = footerRows.length
    ? // The closing rule: the header's ramp turned around, dark running back up
      // to the accent, so the message sits inside a frame instead of under a
      // lid. A detached footer gets air instead -- there is no band to edge.
      (joined
        ? `<tr><td style="font-size:0;line-height:0;">${ruleStrip(t.accentColor, footerBg, 4, true)}</td></tr>`
        : `<tr><td style="height:${attached ? 22 : 8}px;font-size:0;line-height:0;">&nbsp;</td></tr>`) +
      `<tr><td class="ep-foot" ${attached ? `bgcolor="${footerBg}" ` : ""}style="` +
      (attached
        ? `background-color:${footerBg};` +
          footerPatternCss +
          footerEdge +
          `padding:28px 30px;`
        : `padding:18px 12px 0 12px;`) +
      `font-family:${t.fontFamily};font-size:12.5px;line-height:1.65;color:${footerInk};` +
      `text-align:${footerAlign};">` +
      footerRows.join("") +
      `</td></tr>`
    : "";

  return (
    `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">` +
    `<html xmlns="http://www.w3.org/1999/xhtml"><head>` +
    `<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
    `<meta name="x-apple-disable-message-reformatting" />` +
    // Without these, Apple Mail and Outlook.com invert the brand band's colours
    // in dark mode and the logo lands on a background it wasn't drawn for.
    `<meta name="color-scheme" content="light only" />` +
    `<meta name="supported-color-schemes" content="light only" />` +
    `<title>${escapeHtml(renderString(l.documentTitle || "{{org.name}}", ctx))}</title>` +
    // Gmail strips <style>, so this is progressive enhancement only -- the
    // inline styles above already carry the whole design.
    `<style type="text/css">` +
    `@media only screen and (max-width:620px){` +
    `.ep-card{padding:26px 22px !important}` +
    `.ep-h1{font-size:26px !important}` +
    `.ep-figure{font-size:32px !important}` +
    `.ep-head{padding:20px 20px !important}` +
    `.ep-foot{padding:24px 18px !important}` +
    `.ep-wrap{width:100% !important}` +
    `.ep-shell{padding:20px 10px !important}` +
    `}` +
    `a{color:${t.accentColor}}` +
    `.ep-btn{transition:opacity .15s ease,box-shadow .15s ease}` +
    `.ep-btn:hover{opacity:.9;box-shadow:0 8px 20px rgba(17,24,39,.18)}` +
    `.ep-pill{transition:background-color .15s ease,color .15s ease,border-color .15s ease}` +
    `.ep-pill:hover{background-color:${t.accentColor} !important;border-color:${t.accentColor} !important;` +
    `color:${t.accentTextColor} !important}` +
    `.ep-pill-primary{transition:opacity .15s ease}.ep-pill-primary:hover{opacity:.88}` +
    `.ep-link:hover{text-decoration:underline !important}` +
    `body,table,td{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}` +
    `img{-ms-interpolation-mode:bicubic}` +
    `</style></head>` +
    `<body style="margin:0;padding:0;background:${t.pageBg};-webkit-font-smoothing:antialiased;">` +
    preheaderHtml +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${t.pageBg};">` +
    `<tr><td class="ep-shell" align="center" style="padding:36px 12px;">` +
    `<table role="presentation" class="ep-wrap" width="${width}" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:${width}px;max-width:100%;">` +
    header +
    `<tr><td class="ep-card" style="${cardStyle}">` +
    bodyHtml +
    `</td></tr>` +
    footer +
    `<tr><td style="height:28px;font-size:0;line-height:0;">&nbsp;</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

/* -- plain-text part ------------------------------------------------------ */

/**
 * A readable text/plain alternative. Spam filters penalise HTML-only mail, and
 * the auto-strip this replaces produced a wall of run-together words.
 */
function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // Keep the destination of a link, which is the whole point of the text part.
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
      const text = label.replace(/<[^>]*>/g, "").trim();
      return text && !href.includes(text) ? `${text} (${href})` : href;
    })
    // Cells first, then rows -- otherwise "Donation ID" and "D-12" run together.
    .replace(/<\/(td|th)>/gi, "  ")
    .replace(/<\/(p|div|tr|h1|h2|h3|li|table)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "  - ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;|&#\d+;/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

module.exports = {
  DEFAULT_THEME,
  DEFAULT_LAYOUT,
  TONE_COLORS,
  resolveTheme,
  blocksToHtml,
  wrapInLayout,
  htmlToText,
  BLOCK_TYPES: Object.keys(COMPILERS),
  PATTERN_NAMES,
};
