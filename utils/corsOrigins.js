/**
 * One CORS origin policy, shared by the HTTP API (server.js) and the websocket
 * layer (services/socket.js) so the two can never drift apart.
 *
 * Allowed:
 *  - no origin at all (server-to-server, Postman, curl)
 *  - any localhost / *.localhost port in dev
 *  - CORS_DOMAIN and any of its subdomains (the tenant subdomains, https only)
 *  - CLIENT_URL
 *  - the hosted frontends in STATIC_ORIGINS, plus anything in the
 *    EXTRA_CORS_ORIGINS env var (comma-separated full origins)
 */

// Deployed frontends that live outside CORS_DOMAIN.
const STATIC_ORIGINS = [
  "https://cccw-frontend.vercel.app",
  "https://www.cccw-frontend.vercel.app",
];

function envOrigins() {
  return String(process.env.EXTRA_CORS_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser clients

  // Dev: allow localhost origins
  if (/^https?:\/\/(localhost|[a-z0-9-]+\.localhost)(:\d+)?$/.test(origin)) return true;

  // Production: match any subdomain of CORS_DOMAIN
  if (process.env.CORS_DOMAIN) {
    const escaped = process.env.CORS_DOMAIN.replace(/\./g, "\\.");
    if (new RegExp(`^https://([a-z0-9-]+\\.)?${escaped}$`).test(origin)) return true;
  }

  if (origin === process.env.CLIENT_URL) return true;

  return STATIC_ORIGINS.includes(origin) || envOrigins().includes(origin);
}

module.exports = { isAllowedOrigin, STATIC_ORIGINS };
