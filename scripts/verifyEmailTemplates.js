/**
 * scripts/verifyEmailTemplates.js
 *
 *   npm run verify:emails
 *
 * Static checks over the whole email system. Runs without a database, so it is
 * safe in CI and as a pre-deploy gate.
 *
 * It answers the four questions that actually break this system in practice:
 *
 *   1. Does every catalog template still render? (a bad default ships broken
 *      content to every tenant that hasn't overridden it)
 *   2. Does every template reference only variables it declares? (a typo'd
 *      {{donor.frstName}} renders as nothing, silently, forever)
 *   3. Is every catalog key actually SENT by something? (a template nobody
 *      calls is dead weight in the console)
 *   4. Does every sendTemplateEmail() key EXIST in the catalog? (a typo'd key
 *      means that email silently never sends)
 *
 * Exits non-zero when anything fails, so it can gate a deploy.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const catalog = require("../config/emailCatalog");
const { blocksToHtml, wrapInLayout, htmlToText } = require("../services/emailBlocks");
const { renderString, collectTokens } = require("../services/emailRender");

const ROOT = path.join(__dirname, "..");
const SCAN_DIRS = ["controllers", "services", "jobs", "routes"];

const problems = [];
const warnings = [];

/* -- 1 + 2: render and lint every template ------------------------------- */

function checkTemplates() {
  const known = (key) => new Set(catalog.variablesFor(key).map((v) => v.key));

  for (const entry of catalog.TEMPLATES) {
    const defaults = catalog.defaultsFor(entry.key);
    const ctx = catalog.sampleContext(entry.key);

    let subject;
    let html;
    try {
      subject = renderString(defaults.subject, ctx);
      const body = blocksToHtml(defaults.blocks, ctx, {});
      html = wrapInLayout(body, { preheader: defaults.preheader }, ctx);
    } catch (err) {
      problems.push(`${entry.key}: threw while rendering — ${err.message}`);
      continue;
    }

    if (!subject.trim()) problems.push(`${entry.key}: renders an empty subject`);
    if (!htmlToText(html).trim()) problems.push(`${entry.key}: renders an empty body`);

    // The <style> block legitimately ends in "}}" (a CSS media query), so it is
    // excluded before looking for tokens the renderer failed to substitute.
    const scanned = html.replace(/<style[\s\S]*?<\/style>/g, "");
    const leftover = `${subject}${scanned}`.match(/\{\{[^}]*\}\}/g);
    if (leftover) {
      problems.push(`${entry.key}: unrendered tokens — ${[...new Set(leftover)].slice(0, 3).join(" ")}`);
    }

    // Collect every {{token}} the template uses and check it is declared.
    const declared = known(entry.key);
    declared.add("currency");
    const used = new Set();
    const walk = (val) => {
      if (typeof val === "string") collectTokens(val).forEach((t) => used.add(t));
      else if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val === "object") Object.values(val).forEach(walk);
    };
    walk([defaults.subject, defaults.preheader, defaults.blocks]);

    for (const token of used) {
      if (declared.has(token)) continue;
      if (token.startsWith("this.")) continue; // {{#each}} loop scope
      // A token is fine if it is a prefix of, or prefixed by, a declared one:
      // `donation` names the object whose `donation.id` is declared.
      const related = [...declared].some((d) => d.startsWith(`${token}.`) || token.startsWith(`${d}.`));
      if (!related) problems.push(`${entry.key}: uses {{${token}}}, which it doesn't declare`);
    }
  }
}

/* -- 3 + 4: catalog keys vs. real call sites ----------------------------- */

function walkJs(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(full, out);
    else if (e.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function checkCallSites() {
  const files = SCAN_DIRS.flatMap((d) => walkJs(path.join(ROOT, d)));

  // The key is always the FIRST argument, so anchor on that — a looser pattern
  // runs on into the options object and "finds" keys like `data`.
  const DIRECT_RE = /sendTemplateEmail\(\s*["'`]([a-zA-Z][\w.]*)["'`]/g;
  // ...except where one call site picks between two templates with a ternary.
  const TERNARY_RE = /sendTemplateEmail\(\s*[^,]*?\?\s*["'`]([a-zA-Z][\w.]*)["'`]\s*:\s*["'`]([a-zA-Z][\w.]*)["'`]/g;
  // ...or resolves the key through a lookup table (the volunteer statuses do).
  // In a file that already sends templated email, a bare string literal equal
  // to a catalog key is that key being used.
  const LITERAL_RE = /["'`]([a-z][\w]*(?:\.[\w]+)+)["'`]/g;

  const used = new Set();
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    if (!src.includes("sendTemplateEmail")) continue;

    for (const m of src.matchAll(DIRECT_RE)) used.add(m[1]);
    for (const m of src.matchAll(TERNARY_RE)) {
      used.add(m[1]);
      used.add(m[2]);
    }
    for (const m of src.matchAll(LITERAL_RE)) {
      if (catalog.has(m[1])) used.add(m[1]);
    }
  }

  for (const key of used) {
    if (!catalog.has(key)) {
      problems.push(`a call site sends "${key}", which is not in the catalog — that email never sends`);
    }
  }
  for (const key of catalog.allKeys()) {
    if (!used.has(key)) {
      warnings.push(`"${key}" is in the catalog but nothing sends it`);
    }
  }
  return used;
}

/* -- report --------------------------------------------------------------- */

checkTemplates();
const used = checkCallSites();

const groups = new Set(catalog.GROUPS.map((g) => g.key));
for (const t of catalog.TEMPLATES) {
  if (!groups.has(t.group)) problems.push(`${t.key}: unknown group "${t.group}"`);
  if (!["tenant", "platform"].includes(t.scope)) problems.push(`${t.key}: unknown scope "${t.scope}"`);
}

console.log(`\nEmail templates: ${catalog.TEMPLATES.length} in the catalog, ${used.size} wired to a call site.\n`);

if (warnings.length) {
  console.log("Warnings:");
  for (const w of warnings) console.log(`  ~ ${w}`);
  console.log("");
}

if (problems.length) {
  console.error("Problems:");
  for (const p of problems) console.error(`  x ${p}`);
  console.error(`\n${problems.length} problem(s) found.\n`);
  process.exit(1);
}

console.log("All checks passed.\n");
