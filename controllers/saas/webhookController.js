const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const Organisation = require("../../models/organisation");
const User = require("../../models/user");
const { sendEmail } = require("../../services/emailUtil");

/**
 * POST /api/saas/webhooks/stripe
 * Handle Stripe webhook events for SaaS subscriptions.
 * Uses STRIPE_SAAS_WEBHOOK_SECRET (separate from donation webhook secret).
 */
exports.handleWebhook = async (req, res) => {
  const signature = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_SAAS_WEBHOOK_SECRET;
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, endpointSecret);
  } catch (err) {
    console.error(`SaaS webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    console.log(`Processing SaaS webhook event: ${event.type}`);

    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event.data.object);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object);
        break;
      case "invoice.payment_failed":
        await handlePaymentFailed(event.data.object);
        break;
      default:
        console.log(`Unhandled SaaS webhook event: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error("SaaS webhook handler error:", error);
    res.status(500).json({ error: "Webhook handler failed" });
  }
};

/**
 * Handle checkout.session.completed
 * Creates admin user, activates organisation, sends welcome email.
 */
async function handleCheckoutCompleted(session) {
  const metadata = session.metadata;

  // Only process SaaS subscription checkouts
  if (metadata?.type !== "saas_subscription") {
    console.log("Skipping non-SaaS checkout session");
    return;
  }

  const { orgId, adminName, adminEmail, hashedPassword, plan, billingCycle } = metadata;

  const organisation = await Organisation.findById(orgId);
  if (!organisation) {
    console.error(`Organisation not found for ID: ${orgId}`);
    return;
  }

  // Create admin user for the organisation
  const adminUser = await User.create({
    name: adminName,
    email: adminEmail.toLowerCase(),
    password: hashedPassword,
    role: "admin",
    organisationId: organisation._id,
  });

  // Activate the organisation
  organisation.isActive = true;
  organisation.subscriptionStatus = "active";
  organisation.stripeSubscriptionId = session.subscription;
  organisation.adminUserId = adminUser._id;
  await organisation.save();

  // Send welcome email
  const subdomainUrl = process.env.CLIENT_URL
    ? `${organisation.slug}.${process.env.CLIENT_URL.replace(/^https?:\/\//, "")}`
    : `${organisation.slug}.localhost:5173`;

  const emailBody = `
    <h2>Welcome to the Platform, ${adminName}!</h2>
    <p>Your organisation <strong>${organisation.name}</strong> has been set up successfully.</p>
    <p>Your portal is ready at: <a href="http://${subdomainUrl}">http://${subdomainUrl}</a></p>
    <h3>Your Admin Account</h3>
    <ul>
      <li><strong>Email:</strong> ${adminEmail}</li>
      <li><strong>Plan:</strong> ${plan}</li>
      <li><strong>Billing:</strong> ${billingCycle}</li>
    </ul>
    <p>Log in to your admin dashboard at <a href="http://${subdomainUrl}/admin/login">http://${subdomainUrl}/admin/login</a> to start setting up your portal.</p>
  `;

  await sendEmail(adminEmail, emailBody, `Welcome to ${organisation.name} - Your Portal is Ready!`);

  console.log(`Organisation ${organisation.slug} activated successfully`);
}

/**
 * Handle customer.subscription.updated
 * Syncs subscription status changes from Stripe.
 */
async function handleSubscriptionUpdated(subscription) {
  const organisation = await Organisation.findOne({
    stripeSubscriptionId: subscription.id,
  });

  if (!organisation) {
    console.log(`No organisation found for subscription: ${subscription.id}`);
    return;
  }

  // Map Stripe status to our status
  const statusMap = {
    active: "active",
    past_due: "past_due",
    canceled: "cancelled",
    unpaid: "past_due",
    incomplete: "pending",
    incomplete_expired: "cancelled",
    trialing: "active",
    paused: "past_due",
  };

  const newStatus = statusMap[subscription.status] || "pending";
  organisation.subscriptionStatus = newStatus;
  organisation.isActive = newStatus === "active";
  await organisation.save();

  console.log(`Organisation ${organisation.slug} status updated to ${newStatus}`);
}

/**
 * Handle customer.subscription.deleted
 * Deactivates the organisation.
 */
async function handleSubscriptionDeleted(subscription) {
  const organisation = await Organisation.findOne({
    stripeSubscriptionId: subscription.id,
  });

  if (!organisation) {
    console.log(`No organisation found for deleted subscription: ${subscription.id}`);
    return;
  }

  organisation.subscriptionStatus = "cancelled";
  organisation.isActive = false;
  await organisation.save();

  // Notify admin
  if (organisation.adminUserId) {
    const admin = await User.findById(organisation.adminUserId);
    if (admin) {
      const emailBody = `
        <h2>Subscription Cancelled</h2>
        <p>Your subscription for <strong>${organisation.name}</strong> has been cancelled.</p>
        <p>Your portal will be deactivated. To reactivate, please subscribe again.</p>
      `;
      await sendEmail(admin.email, emailBody, `${organisation.name} - Subscription Cancelled`);
    }
  }

  console.log(`Organisation ${organisation.slug} deactivated (subscription deleted)`);
}

/**
 * Handle invoice.payment_failed
 * Marks organisation subscription as past_due.
 */
async function handlePaymentFailed(invoice) {
  const organisation = await Organisation.findOne({
    stripeCustomerId: invoice.customer,
  });

  if (!organisation) {
    console.log(`No organisation found for customer: ${invoice.customer}`);
    return;
  }

  organisation.subscriptionStatus = "past_due";
  await organisation.save();

  // Notify admin about failed payment
  if (organisation.adminUserId) {
    const admin = await User.findById(organisation.adminUserId);
    if (admin) {
      const emailBody = `
        <h2>Payment Failed</h2>
        <p>We were unable to process the payment for your <strong>${organisation.name}</strong> subscription.</p>
        <p>Please update your payment method to avoid service interruption.</p>
      `;
      await sendEmail(admin.email, emailBody, `${organisation.name} - Payment Failed`);
    }
  }

  console.log(`Organisation ${organisation.slug} marked as past_due (payment failed)`);
}
