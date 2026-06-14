// Per-tenant PayPal. Each organisation can connect its OWN PayPal app
// (client id + secret + mode), stored with the secret AES-256-GCM encrypted.
// When a tenant hasn't configured (and enabled) their own, we fall back to the
// platform PayPal app — exactly like getTenantStripe() falls back to the
// platform Stripe — so donations keep working during rollout.
const axios = require("axios");
const { decrypt } = require("../utils/crypto");

const BASE_URLS = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

// Platform fallback creds (today's global env).
const PLATFORM = {
  clientId: process.env.PAYPAL_CLIENT_ID || "",
  clientSecret: process.env.PAYPAL_CLIENT_SECRET || "",
  baseUrl: process.env.PAYPAL_BASE_URL || BASE_URLS.sandbox,
  productId: process.env.PAYPAL_PRODUCT_ID || "",
  tenant: false,
};

/** Has the tenant configured (and enabled) their own PayPal app? */
function isPaypalConfigured(org) {
  const p = org && org.paypal;
  return !!(p && p.enabled && p.clientId && p.clientSecretEnc);
}

/**
 * Resolve the PayPal config to use for an org: the tenant's own when enabled,
 * otherwise the platform app. Returns { clientId, clientSecret, baseUrl,
 * productId, mode, tenant }.
 */
function getPaypalConfig(org) {
  if (isPaypalConfigured(org)) {
    const clientSecret = decrypt(org.paypal.clientSecretEnc);
    if (clientSecret) {
      const mode = org.paypal.mode === "live" ? "live" : "sandbox";
      return {
        clientId: org.paypal.clientId,
        clientSecret,
        baseUrl: BASE_URLS[mode],
        productId: org.paypal.productId || "",
        mode,
        tenant: true,
      };
    }
  }
  return { ...PLATFORM };
}

// Cache access tokens per clientId so we don't re-auth on every request.
// PayPal tokens last ~9h; we refresh a minute early.
const tokenCache = new Map(); // clientId → { token, exp }

/** Get an OAuth access token for the org's PayPal config (tenant or platform). */
async function getAccessToken(org) {
  const cfg = getPaypalConfig(org);
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("PayPal is not configured");
  }
  const now = Date.now();
  const cached = tokenCache.get(cfg.clientId);
  if (cached && cached.exp > now) return { token: cached.token, cfg };

  const auth = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const res = await axios.post(
    `${cfg.baseUrl}/v1/oauth2/token`,
    "grant_type=client_credentials",
    { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" } }
  );
  const token = res.data.access_token;
  const expiresInMs = (res.data.expires_in || 32400) * 1000;
  tokenCache.set(cfg.clientId, { token, exp: now + expiresInMs - 60000 });
  return { token, cfg };
}

/** Authenticated axios client bound to the org's PayPal base URL. */
async function getPaypalClient(org) {
  const { token, cfg } = await getAccessToken(org);
  const client = axios.create({
    baseURL: cfg.baseUrl,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    timeout: 20000,
  });
  return { client, cfg, token };
}

module.exports = {
  BASE_URLS,
  isPaypalConfigured,
  getPaypalConfig,
  getAccessToken,
  getPaypalClient,
};
