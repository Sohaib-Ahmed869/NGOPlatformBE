/**
 * services/emailRender.js
 *
 * The rendering half of the dynamic email-template system: a tiny, dependency-free
 * template language plus a block compiler that turns the visual builder's JSON
 * into email-client-safe HTML.
 *
 * Why not Handlebars/MJML? Every template here is authored by a platform operator
 * through the SuperAdmin console and rendered on a request path that must never
 * throw (a bad template must degrade to a plain email, not fail a donation). A
 * self-contained evaluator is auditable, has no `eval`, cannot reach outside the
 * data object it is given, and adds nothing to the deploy.
 *
 * Supported syntax (deliberately small — it is a mail-merge, not a language):
 *   {{ donor.firstName }}            escaped interpolation
 *   {{{ block.html }}}               raw interpolation (trusted operator HTML)
 *   {{ amount | money }}             filters, chainable: {{ a | default:"there" | upper }}
 *   {{#if donation.isRecurring}} ... {{else}} ... {{/if}}
 *   {{#unless org.hasLogo}} ... {{/unless}}
 *   {{#each items}} {{ this.label }} - {{@index}} {{/each}}
 *
 * Everything is HTML-escaped by default. Values only ever come from the context
 * object the call site builds, never from `req.body` directly.
 */

/* -- escaping ------------------------------------------------------------- */

const HTML_ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);

