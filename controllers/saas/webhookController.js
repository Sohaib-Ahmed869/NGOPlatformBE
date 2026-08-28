const { stripe, getSaasWebhookSecret } = require("../../services/platformStripe");
const Organisation = require("../../models/organisation");
const User = require("../../models/user");
const StripeEvent = require("../../models/stripeEvent");
const PlatformInvoice = require("../../models/platformInvoice");
const { sendTemplateEmail } = require("../../services/emailUtil");
const { platformAppUrl } = require("../../utils/tenantUrls");
const { activateOrgWithAdmin } = require("../../services/orgActivation");
const { emitToSuperAdmins } = require("../../services/socket");

/**
 * POST /api/saas/webhooks/stripe
 * Handle Stripe webhook events for SaaS subscriptions.
 * Signing secret comes from the SuperAdmin console (Platform Settings → Stripe),
 * falling back to STRIPE_SAAS_WEBHOOK_SECRET. Separate from the donation webhook
 * secret — they are different Stripe endpoints with different signing secrets.
 */
exports.handleWebhook = async (req, res) => {
  const signature = req.headers["stripe-signature"];
  const endpointSecret = getSaasWebhookSecret();
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, endpointSecret);
  } catch (err) {
    console.error(`SaaS webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency — record the event id first; a duplicate means Stripe retried an
  // event we already processed, so skip it.
  let recorded = false;
  try {
    await StripeEvent.create({ eventId: event.id, type: event.type });
    recorded = true;
  } catch (e) {
    if (e.code === 11000) {
      return res.json({ received: true, duplicate: true });
    }
    console.error("StripeEvent insert error:", e.message);
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
      case "invoice.paid":
      case "invoice.payment_succeeded":
        await handleInvoicePaid(event.data.object);
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
    // Let Stripe retry: remove the idempotency record so the retry reprocesses.
    if (recorded) {
      try {
        await StripeEvent.deleteOne({ eventId: event.id });
      } catch {
        /* ignore */
      }
    }
    res.status(500).json({ error: "Webhook handler failed" });
  }
};

// Find the org an invoice belongs to (by subscription, then by customer).
async function findOrgForInvoice(invoice) {
  const or = [];
  if (invoice.subscription) or.push({ stripeSubscriptionId: invoice.subscription });
  if (invoice.customer) or.push({ stripeCustomerId: invoice.customer });
  if (!or.length) return null;
  return Organisation.findOne({ $or: or });
}

// Upsert the local mirror row for a Stripe invoice.
async function upsertInvoice(invoice, organisation, status) {
  await PlatformInvoice.findOneAndUpdate(
    { stripeInvoiceId: invoice.id },
    {
      $set: {
        organisationId: organisation?._id || null,
        stripeCustomerId: invoice.customer || "",
        stripeSubscriptionId: invoice.subscription || "",
        number: invoice.number || "",
        amountDue: (invoice.amount_due || 0) / 100,
        amountPaid: (invoice.amount_paid || 0) / 100,
        currency: invoice.currency || "usd",
        status: status || invoice.status || "open",
        hostedInvoiceUrl: invoice.hosted_invoice_url || "",
        invoicePdf: invoice.invoice_pdf || "",
        periodStart: invoice.period_start ? new Date(invoice.period_start * 1000) : null,
        periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000) : null,
        paidAt: status === "paid" ? new Date() : null,
      },
    },
    { upsert: true, new: true }
  );
  // The Invoices screen caches its pages — tell open consoles to revalidate.
  emitToSuperAdmins("invoice:updated", { stripeInvoiceId: invoice.id, status });
}

/**
 * Handle invoice.paid / invoice.payment_succeeded — mirror the invoice, and on the
 * FIRST successful payment create the admin + activate the org (in-house checkout).
 */
async function handleInvoicePaid(invoice) {
  const organisation = await findOrgForInvoice(invoice);
  await upsertInvoice(invoice, organisation, "paid");
  if (organisation && (!organisation.isActive || organisation.subscriptionStatus !== "active")) {
    await activateOrgWithAdmin(organisation, {
      subscriptionId: invoice.subscription || organisation.stripeSubscriptionId,
      customerId: invoice.customer || organisation.stripeCustomerId,
    });
  }
  // The mirrored invoice shows in the operator console — nudge open screens.
  if (organisation) emitToSuperAdmins("organisation:updated", { organisationId: String(organisation._id) });
  console.log(`Invoice ${invoice.id} mirrored (paid) for ${organisation?.slug || "unknown org"}`);
}

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
  organisation.stripeCustomerId = session.customer || organisation.stripeCustomerId;
  organisation.adminUserId = adminUser._id;
  await organisation.save();
  emitToSuperAdmins("organisation:updated", { organisationId: String(organisation._id) });

  // Send welcome email
  const subdomainUrl = process.env.CLIENT_URL
    ? `${organisation.slug}.${process.env.CLIENT_URL.replace(/^https?:\/\//, "")}`
    : `${organisation.slug}.${process.env.CORS_DOMAIN || "localhost"}`;

  await sendTemplateEmail("tenant.welcome", {
    to: adminEmail,
    data: {
      recipient: { name: adminName, email: adminEmail },
      tenant: {
        name: organisation.name,
        portalUrl: `http://${subdomainUrl}`,
        loginUrl: `http://${subdomainUrl}/admin/login`,
        adminEmail,
        plan,
        billingCycle,
        // This path creates the admin with a password chosen at signup, so
        // there is nothing to reveal and no set-password link to send.
        password: "",
        setPasswordUrl: "",
      },
    },
    meta: { organisationId: String(organisation._id), slug: organisation.slug },
  });

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

  // First time the subscription becomes active → create admin + activate (the
  // in-house checkout's PaymentIntent succeeding fires this and/or invoice.paid).
  if (newStatus === "active" && !organisation.adminUserId) {
    await activateOrgWithAdmin(organisation, { subscriptionId: subscription.id, customerId: subscription.customer });
    console.log(`Organisation ${organisation.slug} activated via subscription.updated`);
    return;
  }

  organisation.subscriptionStatus = newStatus;
  organisation.isActive = newStatus === "active";
  await organisation.save();
  emitToSuperAdmins("organisation:updated", { organisationId: String(organisation._id) });

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
  emitToSuperAdmins("organisation:updated", { organisationId: String(organisation._id) });

  // Notify admin
  if (organisation.adminUserId) {
    const admin = await User.findById(organisation.adminUserId);
    if (admin) {
      await sendTemplateEmail("tenant.subscriptionCancelled", {
        to: admin.email,
        data: {
          recipient: { name: admin.name || "", email: admin.email },
          tenant: { name: organisation.name, plan: organisation.plan || "" },
          billing: {
            accessUntil: subscription.current_period_end
              ? new Date(subscription.current_period_end * 1000)
              : null,
            reactivateUrl: platformAppUrl("/pricing"),
          },
        },
        meta: { organisationId: String(organisation._id) },
      });
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

  // Mirror the failed invoice for the billing history.
  await upsertInvoice(invoice, organisation, "failed");
  emitToSuperAdmins("organisation:updated", { organisationId: String(organisation._id) });

  // Notify admin about failed payment
  if (organisation.adminUserId) {
    const admin = await User.findById(organisation.adminUserId);
    if (admin) {
      await sendTemplateEmail("tenant.paymentFailed", {
        to: admin.email,
        data: {
          recipient: { name: admin.name || "", email: admin.email },
          tenant: { name: organisation.name, plan: organisation.plan || "" },
          billing: {
            amount: (invoice.amount_due || 0) / 100,
            currency: (invoice.currency || "aud").toUpperCase(),
            retryDate: invoice.next_payment_attempt
              ? new Date(invoice.next_payment_attempt * 1000)
              : null,
            updateUrl: platformAppUrl("/billing"),
          },
        },
        meta: { organisationId: String(organisation._id), invoiceId: invoice.id },
      });
    }
  }

  console.log(`Organisation ${organisation.slug} marked as past_due (payment failed)`);
}
