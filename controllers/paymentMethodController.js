// controllers/paymentMethodController.js
//
// Saved cards are stored the PCI-compliant way: the raw card never touches our
// server. The browser tokenises it with Stripe (SetupIntent + Elements) and we
// only keep the Stripe paymentMethod id + brand/last4/expiry. Cards are vaulted
// on the donor's Stripe customer on the *tenant's* Stripe account, so they can
// be charged again at checkout.
const PaymentMethod = require("../models/paymentMethods");
const User = require("../models/user");
const { getTenantStripe } = require("../services/tenantStripe");

const KNOWN_BRANDS = ["visa", "mastercard", "amex", "discover"];

// Ensure the donor has a (valid) Stripe customer on the tenant's account.
async function ensureCustomer(req, stripe) {
  const user = await User.findById(req.user._id);
  if (!user) throw new Error("User not found");

  if (user.stripeCustomerId) {
    try {
      const c = await stripe.customers.retrieve(user.stripeCustomerId);
      if (c && !c.deleted) return user.stripeCustomerId;
    } catch {
      // Stale id (e.g. tenant switched Stripe accounts) — fall through + recreate.
    }
  }
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: {
      userId: String(user._id),
      organisationId: String(req.organisation?._id || ""),
    },
  });
  user.stripeCustomerId = customer.id;
  await user.save();
  return customer.id;
}

// Public shape (never leak internals beyond what the UI needs).
const shape = (pm) => ({
  _id: pm._id,
  type: pm.type,
  brand: pm.brand || pm.cardType || "card",
  cardNumber: pm.cardNumber, // last4
  expiryMonth: pm.expiryMonth,
  expiryYear: pm.expiryYear,
  isDefault: pm.isDefault,
  stripePaymentMethodId: pm.stripePaymentMethodId,
  stripeCustomerId: pm.stripeCustomerId,
});

/**
 * POST /payment-methods/setup-intent
 * Start saving a card — returns a SetupIntent client secret the browser uses
 * with Stripe Elements (stripe.confirmSetup). The card goes straight to Stripe.
 */
exports.createSetupIntent = async (req, res) => {
  try {
    const stripe = getTenantStripe(req.organisation);
    const customerId = await ensureCustomer(req, stripe);
    // Card-only so the saved payment method always has card metadata
    // (brand/last4/expiry). automatic_payment_methods could yield a Link/wallet
    // PM with no `card` hash → "Card ••••  Expires undefined".
    const intent = await stripe.setupIntents.create({
      customer: customerId,
      usage: "off_session",
      payment_method_types: ["card"],
    });
    res.json({ status: "Success", clientSecret: intent.client_secret });
  } catch (error) {
    console.error("createSetupIntent error:", error.message);
    res.status(400).json({ status: "Error", message: "Failed to start card setup", error: error.message });
  }
};

/**
 * POST /payment-methods   { paymentMethodId, isDefault }
 * Persist a card AFTER the SetupIntent confirmed in the browser. Card details
 * are read back from Stripe — we never trust the client for them.
 */
