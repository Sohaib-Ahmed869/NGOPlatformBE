const Stripe = require("stripe");
const { decrypt } = require("../utils/crypto");

/**
 * The PLATFORM's own Stripe account — the one that bills tenants for their SaaS
 * subscription (and acts as the donation fallback for tenants who haven't
 * configured their own keys). This is the platform-level counterpart to
 * services/tenantStripe.js.
 *
 * Credentials resolve in this order:
 *   1. PlatformSettings.stripe   (saved by the superadmin in the console, AES-GCM encrypted)
 *   2. process.env.STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET
 *
 * Two things to know about the exported `stripe` object:
 *
 * - It is a PROXY, not a client. Every property access resolves the currently
 *   active client, so the ~10 call sites that used to hold a module-scope
 *   `require("stripe")(process.env.STRIPE_SECRET_KEY)` pick up a newly saved key
 *   without a restart. They keep their existing `stripe.customers.create(...)`
 *   syntax verbatim.
 *
 * - Construction is DEFERRED. `Stripe(undefined)` throws, so those module-scope
 *   clients meant the whole server failed to boot when STRIPE_SECRET_KEY was
 *   missing — which made the "configure Stripe in the UI" flow impossible, since
 *   you could never reach the UI to configure it. The proxy only builds a client
 *   when a request actually needs one, and throws a message that names the fix.
 *
 * Never log or return a decrypted secret from here.
 */

let _client = null; // active Stripe client (built lazily)
let _secret = ""; // the secret the active client was built from
let _source = "none"; // "database" | "env" | "none"
// The SAAS BILLING webhook signing secret (the endpoint at
// /api/saas/webhooks/stripe). Deliberately NOT the donation webhook secret:
// those are two different Stripe endpoints with two different signing secrets,
// and feeding one to the other fails verification on every event.
let _saasWebhookSecret = "";
let _webhookSource = "none";
let _primed = false; // has the DB config been read at least once?
// The publishable half of the stored key pair. Held here so the public config
// endpoint can serve the key the running server is ACTUALLY paired with — a
// pk_ served from anywhere else can drift out of test/live step with the sk_.
// Empty while running on env credentials: the browser has its own build-time
// VITE_STRIPE_PUBLISHABLE_KEY for exactly that case, and "" is what tells it so.
let _publishableKey = "";
// May tenants without their own Stripe account fall back to this one for
// donations? Mirrors PlatformSettings.stripe.allowTenantFallback, defaulting to
// true so an env-configured platform keeps its long-standing behaviour.
let _allowTenantFallback = true;

function envSecret() {
  return (process.env.STRIPE_SECRET_KEY || "").trim();
}

function envSaasWebhook() {
  return (process.env.STRIPE_SAAS_WEBHOOK_SECRET || "").trim();
}

/** Point the module at a secret, rebuilding the client only when it changed. */
function adopt(secret, source) {
  const next = (secret || "").trim();
  if (next === _secret) {
    _source = next ? source : "none";
    return;
  }
  _secret = next;
  _client = next ? Stripe(next) : null;
  _source = next ? source : "none";
}

/**
 * Read the stored config into module state. Called once at boot and again after
 * every save, so the resolution order above is honoured without a DB hit per
 * request. Falls back to env on any failure — a database blip must never take
 * SaaS billing offline.
 */
async function refresh() {
  try {
    // Required lazily: this service is pulled in by controllers that load before
    // Mongoose models are registered.
    const PlatformSettings = require("../models/platformSettings");
    const s = await PlatformSettings.findOne({ key: "platform" }).select("stripe").lean();
    const cfg = s?.stripe;

    // The tenant-fallback POLICY is read whether or not this document's KEY is
    // the one we end up using. They are separate decisions: an operator running
    // on STRIPE_SECRET_KEY can still say "tenants must bring their own Stripe",
    // and gating the policy on the key's source would silently ignore that
    // switch while the console went on showing it as off.
    _allowTenantFallback = cfg ? cfg.allowTenantFallback !== false : true;

    if (cfg?.enabled && cfg.secretKeyEnc) {
      const secret = decrypt(cfg.secretKeyEnc);
      if (secret) {
        adopt(secret, "database");
        const hook = cfg.webhookSecretEnc ? decrypt(cfg.webhookSecretEnc) : "";
        _saasWebhookSecret = hook;
        _webhookSource = hook ? "database" : envSaasWebhook() ? "env" : "none";
        _publishableKey = (cfg.publishableKey || "").trim();
        _primed = true;
        return;
      }
      // Enabled but undecryptable — almost always PAYMENT_ENC_KEY/JWT_SECRET
      // changed after the key was saved. Say so; falling through to env silently
      // would look like the saved key is simply being ignored.
      console.error(
        "[platformStripe] Stored secret key could not be decrypted (PAYMENT_ENC_KEY may have changed). Falling back to env.",
      );
    }
  } catch (err) {
    console.error("[platformStripe] Could not read stored config, using env:", err.message);
  }

  adopt(envSecret(), "env");
  _saasWebhookSecret = "";
  _webhookSource = envSaasWebhook() ? "env" : "none";
  // No stored pair to publish: the client uses its own env publishable key, and
  // "" is the signal telling it to. _allowTenantFallback is deliberately left as
  // read above — it is a policy, not half of a key pair.
  _publishableKey = "";
  _primed = true;
}

