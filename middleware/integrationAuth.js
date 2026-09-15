/**
 * middleware/integrationAuth.js — API-key auth for /api/integration.
 *
 * Server-to-server only (Calcite Hyper's backend). One header, no sessions:
 *
 *   x-api-key: <secret>                 required
 *   x-actor-email: person@calcite.live  optional — the human behind the call,
 *                                        recorded in the audit trail
 *
 * Keys come from INTEGRATION_API_KEYS, a comma-separated list of name:key pairs
 * (`hyper:dnx_live_…,hyper-old:dnx_live_…`). Several pairs at once is what makes
 * rotation zero-downtime. The NAME is not secret — it identifies the caller in
 * logs and audit rows; the key never leaves this file.
 *
 *   valid key                          → next()
 *   missing / unknown key              → 401
 *   INTEGRATION_API_KEYS unset/empty   → 503, and nothing else in the app is affected
 */
const crypto = require("crypto");
const { fail } = require("../utils/integrationResponse");

const MIN_KEY_LENGTH = 24;
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();

let cache = { raw: null, keys: [] };
const warned = new Set();

/**
 * Parse INTEGRATION_API_KEYS. Re-parsed only when the variable changes. A pair
 * with a bad name or a key shorter than MIN_KEY_LENGTH is skipped with a
 * one-time warning rather than accepted — "hyper:test" must never work in prod.
 * @returns {{name:string, hash:Buffer}[]}
 */
function loadKeys(raw = process.env.INTEGRATION_API_KEYS) {
  const value = String(raw || "");
  if (cache.raw === value) return cache.keys;
  const keys = [];
  for (const pair of value.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    const name = idx > 0 ? trimmed.slice(0, idx).trim() : "";
    const key = idx > 0 ? trimmed.slice(idx + 1).trim() : "";
    if (!NAME_RE.test(name) || key.length < MIN_KEY_LENGTH) {
      const label = name || "(unnamed)";
      if (!warned.has(label)) {
        warned.add(label);
        console.warn(`[integration] ignoring INTEGRATION_API_KEYS entry "${label}": expected name:key with a key of at least ${MIN_KEY_LENGTH} characters`);
      }
      continue;
    }
    keys.push({ name, hash: digest(key) });
  }
  cache = { raw: value, keys };
  return keys;
}

/** The name of the pair whose key matches, or null. Compares every pair in constant time. */
function matchKey(provided, keys) {
  const h = digest(provided);
  let match = null;
  for (const k of keys) {
    if (crypto.timingSafeEqual(h, k.hash) && !match) match = k.name;
  }
  return match;
}

function integrationAuth(req, res, next) {
  const keys = loadKeys();
  if (!keys.length) {
    return fail(res, 503, "INTEGRATION_DISABLED", "The integration API is not enabled on this server");
  }

  const provided = req.get("x-api-key");
  if (!provided) return fail(res, 401, "API_KEY_MISSING", "Send your API key in the x-api-key header");
  const keyName = matchKey(provided, keys);
  if (!keyName) return fail(res, 401, "API_KEY_INVALID", "The API key is not recognised");

  // Attribution, not authorisation: the key is what grants access. An invalid
  // value is refused rather than dropped, so an audit row never silently loses
  // the person it was meant to name.
  let actorEmail = "";
  const rawActor = req.get("x-actor-email");
  if (rawActor !== undefined && String(rawActor).trim() !== "") {
    actorEmail = String(rawActor).trim().toLowerCase();
    if (actorEmail.length > 254 || !EMAIL_RE.test(actorEmail)) {
      return fail(res, 400, "INVALID_ACTOR_EMAIL", "x-actor-email must be a single email address");
    }
  }

  req.user = null;
  req.integration = {
    keyName,
    actorEmail,
    actorLabel: actorEmail ? `integration:${keyName} (${actorEmail})` : `integration:${keyName}`,
  };
  next();
}

module.exports = integrationAuth;
module.exports.loadKeys = loadKeys;
module.exports.MIN_KEY_LENGTH = MIN_KEY_LENGTH;
