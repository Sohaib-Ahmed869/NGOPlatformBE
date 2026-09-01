/**
 * The email-template system's pure layers: the template language, the block
 * compiler, the layout wrapper, and the catalog itself.
 *
 * No DB and no network — everything here is deterministic, so it runs in CI as
 * a gate. The database-backed layering (tenant -> platform -> catalog) is
 * exercised by `npm run verify:emails` and the live scripts; what matters here
 * is that a template can never render into something dangerous or broken.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { renderString, collectTokens, escapeHtml, safeUrl } = require("../services/emailRender");
const { blocksToHtml, wrapInLayout, htmlToText, DEFAULT_LAYOUT } = require("../services/emailBlocks");
const catalog = require("../config/emailCatalog");

/* ── the template language ───────────────────────────────────────────────── */

test("interpolates dotted paths and leaves unknown ones empty", () => {
  const ctx = { donor: { firstName: "Sarah" } };
  assert.equal(renderString("Hi {{donor.firstName}}", ctx), "Hi Sarah");
  assert.equal(renderString("Hi {{donor.nope}}", ctx), "Hi ");
  assert.equal(renderString("Hi {{a.b.c.d}}", ctx), "Hi ");
});

test("escapes interpolated values by default", () => {
  const ctx = { name: '<script>alert("x")</script>' };
  const out = renderString("{{name}}", ctx);
  assert.ok(!out.includes("<script>"), "must not emit a raw script tag");
  assert.ok(out.includes("&lt;script&gt;"));
});

test("triple braces pass trusted operator HTML through unescaped", () => {
  assert.equal(renderString("{{{body}}}", { body: "<b>bold</b>" }), "<b>bold</b>");
});

test("filters format values, and chain", () => {
  assert.equal(renderString("{{n | money}}", { n: 1234.5 }), "$1,234.50");
  assert.equal(renderString("{{n | money:GBP}}", { n: 10 }), "£10.00");
  // An unquoted filter argument resolves as a variable path first.
  assert.equal(renderString("{{n | money:cur}}", { n: 10, cur: "EUR" }), "€10.00");
  // A quoted one is always the literal.
  assert.equal(renderString('{{missing | default:"there"}}', {}), "there");
  assert.equal(renderString('{{name | default:"x" | upper}}', { name: "ada" }), "ADA");
});

test("{{#if}} treats zero and empty arrays as absent", () => {
  const t = "{{#if v}}yes{{else}}no{{/if}}";
  assert.equal(renderString(t, { v: 1 }), "yes");
  assert.equal(renderString(t, { v: 0 }), "no", "a $0 amount should hide its row");
  assert.equal(renderString(t, { v: [] }), "no");
  assert.equal(renderString(t, { v: "" }), "no");
  assert.equal(renderString("{{#unless v}}none{{/unless}}", { v: "" }), "none");
});

test("{{#each}} exposes loop scope and still reaches the outer context", () => {
  const ctx = { org: { name: "Hope" }, items: [{ label: "A" }, { label: "B" }] };
  assert.equal(
    renderString("{{#each items}}{{@number}}:{{this.label}}@{{org.name}} {{/each}}", ctx),
    "1:A@Hope 2:B@Hope ",
  );
  assert.equal(renderString("{{#each items}}x{{else}}empty{{/each}}", { items: [] }), "empty");
});

test("a malformed template degrades instead of throwing", () => {
  assert.doesNotThrow(() => renderString("{{#if a}}unclosed", {}));
  assert.doesNotThrow(() => renderString("{{", {}));
  assert.equal(renderString("no tokens here", {}), "no tokens here");
});

test("collectTokens finds every referenced variable", () => {
  assert.deepEqual(collectTokens("{{a.b}} {{#if c}}{{d | upper}}{{/if}}").sort(), ["a.b", "c", "d"]);
});

/* ── URL safety ──────────────────────────────────────────────────────────── */

test("rejects dangerous URLs in buttons and images", () => {
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("data:text/html,<script>"), "");
  assert.equal(safeUrl("https://ok.example"), "https://ok.example");
  assert.equal(safeUrl("mailto:a@b.c"), "mailto:a@b.c");
});

test("a button with an unsafe URL renders nothing at all", () => {
  const html = blocksToHtml(
    [{ id: "b1", type: "button", label: "Click", url: "javascript:alert(1)" }],
    {},
    {},
  );
  assert.ok(!html.includes("javascript:"));
  assert.ok(!html.includes("Click"), "no link means no button, not a dead one");
});