exports.addPaymentMethod = async (req, res) => {
  try {
    const { paymentMethodId, isDefault } = req.body;
    if (!paymentMethodId) {
      return res.status(400).json({ status: "Error", message: "Missing payment method" });
    }

    const stripe = getTenantStripe(req.organisation);
    const customerId = await ensureCustomer(req, stripe);

    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    // Attach to the customer if it isn't already (SetupIntent usually does this).
    if (!pm.customer) {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    } else if (pm.customer !== customerId) {
      return res.status(400).json({ status: "Error", message: "This card belongs to another account" });
    }

    const card = pm.card || {};

    if (isDefault) {
      await PaymentMethod.updateMany({ user: req.user._id }, { isDefault: false });
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    }

    const fields = {
      user: req.user._id,
      organisationId: req.organisation?._id || null,
      type: "credit_card",
      stripePaymentMethodId: paymentMethodId,
      stripeCustomerId: customerId,
      brand: card.brand || "",
      cardType: KNOWN_BRANDS.includes(card.brand) ? card.brand : undefined,
      cardNumber: card.last4,
      expiryMonth: card.exp_month,
      expiryYear: card.exp_year,
      isActive: true,
      isDefault: !!isDefault,
    };

    // Upsert by Stripe PM id so re-saving the same card doesn't duplicate.
    const record = await PaymentMethod.findOneAndUpdate(
      { user: req.user._id, stripePaymentMethodId: paymentMethodId },
      { $set: fields },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    if (isDefault) {
      await User.findByIdAndUpdate(req.user._id, { defaultPaymentMethod: record._id });
    }

    res.status(201).json({ status: "Success", message: "Card saved", paymentMethod: shape(record) });
  } catch (error) {
    console.error("addPaymentMethod error:", error.message);
    res.status(400).json({ status: "Error", message: "Failed to save card", error: error.message });
  }
};

/** GET /payment-methods — the donor's saved cards (default first, newest next). */
exports.getPaymentMethods = async (req, res) => {
  try {
    const filter = { user: req.user._id, isActive: true };
    if (req.organisation?._id) filter.organisationId = req.organisation._id;
    const docs = await PaymentMethod.find(filter).sort({ isDefault: -1, createdAt: -1 });

    // Self-heal records saved before card metadata was captured (e.g. old rows
    // or a non-card PM): pull brand/last4/expiry from Stripe once.
    const incomplete = docs.filter((d) => d.stripePaymentMethodId && (!d.cardNumber || !d.brand));
    if (incomplete.length) {
      const stripe = getTenantStripe(req.organisation);
      await Promise.all(
        incomplete.map(async (d) => {
          try {
            const pm = await stripe.paymentMethods.retrieve(d.stripePaymentMethodId);
            const card = pm.card || {};
            if (card.last4) {
              d.brand = card.brand || d.brand;
              d.cardNumber = card.last4;
              d.expiryMonth = card.exp_month;
              d.expiryYear = card.exp_year;
              if (KNOWN_BRANDS.includes(card.brand)) d.cardType = card.brand;
              await d.save();
            }
          } catch {
            /* PM gone / not a card — leave as-is, the UI degrades gracefully */
          }
        }),
      );
    }

    res.json({ status: "Success", paymentMethods: docs.map(shape) });
  } catch (error) {
    res.status(400).json({ status: "Error", message: "Failed to fetch payment methods", error: error.message });
  }
};

/** DELETE /payment-methods/:id — detach from Stripe + soft delete. */
exports.deletePaymentMethod = async (req, res) => {
  try {
    const { id } = req.params;
    const pm = await PaymentMethod.findOne({ _id: id, user: req.user._id });
    if (!pm) return res.status(404).json({ status: "Error", message: "Card not found" });

    if (pm.stripePaymentMethodId) {
      try {
        const stripe = getTenantStripe(req.organisation);
        await stripe.paymentMethods.detach(pm.stripePaymentMethodId);
      } catch (e) {
        // Already detached / not found — fine, continue with the soft delete.
        console.error("detach payment method:", e.message);
      }
    }

    pm.isActive = false;
    pm.isDefault = false;
    await pm.save();

    res.json({ status: "Success", message: "Card removed" });
  } catch (error) {
    res.status(400).json({ status: "Error", message: "Failed to delete payment method", error: error.message });
  }
};

/** PATCH /payment-methods/:id/default — set the default card (also in Stripe). */
exports.setDefaultPaymentMethod = async (req, res) => {
  try {
    const { id } = req.params;
    const target = await PaymentMethod.findOne({ _id: id, user: req.user._id, isActive: true });
    if (!target) return res.status(404).json({ status: "Error", message: "Card not found" });

    await PaymentMethod.updateMany({ user: req.user._id }, { isDefault: false });
    target.isDefault = true;
    await target.save();

    if (target.stripeCustomerId && target.stripePaymentMethodId) {
      try {
        const stripe = getTenantStripe(req.organisation);
        await stripe.customers.update(target.stripeCustomerId, {
          invoice_settings: { default_payment_method: target.stripePaymentMethodId },
        });
      } catch (e) {
        console.error("set default on Stripe customer:", e.message);
      }
    }

    await User.findByIdAndUpdate(req.user._id, { defaultPaymentMethod: target._id });

    res.json({ status: "Success", message: "Default card updated", paymentMethod: shape(target) });
  } catch (error) {
    res.status(400).json({ status: "Error", message: "Failed to update default payment method", error: error.message });
  }
};
