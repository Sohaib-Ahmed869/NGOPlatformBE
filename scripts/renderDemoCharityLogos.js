/**
 * Draw the two invented charities' marks and rasterise them to PNG.
 *
 * Both charities are made up, so there is no media kit to download — the marks
 * are authored here as flat geometry:
 *
 *   Bellhaven   an archway on a plinth. A doorway to walk through, and — dome
 *               over a base — a bell, which is the half of the name an arch
 *               alone throws away.
 *   Harbourlight the {8/3} khatim star of Islamic geometry with a round light
 *               held in the middle of it. A harbour light, and the star you
 *               steer by.
 *
 * Flat fills, hairline geometry, no gradient, no glow, no shadow — the same
 * house rule the product UI follows.
 *
 * ── Why PNG, and why a browser ──────────────────────────────────────────────
 * The wordmark contains type, and an SVG shipped with `font-family: Outfit`
 * renders in whatever font the VIEWER has — a tenant logo that changes shape
 * per machine is not a logo. Rasterising through Chromium bakes the type into
 * pixels. PNG also survives the two places SVG does not: PDF receipts (pdfkit
 * cannot rasterise SVG) and email clients (Gmail and Outlook drop SVG <img>).
 *
 * Playwright lives in the FRONTEND's node_modules, not the backend's, so this
 * is the one script here that reaches across the two projects. It is also the
 * only script you can skip: its output is committed under
 * scripts/assets/demo-charities/, and setDemoCharityBranding.js reads those
 * files. Re-run this only when you want to change how the marks look.
 *
 * Run:  node scripts/renderDemoCharityLogos.js            (both)
 *       node scripts/renderDemoCharityLogos.js bellhaven  (just one)
 */

const path = require("path");
const fs = require("fs");
const { selectFromArgv } = require("./demoCharities");

const OUT_DIR = path.join(__dirname, "assets", "demo-charities");

/**
 * Playwright is nobody's dependency here — it is a tool, used once per logo
 * change. Look for it wherever it might already be on the machine rather than
 * adding a browser automation library to a backend that will never run tests
 * with it: this project's own node_modules, the frontend's, then the npx cache
 * (`npx playwright install chromium` leaves a copy there).
 */
function loadPlaywright() {
  const candidates = ["playwright", path.join(__dirname, "..", "..", "NGOPlatformFE", "node_modules", "playwright")];

  const npxCache = path.join(process.env.LOCALAPPDATA || process.env.HOME || "", "npm-cache", "_npx");
  try {
    for (const dir of fs.readdirSync(npxCache)) {
      candidates.push(path.join(npxCache, dir, "node_modules", "playwright"));
    }
  } catch { /* no npx cache on this machine */ }

  for (const id of candidates) {
    try {
      return require(id);
    } catch { /* try the next one */ }
  }
  console.error(
    "ERROR: Playwright not found.\n" +
    "  This script needs a browser to rasterise the marks. Either install it here\n" +
    "  (npm i -D playwright && npx playwright install chromium) or run it from a\n" +
    "  checkout where NGOPlatformFE/node_modules/playwright exists.\n" +
    "  You can skip it entirely — the PNGs it produces are committed under\n" +
    `  ${path.relative(process.cwd(), OUT_DIR)}.`,
  );
  process.exit(1);
}