test("escapeHtml covers quotes as well as angle brackets", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

/* ── block compiler ──────────────────────────────────────────────────────── */

const ctx = {
  org: { name: "Hope Trust" },
  donor: { firstName: "Sarah" },
  amount: 50,
  guests: 0,
  items: [
    { label: "Water", amt: 30 },
    { label: "Food", amt: 20 },
  ],
};

test("compiles blocks to table-based HTML with no flexbox", () => {
  const html = blocksToHtml(
    [
      { id: "1", type: "heading", text: "Hi {{donor.firstName}}" },
      { id: "2", type: "paragraph", text: "You gave {{amount | money}}." },
    ],
    ctx,
    {},
  );
  assert.ok(html.includes("Hi Sarah"));
  assert.ok(html.includes("$50.00"));
  assert.ok(html.includes("<table"), "email layout must be table-based");
  assert.ok(!/display:\s*flex/i.test(html), "flexbox does not exist in Outlook");
});

test("showIf hides a block, and a leading ! inverts it", () => {
  const blocks = [
    { id: "1", type: "paragraph", text: "SHOWN", showIf: "amount" },
    { id: "2", type: "paragraph", text: "HIDDEN", showIf: "guests" },
    { id: "3", type: "paragraph", text: "INVERTED", showIf: "!guests" },
  ];
  const html = blocksToHtml(blocks, ctx, {});
  assert.ok(html.includes("SHOWN"));
  assert.ok(!html.includes("HIDDEN"));
  assert.ok(html.includes("INVERTED"));
});

test("a hidden block is never rendered", () => {
  const html = blocksToHtml([{ id: "1", type: "paragraph", text: "NOPE", hidden: true }], ctx, {});
  assert.ok(!html.includes("NOPE"));
});

test("the table block repeats over a list variable and totals it", () => {
  const html = blocksToHtml(
    [
      {
        id: "1",
        type: "table",
        source: "items",
        columns: [
          { label: "Item", value: "{{this.label}}" },
          { label: "Amount", value: "{{this.amt | money}}", align: "right" },
        ],
        showTotal: true,
        totalLabel: "Total",
        totalValue: "{{amount | money}}",
      },
    ],
    ctx,
    {},
  );
  assert.ok(html.includes("Water") && html.includes("$30.00"));
  assert.ok(html.includes("Food") && html.includes("$20.00"));
  assert.ok(html.includes("Total") && html.includes("$50.00"));
});

test("an unknown block type is skipped rather than throwing", () => {
  assert.doesNotThrow(() => blocksToHtml([{ id: "1", type: "from_the_future" }], ctx, {}));
});

/* ── layout + text part ──────────────────────────────────────────────────── */

test("wraps content in a complete, themed HTML document", () => {
  const html = wrapInLayout("<p>Body</p>", { ...DEFAULT_LAYOUT, footerText: "{{org.name}}" }, ctx);
  assert.ok(html.startsWith("<!DOCTYPE"));
  assert.ok(html.includes("<p>Body</p>"));
  assert.ok(html.includes("Hope Trust"), "the footer's variables must render");
});

test("the preheader is hidden but present", () => {
  const html = wrapInLayout("<p>x</p>", { ...DEFAULT_LAYOUT, preheader: "Peek at me" }, ctx);
  assert.ok(html.includes("Peek at me"));
  assert.ok(/display:\s*none/.test(html));
});

test("the plain-text part keeps link targets and separates cells", () => {
  const html = blocksToHtml(
    [
      { id: "1", type: "panel", rows: [{ label: "Reference", value: "DN-1" }] },
      { id: "2", type: "button", label: "View", url: "https://x.io/r" },
    ],
    ctx,
    {},
  );
  const text = htmlToText(html);
  assert.ok(text.includes("https://x.io/r"), "a text part without URLs is useless");
  assert.ok(!/ReferenceDN-1/.test(text), "table cells must not run together");
});

/* ── the catalog itself ──────────────────────────────────────────────────── */

test("every catalog template renders against its own sample data", () => {
  for (const entry of catalog.TEMPLATES) {
    const defaults = catalog.defaultsFor(entry.key);
    const sample = catalog.sampleContext(entry.key);

    const subject = renderString(defaults.subject, sample);
    const html = wrapInLayout(blocksToHtml(defaults.blocks, sample, {}), DEFAULT_LAYOUT, sample);

    assert.ok(subject.trim(), `${entry.key} renders an empty subject`);
    assert.ok(htmlToText(html).trim(), `${entry.key} renders an empty body`);

    // The <style> block legitimately ends in "}}" (a CSS media query).
    const scanned = html.replace(/<style[\s\S]*?<\/style>/g, "");
    assert.equal(
      `${subject}${scanned}`.match(/\{\{[^}]*\}\}/g),
      null,
      `${entry.key} left tokens unrendered`,
    );
  }
});

