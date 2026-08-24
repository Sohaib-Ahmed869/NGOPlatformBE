/**
 * This server's own public base URL — the address an EXTERNAL service (Stripe,
 * PayPal) would have to call to reach us.
 *
 * Resolution order:
 *   1. PUBLIC_API_URL / SERVER_URL — purpose-built override.
 *   2. VITE_API_URL — already set in this project to the DEPLOYED backend
 *      ("https://…/api"). Consulted because a webhook must reach the deployed
 *      server, not whichever machine happens to be serving the console: running
 *      locally against a production database would otherwise advertise a
 *      localhost endpoint that Stripe can never call.
 *   3. The incoming request. The caller reached this server at exactly the host
 *      a webhook would need, so the headers are authoritative when nothing is
 *      configured. X-Forwarded-Proto/Host are honoured so a TLS-terminating
 *      proxy yields the public https URL rather than the internal http one.
 *
 * The returned value never has a trailing slash and never keeps a trailing
 * "/api" — callers append their own full path.
 */
const tidy = (url) => url.trim().replace(/\/+$/, "").replace(/\/api$/i, "");

function publicBaseUrl(req) {
  const explicit = process.env.PUBLIC_API_URL || process.env.SERVER_URL || "";
  if (explicit.trim()) return tidy(explicit);
  const viteApi = process.env.VITE_API_URL || "";
  if (viteApi.trim()) return tidy(viteApi);
  if (!req) return "";
  // Each header can be a comma-separated chain when several proxies are hopped;
  // the first entry is the original client-facing one.
  const first = (v) => String(v || "").split(",")[0].trim();
  const proto = first(req.headers?.["x-forwarded-proto"]) || req.protocol || "http";
  const host =
    first(req.headers?.["x-forwarded-host"]) ||
    (typeof req.get === "function" ? req.get("host") : "") ||
    req.headers?.host ||
    "";
  return host ? `${proto}://${host}` : "";
}

// Addresses Stripe (or any external caller) cannot deliver to.
const LOCAL_HOST_RE = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;

/** Can an external service actually reach this base URL? */
function isPubliclyReachable(base) {
  return !!base && !LOCAL_HOST_RE.test(base);
}

module.exports = { publicBaseUrl, isPubliclyReachable };
