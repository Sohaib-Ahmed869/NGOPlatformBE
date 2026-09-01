/**
 * Canonical SaaS plan pricing — single source of truth.
 *
 * `monthly` / `annual` are the amounts (in whole currency units) that the
 * platform charges organisations for their subscription. Annual is billed
 * once per year at a 20% discount on 12x monthly, and every figure below is
 * exactly that: 499 x 12 x 0.8 = 4790, 899 x 12 x 0.8 = 8630,
 * 1499 x 12 x 0.8 = 14390. Keep that relationship if you reprice — the public
 * pricing page derives the "equivalent per month" line by dividing `annual`
 * by 12 and states the discount as twenty percent.
 *
 * `onboarding` is a ONE-OFF setup charge, invoiced separately. It is not a
 * Stripe recurring Price and never appears in config/stripePrices.js.
 *
 * All amounts are AUD and quoted EXCLUDING GST.
 *
 * The entry tier's code is `essentials`. It was `basic` until the rename, which
 * touched PLAN_RANK in config/planTiers.js, planHierarchy in
 * middleware/planEnforcement.js, the `plan` default on models/organisation.js,
 * the leadConversion fallback, both plan-limit maps and every seed script — and
 * rewrote the `plan` field on existing organisations
 * (scripts/renamePlanCode.js). `basic` survives ONLY as a rank alias in those
 * two hierarchy maps, so an old ?plan=basic link or a replayed webhook still
 * resolves. Do not reintroduce it as a pricing key.
 *
 * NOTE: these values are for display + migration logic. The amount Stripe
 * actually charges is defined by the Stripe Price objects referenced in
 * config/stripePrices.js. After changing the numbers here, run
 * `npm run plans:apply -- --apply` to mint matching Stripe Prices, push the old
 * ones into priceHistory and update the Plan collection.
 */
module.exports = {
  // Platform billing currency. Overridable via PLATFORM_CURRENCY in .env.
  currency: (process.env.PLATFORM_CURRENCY || "aud").toLowerCase(),
  essentials: { monthly: 499, annual: 4790, onboarding: 1000 },
  professional: { monthly: 899, annual: 8630, onboarding: 1500 },
  enterprise: { monthly: 1499, annual: 14390, onboarding: 2500 },
};