test("every catalog entry is well-formed", () => {
  const groups = new Set(catalog.GROUPS.map((g) => g.key));
  const seen = new Set();
  for (const t of catalog.TEMPLATES) {
    assert.ok(!seen.has(t.key), `duplicate key ${t.key}`);
    seen.add(t.key);
    assert.ok(groups.has(t.group), `${t.key} has an unknown group`);
    assert.ok(["tenant", "platform"].includes(t.scope), `${t.key} has an unknown scope`);
    assert.ok(t.label && t.description, `${t.key} is missing a label or description`);
    assert.ok(catalog.defaultsFor(t.key).blocks.length, `${t.key} has no default blocks`);
  }
});

test("blocks are given stable ids for the builder", () => {
  const blocks = catalog.defaultsFor("donation.receipt").blocks;
  assert.ok(blocks.every((b) => typeof b.id === "string" && b.id));
  assert.equal(new Set(blocks.map((b) => b.id)).size, blocks.length, "ids must be unique");
});

test("required templates are the ones with a legal or security obligation", () => {
  const required = catalog.TEMPLATES.filter((t) => t.required).map((t) => t.key);
  for (const key of ["donation.receipt", "account.passwordReset", "account.passwordResetSuccess"]) {
    assert.ok(required.includes(key), `${key} must not be switch-off-able`);
  }
});

test("a template only uses variables it declares", () => {
  for (const entry of catalog.TEMPLATES) {
    const declared = new Set(catalog.variablesFor(entry.key).map((v) => v.key));
    declared.add("currency");
    const defaults = catalog.defaultsFor(entry.key);

    const used = new Set();
    const walk = (val) => {
      if (typeof val === "string") collectTokens(val).forEach((t) => used.add(t));
      else if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val === "object") Object.values(val).forEach(walk);
    };
    walk([defaults.subject, defaults.preheader, defaults.blocks]);

    for (const token of used) {
      if (declared.has(token) || token.startsWith("this.")) continue;
      const related = [...declared].some((d) => d.startsWith(`${token}.`) || token.startsWith(`${d}.`));
      assert.ok(related, `${entry.key} uses undeclared {{${token}}}`);
    }
  }
});

/* ── branding ─────────────────────────────────────────────────────────────
   The organisation's own logo and colours seed the theme, so a tenant that has
   filled in the Branding screen gets branded email without touching the layout
   editor. Everything here guards that path, and the contrast rule that keeps it
   legible when a brand colour is pale. */

const BRAND = { primaryColor: "#2C2418", accentColor: "#C9A84C", backgroundColor: "#FAF7F2" };

test("the organisation's brand colours reach the theme", () => {
  const t = require("../services/emailBlocks").resolveTheme({}, BRAND);
  assert.equal(t.brandColor, "#2C2418", "the header band is the primary colour");
  assert.equal(t.accentColor, "#C9A84C", "buttons are the accent colour");
  assert.equal(t.headingColor, "#2C2418");
});

test("text on a brand colour is chosen for contrast, not assumed white", () => {
  const { resolveTheme } = require("../services/emailBlocks");
  assert.equal(resolveTheme({}, { primaryColor: "#102A23" }).brandTextColor, "#ffffff");
  // A pale brand must flip to dark ink or the header is unreadable.
  assert.equal(resolveTheme({}, { primaryColor: "#FDE68A" }).brandTextColor, "#1f2937");
  assert.equal(resolveTheme({}, { accentColor: "#FEF3C7" }).accentTextColor, "#1f2937");
});

test("an explicit layout override still beats the brand", () => {
  const t = require("../services/emailBlocks").resolveTheme({ accentColor: "#ff0000" }, BRAND);
  assert.equal(t.accentColor, "#ff0000");
  assert.equal(t.accentTextColor, "#ffffff", "and its text colour is recomputed for it");
});

test("the page behind the card is ash, not a field of brand colour", () => {
  const { resolveTheme } = require("../services/emailBlocks");
  // A saturated mint background must not become 600px of mint around the card.
  const t = resolveTheme({}, { primaryColor: "#010101", backgroundColor: "#DCF0E7" });
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(t.pageBg.slice(i, i + 2), 16));
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 6, `${t.pageBg} still reads as a colour`);
  assert.ok(Math.min(r, g, b) > 200, "and it stays light");
  // An operator who genuinely wants the tint can still ask for it.
  assert.equal(resolveTheme({ pageBg: "#DCF0E7" }, { backgroundColor: "#DCF0E7" }).pageBg, "#DCF0E7");
});

