const Stripe = require("stripe");
const { decrypt } = require("../utils/crypto");

// The platform's own Stripe account. Two entirely separate Stripe setups exist
// in this codebase and they must not be confused:
//
//   TENANT  (Organisation.payment, admin console)  → donations, events, campaigns
//   PLATFORM (PlatformSettings.stripe, SuperAdmin) → SaaS subscription billing
//
// Their only sanctioned point of contact is the fallback below: a tenant that
// hasn't connected their own account may — if the operator allows it — process
// donations through the platform account. Everything else stays separate,
// including the webhook endpoints and their signing secrets.
//
// Resolved lazily so a key saved in the SuperAdmin console wins over
// STRIPE_SECRET_KEY without a restart.
const {
  stripe: platformStripe,
  isTenantFallbackAllowed,
  getPublishableKey: getPlatformPublishableKey,
} = require("./platformStripe");

// Cache Stripe clients by secret so we don't rebuild one per request.
const clientCache = new Map();

/** Has the tenant configured (and enabled) their own Stripe account? */
function isPaymentConfigured(org) {
  return !!(org && org.payment && org.payment.enabled && org.payment.secretKeyEnc);
}

/**
 * A stand-in client that fails loudly with a message naming the fix. Mirrors the
 * platform proxy's behaviour: returning null here would surface much later as
 * "cannot read property 'paymentIntents' of null", which says nothing useful.
 */
function deniedClient(message) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined; // don't look like a thenable
        throw new Error(message);
      },
      has() {
        return false;
      },
    },
  );
}

const NO_TENANT_ACCOUNT =
  "This organisation has not connected a Stripe account, and the platform " +
  "account is not available for tenant donations. Connect Stripe under " +
  "Settings → Payments to accept card payments.";

/**
 * Which account processes THIS tenant's donations.
 *   "tenant"   — the tenant's own connected account
 *   "platform" — the platform account, via the operator-enabled fallback
 *   "none"     — nothing available; card payments cannot be taken
 *
 * The public site reads this (through getBySlug) so the browser mounts Stripe
 * Elements with the publishable key belonging to whichever account will actually
 * confirm the payment. Deciding it here, once, is what stops the client and the
 * server ever disagreeing about which account is in play.
 */
function getDonationSource(org) {
  if (isPaymentConfigured(org)) return "tenant";
  return isTenantFallbackAllowed() ? "platform" : "none";
}

/**
 * Stripe client for a tenant's donation processing.
 * The tenant's own client when configured + enabled, otherwise the platform
 * client — but only while the operator permits that fallback.
 */
function getTenantStripe(org) {
  if (isPaymentConfigured(org)) {
    const secret = decrypt(org.payment.secretKeyEnc);
    if (secret) {
      if (!clientCache.has(secret)) clientCache.set(secret, Stripe(secret));
      return clientCache.get(secret);
    }
  }
  if (!isTenantFallbackAllowed()) return deniedClient(NO_TENANT_ACCOUNT);
  return platformStripe;
}

/**
 * The publishable key that pairs with whatever getTenantStripe() will use, so a
 * checkout page can never load Elements against a different account (or a
 * different test/live mode) than the one confirming the charge.
 */
function getDonationPublishableKey(org) {
  const source = getDonationSource(org);
  if (source === "tenant") return org.payment.publishableKey || "";
  if (source === "platform") return getPlatformPublishableKey();
  return "";
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
  getDonationSource,
  getDonationPublishableKey,
  platformStripe,
};
