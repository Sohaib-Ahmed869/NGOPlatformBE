/**
 * Canonical SaaS plan pricing — single source of truth.
 *
 * `monthly` / `annual` are the amounts (in whole currency units) that the
 * platform charges organisations for their subscription. Annual is billed
 * once per year (≈ 20% cheaper than 12× monthly).
 *
 * NOTE: these values are for display + migration logic. The amount Stripe
 * actually charges is defined by the Stripe Price objects referenced in
 * config/stripePrices.js. After changing the numbers here, run
 * `npm run prices:update` to create matching Stripe Prices and migrate
 * existing organisations.
 */
module.exports = {
  currency: "usd",
  basic: { monthly: 200, annual: 1920 },
  professional: { monthly: 500, annual: 4800 },
  enterprise: { monthly: 1000, annual: 9600 },
};