test("a logo that can't resolve in an inbox falls back to the monogram", () => {
  for (const dead of ["/uploads/logo.png", "logo.png", "data:image/png;base64,iVBOR"]) {
    const org = { ...ctx, org: { ...ctx.org, logo: dead, logoLight: dead } };
    const html = wrapInLayout("<p>x</p>", DEFAULT_LAYOUT, org, BRAND);
    assert.ok(!html.includes("<img"), `${dead} must not become a broken <img>`);
    assert.ok(html.includes(">HT<"), "the monogram stands in instead");
  }
  // An absolute one is still used.
  const good = { ...ctx, org: { ...ctx.org, logoLight: "https://cdn.example/l.png" } };
  assert.ok(wrapInLayout("<p>x</p>", DEFAULT_LAYOUT, good, BRAND).includes("cdn.example/l.png"));
});

test("the branded header band carries the logo and the brand colour", () => {
  const branded = { ...ctx, org: { ...ctx.org, logoLight: "https://cdn.example/logo-light.png" } };
  const html = wrapInLayout("<p>Body</p>", DEFAULT_LAYOUT, branded, BRAND);
  assert.ok(html.includes("#2C2418"), "the band paints in the primary colour");
  assert.ok(html.includes("logo-light.png"), "the band takes the LIGHT logo variant");
  assert.ok(!/javascript:/i.test(html));
});

test("no logo falls back to a monogram rather than an empty header", () => {
  const html = wrapInLayout("<p>Body</p>", DEFAULT_LAYOUT, ctx, BRAND);
  assert.ok(html.includes(">HT<"), "initials of Hope Trust");
  assert.ok(html.includes("Hope Trust"), "and the name beside them");
});

test("footer links render only when their URL resolves", () => {
  const withLinks = {
    ...ctx,
    org: { ...ctx.org, donateUrl: "https://hope.example/donate", contactUrl: "", dashboardUrl: "" },
  };
  const html = wrapInLayout("<p>x</p>", DEFAULT_LAYOUT, withLinks, BRAND);
  assert.ok(html.includes("https://hope.example/donate"));
  assert.ok(html.includes("Donate"));
  assert.ok(!html.includes(">Contact us<"), "a link with no URL is dropped, not rendered dead");
});

/* ── header & footer furniture ────────────────────────────────────────────
   The band used to be a flat slab carrying nothing but an <img>, so a blocked
   or 404ing logo left an email that identified nobody. */

test("the header sets the name in type, not only in the logo image", () => {
  const branded = { ...ctx, org: { ...ctx.org, logoLight: "https://cdn.example/logo-light.png" } };
  const html = wrapInLayout("<p>Body</p>", DEFAULT_LAYOUT, branded, BRAND);
  const head = html.slice(0, html.indexOf('class="ep-card"'));
  assert.ok(head.includes("logo-light.png"), "the logo is still there");
  assert.ok(head.includes(">Hope Trust</div>"), "and the name is set in type beside it");
  assert.ok(/alt="Hope Trust"/.test(head), "a blocked image falls back to the name");
});

test("showBrandName turns the wordmark off for logos that already carry it", () => {
  const branded = { ...ctx, org: { ...ctx.org, logoLight: "https://cdn.example/logo-light.png" } };
  const html = wrapInLayout("<p>Body</p>", { ...DEFAULT_LAYOUT, showBrandName: false }, branded, BRAND);
  const head = html.slice(0, html.indexOf('class="ep-card"'));
  assert.ok(head.includes("logo-light.png"));
  assert.ok(!head.includes(">Hope Trust</div>"));
});

