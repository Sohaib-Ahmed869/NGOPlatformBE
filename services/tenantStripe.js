const Stripe = require("stripe");
const { decrypt } = require("../utils/crypto");

// The platform's own Stripe account — used for SaaS billing and as a safe
// fallback for tenants that haven't configured their own keys yet (preserves
// the current donation behaviour during the rollout).
const platformStripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Cache Stripe clients by secret so we don't rebuild one per request.
const clientCache = new Map();

/** Has the tenant configured (and enabled) their own Stripe account? */
function isPaymentConfigured(org) {
  return !!(org && org.payment && org.payment.enabled && org.payment.secretKeyEnc);
}

/**
 * Stripe client for a tenant's donation processing.
 * Returns the tenant's own client when configured + enabled, otherwise the
 * platform client (so unconfigured tenants keep working).
 */
function getTenantStripe(org) {
  if (isPaymentConfigured(org)) {
    const secret = decrypt(org.payment.secretKeyEnc);
    if (secret) {
      if (!clientCache.has(secret)) clientCache.set(secret, Stripe(secret));
      return clientCache.get(secret);
    }
  }
  return platformStripe;
}

/** The tenant's webhook signing secret (decrypted), or "" if not set. */
function getTenantWebhookSecret(org) {
  if (org && org.payment && org.payment.webhookSecretEnc) {
    return decrypt(org.payment.webhookSecretEnc);
  }
  return "";
}

module.exports = {
  getTenantStripe,
  getTenantWebhookSecret,
  isPaymentConfigured,
  platformStripe,
};
