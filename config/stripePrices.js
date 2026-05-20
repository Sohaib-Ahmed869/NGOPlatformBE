module.exports = {
  basic: {
    monthly: process.env.STRIPE_PRICE_BASIC_MONTHLY,
    annual: process.env.STRIPE_PRICE_BASIC_ANNUAL,
  },
  professional: {
    monthly: process.env.STRIPE_PRICE_PRO_MONTHLY,
    annual: process.env.STRIPE_PRICE_PRO_ANNUAL,
  },
  enterprise: {
    monthly: process.env.STRIPE_PRICE_ENT_MONTHLY,
    annual: process.env.STRIPE_PRICE_ENT_ANNUAL,
  },
};