// Attribute values that end up inside href="" -- an operator typing a
// `javascript:` URL into a button block shouldn't produce a live link.
const SAFE_URL_RE = /^(https?:\/\/|mailto:|tel:|\/|#)/i;
const safeUrl = (v) => {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  return SAFE_URL_RE.test(s) ? escapeHtml(s) : "";
};

/**
 * A URL that will actually resolve inside an inbox.
 *
 * `safeUrl` also passes root-relative ("/logo.png") and anchor URLs, which are
 * perfectly safe and perfectly useless in email: there is no page for them to
 * resolve against, so an <img> built from one is a guaranteed broken box and a
 * link is dead. Image sources go through this instead, so a misconfigured logo
 * falls back to something drawable rather than to a broken-image icon.
 */
const absoluteUrl = (v) => {
  const s = safeUrl(v);
  return /^https?:\/\//i.test(s) ? s : "";
};

/* -- value lookup --------------------------------------------------------- */

/**
 * Resolve a dotted path against a chain of scopes, innermost first, so an
 * {{#each}} body can still reach `org.name` from the outer context.
 */
function lookup(path, chain) {
  const p = String(path || "").trim();
  if (!p) return undefined;
  if (p === "." || p === "this") return chain[0] ? chain[0].$this : undefined;

  // Loop metadata (@index / @number / @first / @last) lives on the innermost scope.
  if (p.startsWith("@")) {
    for (const scope of chain) if (scope && p in scope) return scope[p];
    return undefined;
  }

  const parts = p.split(".");
  const relative = parts[0] === "this";
  const keys = relative ? parts.slice(1) : parts;
  for (const scope of chain) {
    let cur = relative ? (scope ? scope.$this : undefined) : scope;
    let ok = true;
    for (const part of keys) {
      if (cur == null || typeof cur !== "object" || !(part in cur)) {
        ok = false;
        break;
      }
      cur = cur[part];
    }
    if (ok && cur !== undefined) return cur;
  }
  return undefined;
}

/* -- filters -------------------------------------------------------------- */

const CURRENCY_SYMBOL = { AUD: "$", USD: "$", GBP: "£", EUR: "€", NZD: "$", CAD: "$", SGD: "$" };

function fmtDate(v, opts) {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  try {
    return d.toLocaleDateString("en-AU", opts);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

const FILTERS = {
  upper: (v) => String(v == null ? "" : v).toUpperCase(),
  lower: (v) => String(v == null ? "" : v).toLowerCase(),
  title: (v) =>
    String(v == null ? "" : v)
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase()),
  trim: (v) => String(v == null ? "" : v).trim(),
  // "there" when the value is missing -- {{ donor.firstName | default:"there" }}
  default: (v, arg) => (v === undefined || v === null || v === "" ? (arg == null ? "" : arg) : v),
  // 1234.5 -> "$1,234.50". The argument may be a literal code (money:"GBP") or a
  // variable path (money:donation.currency); with neither, `currency` from the
  // context is used, then AUD.
  money: (v, ccy) => {
    const n = Number(v);
    if (!isFinite(n)) return String(v == null ? "" : v);
    const code = String(ccy || "AUD").toUpperCase();
    const sym = CURRENCY_SYMBOL[code] || "";
    const amount = n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return sym ? `${sym}${amount}` : `${amount} ${code}`;
  },
  number: (v) => {
    const n = Number(v);
    return isFinite(n) ? n.toLocaleString("en-AU") : String(v == null ? "" : v);
  },
  date: (v) => fmtDate(v, { day: "numeric", month: "long", year: "numeric" }),
  datetime: (v) =>
    fmtDate(v, { day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" }),
  day: (v) => fmtDate(v, { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
  // Operator-entered multi-line text inside a single-line block.
  nl2br: (v) => escapeHtml(v).replace(/\r?\n/g, "<br/>"),
  // Truthy test rendered as a word -- handy inside subjects, which have no {{#if}}.
  yesno: (v) => (v ? "Yes" : "No"),
};

// `nl2br` emits markup, so it must not be escaped again afterwards.
const RAW_FILTERS = new Set(["nl2br"]);

/**
 * Split `path | default:"there" | upper` into a path and its filter chain,
 * respecting quotes so an argument may contain a pipe.
 */
function parseExpression(expr) {
  const segments = [];
  let cur = "";
  let quote = null;
  for (const ch of String(expr)) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "|") {
      segments.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  segments.push(cur);

  const path = segments.shift().trim();
  const filters = segments
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const idx = s.indexOf(":");
      if (idx === -1) return { name: s, arg: undefined, quoted: false };
      const rawArg = s.slice(idx + 1).trim();
      const quoted = /^["'][\s\S]*["']$/.test(rawArg);
      return {
        name: s.slice(0, idx).trim(),
        arg: quoted ? rawArg.slice(1, -1) : rawArg,
        quoted,
      };
    });
  return { path, filters };
}

/**
 * Filter arguments come in two flavours, because nesting {{ }} inside a filter
 * argument is not expressible: a QUOTED argument is always the literal string
 * (`default:"there"`), while an UNQUOTED one is first tried as a variable path
 * (`money:donation.currency`) and falls back to the literal when that resolves
 * to nothing (`money:GBP`).
 *
 * A DOTTED unquoted argument is the exception: it is unambiguously a path, and
 * no currency code, date format or default string has a dot in it. Falling back
 * to the literal there prints the path itself, which is how a receipt sent with
 * no currency filled in rendered its total as "250.00 DONATION.CURRENCY". It
 * yields `undefined` instead, so the filter applies its own default.
 *
 * This only ever showed up once emails could be sent BY HAND — an automatic
 * call site always supplies the currency, so the fallback was never wrong until
 * a human could leave the field empty.
 */
function resolveArg(f, chain) {
  if (f.arg === undefined || f.quoted) return f.arg;
  const looked = lookup(f.arg, chain);
  if (looked === undefined || looked === null || looked === "") {
    return f.arg.includes(".") ? undefined : f.arg;
  }
  return looked;
}

function applyFilters(value, filters, chain) {
  let v = value;
  let raw = false;
  for (const f of filters) {
    const fn = FILTERS[f.name];
    if (!fn) continue;
    v = fn(v, resolveArg(f, chain || [{}]));
    raw = RAW_FILTERS.has(f.name);
  }
  return { value: v, raw };
}

/* -- parser --------------------------------------------------------------- */

// {{{raw}}} must be tried before {{ }} or the triple braces split wrongly.
const TOKEN_RE = /\{\{\{\s*([\s\S]+?)\s*\}\}\}|\{\{\s*([\s\S]+?)\s*\}\}/g;
const BLOCK_HELPERS = new Set(["if", "unless", "each"]);

function parse(str) {
  const root = { children: [] };
  const stack = [root];
  const target = () => {
    const top = stack[stack.length - 1];
    return top.inAlt ? top.alt : top.children;
  };

  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(str))) {
    if (m.index > last) target().push({ t: "text", v: str.slice(last, m.index) });
    last = TOKEN_RE.lastIndex;

    const isRaw = m[1] != null;
    const expr = (isRaw ? m[1] : m[2]).trim();

    if (isRaw) {
      target().push({ t: "var", expr, raw: true });
      continue;
    }
    if (expr.startsWith("#")) {
      const space = expr.search(/\s/);
      const helper = (space === -1 ? expr.slice(1) : expr.slice(1, space)).trim();
      const arg = space === -1 ? "" : expr.slice(space + 1).trim();
      if (!BLOCK_HELPERS.has(helper)) {
        // Unknown helper -- emit it literally rather than silently swallowing text.
        target().push({ t: "text", v: m[0] });
        continue;
      }
      const node = { t: "block", helper, expr: arg, children: [], alt: [], inAlt: false };
      target().push(node);
      stack.push(node);
    } else if (expr === "else") {
      if (stack.length > 1) stack[stack.length - 1].inAlt = true;
    } else if (expr.startsWith("/")) {
      if (stack.length > 1) stack.pop();
    } else {
      target().push({ t: "var", expr, raw: false });
    }
  }
  if (last < str.length) target().push({ t: "text", v: str.slice(last) });
  return root.children;
}

// Parsing the same string on every send (a 500-donor campaign, a receipt burst)
// is pure waste -- templates change at operator speed, not request speed.
const astCache = new Map();
const AST_CACHE_MAX = 500;
function parseCached(str) {
  const hit = astCache.get(str);
  if (hit) return hit;
  const ast = parse(str);
  if (astCache.size >= AST_CACHE_MAX) astCache.clear();
  astCache.set(str, ast);
  return ast;
}

/* -- evaluator ------------------------------------------------------------ */

// An empty string, 0, an empty array and null are all "nothing to show" for the
// purposes of {{#if}} -- a donation of $0 or a guest count of 0 should hide its
// row rather than print a bare zero.
const isEmpty = (v) =>
  v === undefined ||
  v === null ||
  v === false ||
  v === "" ||
  v === 0 ||
  (Array.isArray(v) && v.length === 0);

function renderNodes(nodes, chain) {
  let out = "";
  for (const node of nodes) {
    if (node.t === "text") {
      out += node.v;
    } else if (node.t === "var") {
      const { path, filters } = parseExpression(node.expr);
      const { value, raw } = applyFilters(lookup(path, chain), filters, chain);
      if (value === undefined || value === null) continue;
      out += node.raw || raw ? String(value) : escapeHtml(value);
    } else if (node.t === "block") {
      const { path, filters } = parseExpression(node.expr);
      const { value } = applyFilters(lookup(path, chain), filters, chain);

      if (node.helper === "if" || node.helper === "unless") {
        const truthy = node.helper === "if" ? !isEmpty(value) : isEmpty(value);
        out += renderNodes(truthy ? node.children : node.alt, chain);
      } else if (node.helper === "each") {
        const items = Array.isArray(value) ? value : [];
        if (!items.length) {
          out += renderNodes(node.alt, chain);
          continue;
        }
        items.forEach((item, i) => {
          const scope = {
            ...(item && typeof item === "object" && !Array.isArray(item) ? item : {}),
            $this: item,
            "@index": i,
            "@number": i + 1,
            "@first": i === 0,
            "@last": i === items.length - 1,
          };
          out += renderNodes(node.children, [scope, ...chain]);
        });
      }
    }
  }
  return out;
}

/**
 * Render a template string against a data context.
 * Never throws -- a broken template returns the original string rather than
 * taking down the request that was trying to send the email.
 */
function renderString(tpl, ctx) {
  if (tpl == null || tpl === "") return "";
  const str = String(tpl);
  if (!str.includes("{{")) return str;
  try {
    return renderNodes(parseCached(str), [ctx || {}]);
  } catch (err) {
    console.error("[emailRender] template error:", err.message);
    return str;
  }
}

function* walk(nodes) {
  for (const n of nodes) {
    yield n;
    if (n.t === "block") {
      yield* walk(n.children);
      yield* walk(n.alt);
    }
  }
}

/** Every {{token}} referenced by a string -- used to validate a saved template. */
function collectTokens(str) {
  const found = new Set();
  if (!str) return [];
  try {
    for (const node of walk(parseCached(String(str)))) {
      if (node.t === "var" || node.t === "block") {
        const { path } = parseExpression(node.expr);
        if (path && !path.startsWith("@") && path !== "this" && path !== ".") found.add(path);
      }
    }
  } catch {
    /* a malformed template simply reports no tokens */
  }
  return [...found];
}

module.exports = {
  escapeHtml,
  safeUrl,
  absoluteUrl,
  renderString,
  collectTokens,
  lookup,
  FILTERS,
};