/** Re-read the stored config (after a save). Returns the refresh promise. */
function invalidate() {
  return refresh();
}

/** Warm the cache at server boot so the very first request is already resolved. */
function prime() {
  return refresh();
}

/**
 * The active client, or null when nothing is configured. Synchronous: before
 * prime() resolves it uses env, which is exactly the pre-existing behaviour.
 */
function activeClient() {
  if (!_primed && !_client) adopt(envSecret(), "env");
  return _client;
}

/** Is a platform Stripe key available from either source? */
function isStripeConfigured() {
  return !!activeClient();
}

/**
 * Signing secret for the SaaS billing webhook (/api/saas/webhooks/stripe).
 * Stored value wins, else STRIPE_SAAS_WEBHOOK_SECRET. "" when neither is set.
 */
function getSaasWebhookSecret() {
  return _saasWebhookSecret || envSaasWebhook();
}

/**
 * The secret key currently in use, whatever its source. The config screen's
 * "Test connection" needs this: without it the test only ever saw a key stored
 * in the database, so a platform running perfectly well on STRIPE_SECRET_KEY
 * was told "no secret key to test — enter or save one first".
 *
 * Callers must never return this to a client.
 */
function activeSecret() {
  activeClient(); // ensure the env fallback has been adopted
  return _secret || "";
}

/**
 * The publishable key paired with the ACTIVE secret key, or "" when the platform
 * is running on env credentials (in which case the client falls back to its own
 * VITE_STRIPE_PUBLISHABLE_KEY — the same fallback the server just made).
 *
 * Safe to serve publicly: a pk_ is designed to ship in browser JS. It is served
 * from here rather than straight off the document so it can never name a key
 * from a different Stripe mode than the one actually charging the card.
 */
function getPublishableKey() {
  activeClient(); // ensure the env fallback has been adopted
  return _source === "database" ? _publishableKey : "";
}

/**
 * May a tenant with no Stripe account of their own process donations through the
 * PLATFORM account? This is the one sanctioned bridge between the two otherwise
 * independent Stripe setups — see services/tenantStripe.js.
 */
function isTenantFallbackAllowed() {
  activeClient();
  return _allowTenantFallback;
}

/** Where the active credentials came from — for the config screen's status line. */
function describeSource() {
  return {
    secretSource: _source,
    webhookSource: _webhookSource,
    configured: !!_client,
    // Mode is inferred from the key itself, so it can't drift from what's in use.
    mode: _secret.includes("_live_") ? "live" : _secret ? "test" : null,
  };
}

const NOT_CONFIGURED =
  "Stripe is not configured. Add a secret key in the SuperAdmin console under Platform Settings → Stripe, or set STRIPE_SECRET_KEY.";

/**
 * Drop-in replacement for a Stripe client. Resolves the active client on every
 * property access so a key saved in the console takes effect immediately.
 */
const stripe = new Proxy(
  {},
  {
    get(_target, prop) {
      const client = activeClient();
      if (!client) {
        // `await stripe.x()` on an unconfigured platform should fail loudly with
        // a message that names the fix, not with "cannot read property of null".
        if (prop === "then") return undefined; // don't look like a thenable
        throw new Error(NOT_CONFIGURED);
      }
      const value = client[prop];
      return typeof value === "function" ? value.bind(client) : value;
    },
    has(_target, prop) {
      const client = activeClient();
      return client ? prop in client : false;
    },
  },
);

module.exports = {
  stripe,
  platformStripe: stripe, // alias matching services/tenantStripe.js
  isStripeConfigured,
  getPublishableKey,
  isTenantFallbackAllowed,
  getSaasWebhookSecret,
  describeSource,
  activeSecret,
  invalidate,
  prime,
};