/** Mix a hex colour toward white. Used for the cut that sits on a dark ground. */
function lighten(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The eight-point star of Islamic geometry, drawn honestly: the {8/3} star
 * polygon. Eight points on a circle, joined every THIRD point, which closes
 * into a single continuous path that visits all eight — the same construction
 * the khatim in tilework uses. One path means no overlapping shapes to go out
 * of register, and it stays a star at any size.
 *
 * Filled with `evenodd` the crossings leave an octagonal hole in the middle,
 * which is where Harbourlight's "light" sits.
 */
function starPolygon(cx, cy, r, step = 3, points = 8) {
  const vertex = (k) => {
    // Rotated half a step so a point sits at the top rather than a flat edge.
    const a = ((-90 + 180 / points) + k * (360 / points)) * (Math.PI / 180);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const order = [];
  let i = 0;
  do { order.push(i); i = (i + step) % points; } while (i !== 0);
  return "M" + order.map((k) => vertex(k).map((n) => n.toFixed(2)).join(" ")).join("L") + "Z";
}

/**
 * The marks, in two cuts each.
 *
 *   line(primary, secondary)  the lockup mark, two colours, at wordmark size.
 *   solid(colour)             one filled silhouette for the app icon. The
 *                             outline cut cannot be reused there: a 9px stroke
 *                             on an 88 viewBox lands under two pixels once the
 *                             icon is scaled to a 16px favicon and disappears.
 *
 * Both marks carry a second reading of the charity's name, which is what stops
 * them being clip art:
 *
 *   arch  an archway standing on a plinth — a doorway you can walk through, and
 *         the reason it is a plinth rather than a baseline is that dome-on-base
 *         is also the silhouette of a BELL. Bellhaven. It also keeps the mark
 *         from reading as a rainbow, which every unsupported arch does.
 *   star  the {8/3} khatim star with a round light held in its middle: the
 *         eight-point star of Islamic ornament, and a harbour light.
 */
const MARKS = {
  arch: {
    line: (primary, secondary) => `
      <svg viewBox="0 0 88 88" width="88" height="88" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M15 70V45a29 29 0 0 1 58 0v25" stroke="${primary}" stroke-width="9.5"/>
        <rect x="8" y="74" width="72" height="9.5" rx="4.75" fill="${secondary}"/>
      </svg>`,
    solid: (colour) => `
      <svg viewBox="0 0 88 88" width="88" height="88" xmlns="http://www.w3.org/2000/svg">
        <path d="M15 70V45a29 29 0 0 1 58 0v25Z" fill="${colour}"/>
        <rect x="8" y="74" width="72" height="9.5" rx="4.75" fill="${colour}"/>
      </svg>`,
  },
  star: {
    line: (primary, secondary) => `
      <svg viewBox="0 0 88 88" width="88" height="88" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="${starPolygon(44, 44, 36)}" fill="${primary}" fill-rule="evenodd"/>
        <circle cx="44" cy="44" r="7.5" fill="${secondary}"/>
      </svg>`,
    // The light closes up below ~20px and the star goes solid. That is the
    // right way for it to fail: still unmistakably an eight-point star.
    solid: (colour) => `
      <svg viewBox="0 0 88 88" width="88" height="88" xmlns="http://www.w3.org/2000/svg">
        <path d="${starPolygon(44, 44, 38)}" fill="${colour}" fill-rule="evenodd"/>
        <circle cx="44" cy="44" r="7.5" fill="${colour}"/>
      </svg>`,
  },
};

/** One page holding every variant, each in its own screenshot-able box. */
function pageHtml(c) {
  const { mark, primaryColor, accentColor } = c.brand;
  const accentLight = lighten(accentColor, 0.45);
  const marks = MARKS[mark];
  if (!marks) throw new Error(`Unknown mark "${mark}" for ${c.slug}`);

  // "Bellhaven Foundation" → big word + spaced-out kicker, the ordinary shape of
  // a charity lockup. The legal "Ltd" never appears in a mark.
  const [word, ...rest] = c.displayName.split(" ");
  const kicker = rest.join(" ").toUpperCase();

  const lockup = (id, markSvg, wordColor, kickerColor) => `
    <div class="lockup" id="${id}">
      ${markSvg}
      <div class="type">
        <div class="word" style="color:${wordColor}">${word}</div>
        <div class="kicker" style="color:${kickerColor}">${kicker}</div>
      </div>
    </div>`;

  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;600&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:transparent;font-family:Outfit,'Segoe UI',system-ui,sans-serif}
  .lockup{display:inline-flex;align-items:center;gap:20px;padding:10px 14px}
  .type{display:flex;flex-direction:column;gap:3px}
  .word{font-size:48px;font-weight:600;letter-spacing:-0.028em;line-height:1}
  .kicker{font-size:13px;font-weight:500;letter-spacing:0.30em;line-height:1}
  .icon{width:256px;height:256px;border-radius:60px;display:grid;place-items:center}
  /* The mark sits on roughly a quarter-tile margin. Anything larger reads as
     cramped in a browser tab, where the tile is already clipped by the tab's
     own rounding. */
  .icon svg{width:146px;height:146px}
  /* Stack them so no box overlaps another's screenshot. */
  .sheet{display:flex;flex-direction:column;align-items:flex-start;gap:40px;padding:40px}
</style></head><body><div class="sheet">
  ${lockup("wordmark", marks.line(primaryColor, accentColor), primaryColor, accentColor)}
  ${lockup("wordmark-light", marks.line("#FFFFFF", accentLight), "#FFFFFF", accentLight)}
  <div class="icon" id="icon" style="background:${primaryColor}">
    ${marks.solid("#FFFFFF")}
  </div>
</div></body></html>`;
}

async function run() {
  const charities = selectFromArgv();
  const { chromium } = loadPlaywright();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  try {
    for (const c of charities) {
      console.log(`── ${c.displayName}`);
      const page = await browser.newPage({ deviceScaleFactor: 3 });
      await page.setContent(pageHtml(c), { waitUntil: "networkidle" });
      // Without this the type can rasterise in the fallback face.
      await page.evaluate(() => document.fonts.ready);

      for (const id of ["wordmark", "wordmark-light", "icon"]) {
        const file = path.join(OUT_DIR, `${c.slug}-${id}.png`);
        await page.locator(`#${id}`).screenshot({ path: file, omitBackground: true });
        const kb = (fs.statSync(file).size / 1024).toFixed(1);
        console.log(`   ${id.padEnd(15)} ${kb.padStart(6)}KB  ${path.basename(file)}`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }

  console.log(`\nWrote to ${OUT_DIR}`);
  console.log("Next: npm run brand:demo-charities — uploads these and writes the branding block.");
}

run().catch((e) => {
  console.error("\nFAILED:", e.message);
  console.error(e.stack);
  process.exit(1);
});
