// services/stripeCustomers.js
//
// One place to work out WHICH Stripe customer a donor's card can be charged on.
//
// Stripe customer ids are scoped to a single Stripe account, so a stored id goes
// stale whenever the customer is deleted in the dashboard, the tenant swaps
// their Stripe keys, or a card saved on the platform account is replayed against
// the tenant's. The charge then dies with:
//     StripeInvalidRequestError: No such customer: 'cus_...'
// Every id here is therefore treated as a HINT: verified against Stripe before
// use, and healed in our DB when it turns out to be wrong.
const PaymentMethod = require("../models/paymentMethods");
const User = require("../models/user");

/** Does this id still point at a live (non-deleted) customer on this account? */
async function customerIsLive(stripe, customerId) {
  if (!customerId) return false;
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return !!customer && !customer.deleted;
  } catch {
    return false; // missing on this account (or a different account's id)
  }
}

/** The donor's customer on this Stripe account — reused if live, else created. */
async function ensureDonorCustomer(stripe, user, organisationId) {
  if (await customerIsLive(stripe, user.stripeCustomerId)) return user.stripeCustomerId;

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: {
      userId: String(user._id),
      organisationId: String(organisationId || user.organisationId || ""),
    },
  });
  await User.updateOne({ _id: user._id }, { $set: { stripeCustomerId: customer.id } });
  user.stripeCustomerId = customer.id; // keep the caller's copy in sync
  return customer.id;
}

/** Repoint the donor + their saved-card rows at the customer we actually used. */
async function healSavedCardCustomer({ userId, paymentMethodId, customerId }) {
  if (!userId || !customerId) return;
  await PaymentMethod.updateMany(
    { user: userId, ...(paymentMethodId ? { stripePaymentMethodId: paymentMethodId } : {}) },
    { $set: { stripeCustomerId: customerId } },
  );
  await User.updateOne({ _id: userId }, { $set: { stripeCustomerId: customerId } });
}

/**
 * Resolve the customer to charge a payment method on, repairing stale data.
 *
 * @param {object}  stripe                the TENANT's Stripe client
 * @param {string}  opts.paymentMethodId  the PM being charged
 * @param {string}  [opts.requestedCustomerId] customer id the client claimed
 * @param {object}  [opts.user]           donor User doc (needed to re-vault)
 * @param {string}  [opts.organisationId]
 * @returns {Promise<string|null>} customer id, or null to charge card-only
 * @throws  {Error}  friendly message when the card itself is unusable
 */
async function resolveChargeCustomer(
  stripe,
  { paymentMethodId, requestedCustomerId, user, organisationId },
) {
  let pm;
  try {
    pm = await stripe.paymentMethods.retrieve(paymentMethodId);
  } catch {
    throw new Error(
      "This card is no longer available on our payment provider. Please re-enter your card details.",
    );
  }

  // 1. Attached to a live customer → Stripe accepts THAT customer and no other.
  if (pm.customer && (await customerIsLive(stripe, pm.customer))) {
    if (user && pm.customer !== requestedCustomerId) {
      await healSavedCardCustomer({ userId: user._id, paymentMethodId, customerId: pm.customer });
    }
    return pm.customer;
  }

  // 2. Fresh, unattached card and no saved-card claim → plain one-off charge.
  if (!requestedCustomerId) return null;

  // 3. Saved card whose customer is gone. Re-vault it under a live customer so
  //    the donation still goes through instead of 400-ing on "No such customer".
  if (!user) {
    // Anonymous checkout: the id we were handed is unusable — charge card-only
    // when the PM is free, otherwise it is stuck on a dead customer.
    return pm.customer ? await reattach(stripe, paymentMethodId, null) : null;
  }

  const customerId = await ensureDonorCustomer(stripe, user, organisationId);
  if (pm.customer !== customerId) {
    try {
      await reattach(stripe, paymentMethodId, customerId);
    } catch (e) {
      // Stripe permanently burns a payment method once it has been detached
      // ("may not be used again"), which is what deleting its customer does.
      // Retire the row so the dead card stops showing up at checkout.
      await PaymentMethod.updateMany(
        { user: user._id, stripePaymentMethodId: paymentMethodId },
        { $set: { isActive: false, isDefault: false } },
      );
      const dead = await PaymentMethod.find({
        user: user._id,
        stripePaymentMethodId: paymentMethodId,
      }).select("_id");
      if (dead.length) {
        await User.updateOne(
          { _id: user._id, defaultPaymentMethod: { $in: dead.map((d) => d._id) } },
          { $unset: { defaultPaymentMethod: 1 } },
        );
      }
      throw e;
    }
  }
  await healSavedCardCustomer({ userId: user._id, paymentMethodId, customerId });
  return customerId;
}

/**
 * Attach a PM to `customerId`, detaching it from a dead customer first if the
 * direct attach is refused. Returns the customer id actually in force (null when
 * the PM was freed but not re-attached). Link PMs can't move between customers,
 * so an unrecoverable case surfaces as a re-enter-your-card message.
 */
async function reattach(stripe, paymentMethodId, customerId) {
  try {
    if (customerId) {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
      return customerId;
    }
    await stripe.paymentMethods.detach(paymentMethodId);
    return null;
  } catch {
    try {
      await stripe.paymentMethods.detach(paymentMethodId);
      if (!customerId) return null;
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
      return customerId;
    } catch {
      throw new Error(
        "This card is no longer valid. Please remove it and add your card again.",
      );
    }
  }
}

module.exports = {
  customerIsLive,
  ensureDonorCustomer,
  healSavedCardCustomer,
  resolveChargeCustomer,
};