test("the band and the footer carry a tiling pattern over a solid colour", () => {
  const html = wrapInLayout("<p>Body</p>", DEFAULT_LAYOUT, ctx, BRAND);
  const patterns = html.match(/background-image:url\(data:image\/svg\+xml,/g) || [];
  assert.equal(patterns.length, 2, "one on the header band, one on the footer panel");
  assert.ok(html.includes(`bgcolor="${BRAND.primaryColor}"`), "with the flat colour underneath it");
  // Unquoted url() in a style attribute: a stray paren or quote breaks the rule.
  const urls = html.match(/url\(data:image\/svg\+xml,[^)]*\)/g) || [];
  assert.equal(urls.length, 2);
  for (const u of urls) assert.ok(!/["'<>]/.test(u), "the data URI must be fully escaped");
});

test("pattern none leaves the band flat", () => {
  const html = wrapInLayout(
    "<p>Body</p>",
    { ...DEFAULT_LAYOUT, headerPattern: "none", footerPattern: "none" },
    ctx,
    BRAND,
  );
  assert.ok(!html.includes("svg+xml"));
  assert.ok(html.includes(`bgcolor="${BRAND.primaryColor}"`), "the colour is untouched");
});

test("an attached footer renders its links as pills, a plain one as text", () => {
  const withLinks = {
    ...ctx,
    org: {
      ...ctx.org,
      donateUrl: "https://hope.example/donate",
      contactUrl: "https://hope.example/contact",
    },
  };
  const band = wrapInLayout("<p>x</p>", DEFAULT_LAYOUT, withLinks, BRAND);
  // The first resolving link is the action; the rest are outlines.
  assert.equal((band.match(/class="ep-pill-primary"/g) || []).length, 1);
  assert.ok(band.includes('class="ep-pill"'), "and the others are not");
  assert.ok(band.indexOf("hope.example/donate") < band.indexOf("hope.example/contact"), "in order");

  const plain = wrapInLayout("<p>x</p>", { ...DEFAULT_LAYOUT, footerStyle: "plain" }, withLinks, BRAND);
  assert.ok(!plain.includes('class="ep-pill'), "no pills when the footer is detached");
  assert.ok(plain.includes("https://hope.example/donate"), "the link survives either way");
});

test("the footer never repeats the logo as an image", () => {
  const branded = { ...ctx, org: { ...ctx.org, logoLight: "https://cdn.example/wordmark.png" } };
  const html = wrapInLayout("<p>x</p>", DEFAULT_LAYOUT, branded, BRAND);
  const head = html.slice(0, html.indexOf('class="ep-card"'));
  const foot = html.slice(html.indexOf('class="ep-foot"'));
  assert.ok(head.includes("wordmark.png"), "the header opens with the mark");
  assert.ok(!foot.includes("<img"), "the footer does not repeat it");
  assert.ok(!/>HT</.test(foot), "and no monogram stands in for it either");
});

test("the mark watermark signs the footer, and only then does the name come out", () => {
  // A generic texture identifies nobody, so the name has to be set in type.
  const textured = wrapInLayout("<p>x</p>", DEFAULT_LAYOUT, ctx, BRAND);
  const rings = textured.slice(textured.indexOf('class="ep-foot"'));
  assert.ok(rings.includes(">Hope Trust</div>"), "the name signs off under a texture");

  // Behind the mark it is already said, and saying it twice is the stutter we
  // took out of the header.
  const sealed = wrapInLayout("<p>x</p>", { ...DEFAULT_LAYOUT, footerPattern: "mark" }, ctx, BRAND);
  const foot = sealed.slice(sealed.indexOf('class="ep-foot"'));
  assert.ok(!foot.includes(">Hope Trust</div>"), "the mark says it instead");
  assert.ok(foot.includes("background-position:50% 44%"), "centred, not cropped off the edge");
  assert.ok(foot.includes("width%3D%22190%22"), "and drawn to fit the band");
  assert.ok(foot.includes("You're receiving this"), "the rest of the footer survives");
  assert.ok(!foot.includes("height:1px"), "and no rule is drawn under nothing");

  // A detached footer has no band to seal, so the name stays either way.
  const plain = wrapInLayout(
    "<p>x</p>",
    { ...DEFAULT_LAYOUT, footerStyle: "plain", footerPattern: "mark" },
    ctx,
    BRAND,
  );
  assert.ok(plain.slice(plain.indexOf('class="ep-foot"')).includes(">Hope Trust</div>"));
});

test("bare emails and domains in the footer are linked in a colour we control", () => {
  const withContact = { ...ctx, org: { ...ctx.org, footer: "hopetrust.org | hello@hopetrust.org" } };
  const html = wrapInLayout("<p>x</p>", DEFAULT_LAYOUT, withContact, BRAND);
  const foot = html.slice(html.indexOf('class="ep-foot"'));
  assert.ok(foot.includes('href="mailto:hello@hopetrust.org"'), "the address is ours, not the client's");
  assert.ok(foot.includes('href="https://hopetrust.org"'));
  // Every link it emits carries an explicit colour, or the client picks blue.
  for (const a of foot.match(/<a [^>]*>/g) || []) assert.ok(/color:#/.test(a), a);
  // And it must not double-wrap an anchor the layout itself wrote. (Interpolated
  // values are escaped by renderString, so only literal template markup is a
  // real tag by the time this runs -- which is exactly the operator-typed case.)
  const authored = {
    ...DEFAULT_LAYOUT,
    footerText: '<a href="https://x.example" style="color:#fff">hello@x.example</a>',
  };
  const twice = wrapInLayout("<p>x</p>", authored, ctx, BRAND);
  assert.ok(!twice.includes("mailto:hello@x.example"), "their link is left alone");
});

test("the footer is joined to the card, not floating under it", () => {
  const html = wrapInLayout("<p>x</p>", DEFAULT_LAYOUT, ctx, BRAND);
  const card = html.slice(html.indexOf('class="ep-card"'), html.indexOf('class="ep-foot"'));
  assert.ok(card.includes("border-bottom:0"), "the card gives up its bottom border");
  assert.ok(/border-radius:0px 0px 0px 0px/.test(card), "and its bottom corners");
  const foot = html.slice(html.indexOf('class="ep-foot"'));
  assert.ok(/border-radius:0 0 \d+px \d+px/.test(foot), "the footer carries them instead");
  assert.ok(!/height:22px/.test(card), "and there is no gap between them");

  // Detached is still available, and then the card keeps its own corners.
  const loose = wrapInLayout("<p>x</p>", { ...DEFAULT_LAYOUT, footerStyle: "plain" }, ctx, BRAND);
  const looseCard = loose.slice(loose.indexOf('class="ep-card"'), loose.indexOf('class="ep-foot"'));
  assert.ok(!looseCard.includes("border-bottom:0"));
});

test("two even ramps frame the letter, the closing one mirrored", () => {
  const html = wrapInLayout("<p>x</p>", DEFAULT_LAYOUT, ctx, BRAND);
  const head = html.slice(0, html.indexOf('class="ep-card"'));
  const between = html.slice(html.indexOf('class="ep-card"'), html.indexOf('class="ep-foot"'));

  // Twenty equal steps each. Uneven ones alternating with the band colour read
  // as a row of broken blocks rather than as a fade.
  const ramp = (part) =>
    (part.match(/width="5%"[^>]*?background-color:(#[0-9a-f]{6})/gi) || []).map((m) => m.slice(-7));
  const opens = ramp(head);
  const closes = ramp(between);
  assert.equal(opens.length, 20, "one under the header");
  assert.equal(closes.length, 20, "one closing above the footer");
  assert.ok(!/width="44%"/.test(html), "no wide-then-dashed strip anywhere");

  // The closing rule is the opening one turned through 180 degrees: the header
  // leads on the accent, the footer arrives back at it.
  assert.deepEqual(closes, [...opens].reverse());
  assert.equal(opens[0].toLowerCase(), BRAND.accentColor.toLowerCase(), "and it starts at full accent");

  const foot = html.slice(html.indexOf('class="ep-foot"'));
  assert.ok(foot.startsWith(`class="ep-foot" bgcolor="${BRAND.primaryColor}"`), "the band is the brand");
  const panel = wrapInLayout("<p>x</p>", { ...DEFAULT_LAYOUT, footerStyle: "panel" }, ctx, BRAND);
  const tint = panel.slice(panel.indexOf('class="ep-foot"'));
  assert.ok(!tint.startsWith(`class="ep-foot" bgcolor="${BRAND.primaryColor}"`), "the tint is not");
});

test("platform-scope mail swaps in its own footer links and watermark", () => {
  const { PLATFORM_FOOTER_LINKS, platformDefaults } = require("../services/emailTemplates");
  const swapped = platformDefaults({ scope: "platform" }, DEFAULT_LAYOUT);
  assert.deepEqual(swapped.footerLinks, PLATFORM_FOOTER_LINKS);
  const custom = { ...DEFAULT_LAYOUT, footerLinks: [{ label: "Mine", url: "https://x.example" }] };
  assert.deepEqual(platformDefaults({ scope: "platform" }, custom).footerLinks, custom.footerLinks);
  assert.deepEqual(platformDefaults({ scope: "tenant" }, DEFAULT_LAYOUT).footerLinks, DEFAULT_LAYOUT.footerLinks);
  // The watermark is the platform's logo, so a charity never gets it by default.
  assert.equal(swapped.headerPattern, "mark");
  assert.equal(swapped.footerPattern, "mark", "and it is what signs the footer off");
  assert.equal(platformDefaults({ scope: "tenant" }, DEFAULT_LAYOUT).headerPattern, DEFAULT_LAYOUT.headerPattern);
  const picked = { ...DEFAULT_LAYOUT, headerPattern: "dots" };
  assert.equal(platformDefaults({ scope: "platform" }, picked).headerPattern, "dots", "an explicit choice wins");
});

test("every link the layout emits is absolute", () => {
  const full = {
    ...ctx,
    org: {
      ...ctx.org,
      donateUrl: "https://hope.example/donate",
      dashboardUrl: "https://hope.example/user/dashboard",
      contactUrl: "https://hope.example/contact-us",
    },
  };
  const html = wrapInLayout("<p>x</p>", DEFAULT_LAYOUT, full, BRAND);
  for (const href of html.match(/href="([^"]+)"/g) || []) {
    const url = href.slice(6, -1);
    assert.ok(
      /^(https?:|mailto:|tel:)/i.test(url),
      `a relative href is dead in an email: ${url}`,
    );
  }
});

/* ── manual send: attachments ────────────────────────────────────────────── */

const { toMailAttachments, MAX_TOTAL_BYTES } = require("../middleware/emailAttachments");

const upload = (name, size, mimetype = "application/octet-stream") => ({
  originalname: name,
  size,
  mimetype,
  buffer: Buffer.alloc(Math.min(size, 8)),
});

test("attachments: nothing attached is not an error", () => {
  assert.deepEqual(toMailAttachments(undefined), { attachments: [], summary: [] });
  assert.deepEqual(toMailAttachments([]), { attachments: [], summary: [] });
});

test("attachments: the declared type comes from the extension, not the browser", () => {
  // A PDF the client labelled as a generic blob would otherwise arrive in the
  // recipient's inbox as an unopenable, nameless attachment.
  const { attachments } = toMailAttachments([upload("receipt.pdf", 1024)]);
  assert.equal(attachments[0].contentType, "application/pdf");
  assert.ok(Buffer.isBuffer(attachments[0].content));
});

test("attachments: a Windows client's full path is reduced to the filename", () => {
  const { attachments } = toMailAttachments([upload("C:\\Users\\ada\\Desktop\\report.xlsx", 10)]);
  assert.equal(attachments[0].filename, "report.xlsx");
});

test("attachments: the TOTAL is bounded, not just each file", () => {
  // Every one of these passes multer's per-file limit and the set still bounces
  // at the provider, so the sum has to be checked somewhere.
  const nine = 9 * 1024 * 1024;
  const out = toMailAttachments([
    upload("a.pdf", nine),
    upload("b.pdf", nine),
    upload("c.pdf", nine),
  ]);
  assert.ok(out.error, "27MB of attachments must be refused");
  assert.ok(!out.attachments, "a refusal must not also return a payload");
  assert.ok(3 * nine > MAX_TOTAL_BYTES);
});

test("attachments: the summary records names and sizes, which is all that survives", () => {
  // The bytes are discarded with the request — this is what the audit row and
  // the send log get.
  const { summary } = toMailAttachments([upload("letter.pdf", 2048)]);
  assert.deepEqual(summary, [{ name: "letter.pdf", size: 2048 }]);
});

/* ── manual send: the free-form composer ─────────────────────────────────── */

const emailTemplates = require("../services/emailTemplates");

// Supplying `org` in the data is what buildContext checks before it goes to the
// database, so these render offline exactly as the composer's preview does.
const OFFLINE_ORG = {
  org: { name: "Hope Trust", email: "hello@hope.example", primaryColor: "#102A23" },
  recipient: { firstName: "Sarah", name: "Sarah Whitfield" },
};

test("custom email: hand-written content is wrapped in the branded layout", async () => {
  const out = await emailTemplates.renderCustom({
    subject: "A note from {{org.name}}",
    mode: "blocks",
    blocks: [
      { id: "c1", type: "heading", level: 2, text: "Hi {{recipient.firstName}}" },
      { id: "c2", type: "paragraph", text: "The document you asked for is attached." },
    ],
    data: OFFLINE_ORG,
  });

  assert.equal(out.subject, "A note from Hope Trust");
  // XHTML transitional — what wrapInLayout emits, and what Outlook wants.
  assert.ok(/^<!DOCTYPE html/i.test(out.html.trim()), "must be a complete document");
  assert.ok(out.html.includes("</html>"));
  assert.ok(out.html.includes("Hi Sarah"), "the body renders its variables");
  assert.ok(out.html.includes("Hope Trust"), "the layout carries the org identity");
  assert.ok(out.text.includes("Hi Sarah"), "a plain-text part is derived");
});

test("custom email: the body is escaped by the same renderer as a template", async () => {
  const out = await emailTemplates.renderCustom({
    subject: "hi",
    mode: "blocks",
    blocks: [{ id: "c1", type: "paragraph", text: "Hello {{recipient.firstName}}" }],
    data: { ...OFFLINE_ORG, recipient: { firstName: '<script>alert("x")</script>' } },
  });
  assert.ok(!out.html.includes("<script>alert"), "an operator's value must not become markup");
});

test("custom email: an empty subject is reported, not sent", async () => {
  const out = await emailTemplates.sendCustomEmail({
    to: "someone@example.com",
    subject: "   ",
    mode: "blocks",
    blocks: [{ id: "c1", type: "paragraph", text: "x" }],
    data: OFFLINE_ORG,
  });
  assert.equal(out.success, false);
  assert.equal(out.reason, "empty_subject");
});

test("custom email: no recipient is a skip, never a throw", async () => {
  // Mirrors sendTemplateEmail's contract: mail is always a side effect of
  // something more important and must not be able to fail it.
  const out = await emailTemplates.sendCustomEmail({ to: "", subject: "hi" });
  assert.equal(out.success, false);
  assert.equal(out.skipped, true);
  assert.equal(out.reason, "no_recipient");
});

/* ── manual send: the preview must not lie ───────────────────────────────── */

test("preview with samples off shows the blanks the send will actually have", async () => {
  const key = "donation.receipt";
  const org = { org: OFFLINE_ORG.org };

  const withSamples = await emailTemplates.previewTemplate(key, { data: org });
  const asComposed = await emailTemplates.previewTemplate(key, { data: org, samples: false });

  // The catalog's example donor must not appear in a composer preview where
  // nobody typed a name: sendTemplateEmail would not send it, so a preview that
  // showed it would be previewing a different email from the one going out.
  const sampleFirstName = catalog.sampleContext(key).donor.firstName;
  assert.equal(sampleFirstName, "Sarah");
  assert.ok(withSamples.html.includes("Thank you, Sarah"));
  assert.ok(
    !asComposed.html.includes("Sarah"),
    "an untouched field must render blank, not as its example value",
  );
  assert.ok(
    asComposed.html.includes("Thank you, friend"),
    "the template's own default fills the gap, exactly as it will on the real send",
  );
});

test("an unresolved DOTTED filter argument is not printed as a literal", () => {
  // Regression: the composer lets a human leave `donation.currency` empty, and
  // the literal fallback rendered the total as "250.00 DONATION.CURRENCY".
  // A dotted argument is unambiguously a path, so it yields nothing and the
  // filter's own default takes over.
  assert.equal(renderString("{{a.amount | money:a.currency}}", { a: { amount: 250 } }), "$250.00");

  // The two shapes the fallback exists for still work.
  assert.equal(renderString("{{n | money:GBP}}", { n: 10 }), "£10.00", "a bare literal code");
  assert.equal(renderString("{{n | money:cur}}", { n: 10, cur: "EUR" }), "€10.00", "a bare path");
  assert.equal(renderString("{{n | money:cur}}", { n: 10 }), "10.00 CUR", "an unresolved bare word");
});

/* ── the header must not say the brand name twice ────────────────────────── */

const brandCtx = (org) => ({ ...ctx, org: { ...ctx.org, name: "Donexus", ...org } });
const imgSrcs = (html) => [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);

test("header shows the MARK, not the wordmark, when the name is set in type", () => {
  // The platform's own logo IS a wordmark, so pairing it with the name in type
  // rendered "Donexus | Donexus" on every platform email that went out.
  const html = wrapInLayout(
    "<p>x</p>",
    DEFAULT_LAYOUT,
    brandCtx({ logoLight: "https://x.test/wordmark.png", logoIconLight: "https://x.test/mark.png" }),
    BRAND,
  );
  assert.ok(imgSrcs(html).includes("https://x.test/mark.png"), "the mark belongs beside the name");
  assert.ok(!imgSrcs(html).includes("https://x.test/wordmark.png"), "the wordmark would repeat the name");
  assert.ok(html.includes("Donexus"), "the name is still set in type");
});

test("with the name switched off the full logo carries the identity", () => {
  const html = wrapInLayout(
    "<p>x</p>",
    { ...DEFAULT_LAYOUT, showBrandName: false },
    brandCtx({ logoLight: "https://x.test/wordmark.png", logoIconLight: "https://x.test/mark.png" }),
    BRAND,
  );
  assert.ok(imgSrcs(html).includes("https://x.test/wordmark.png"));
  assert.ok(!imgSrcs(html).includes("https://x.test/mark.png"));
});

test("an organisation with no mark uploaded is completely unaffected", () => {
  // This is what lets the change ship without anyone re-uploading anything.
  const html = wrapInLayout(
    "<p>x</p>",
    DEFAULT_LAYOUT,
    brandCtx({ logoLight: "https://x.test/wordmark.png" }),
    BRAND,
  );
  assert.ok(imgSrcs(html).includes("https://x.test/wordmark.png"));
});

test("an operator's own logo URL is never swapped out for the mark", () => {
  // Typing a URL into the layout means THAT image.
  const html = wrapInLayout(
    "<p>x</p>",
    { ...DEFAULT_LAYOUT, logoUrlOnDark: "https://x.test/chosen.png" },
    brandCtx({ logoLight: "https://x.test/wordmark.png", logoIconLight: "https://x.test/mark.png" }),
    BRAND,
  );
  assert.ok(imgSrcs(html).includes("https://x.test/chosen.png"));
  assert.ok(!imgSrcs(html).includes("https://x.test/mark.png"));
});

test("no logo and no mark still falls back to the initials chip", () => {
  const html = wrapInLayout("<p>x</p>", DEFAULT_LAYOUT, brandCtx({ logo: "", logoLight: "" }), BRAND);
  assert.equal(imgSrcs(html).length, 0);
  assert.ok(html.includes(">D<"), "initials stand in for a missing logo");
});
