// Per-tenant PayPal donations. All calls use the tenant's own PayPal app
// (resolved via services/tenantPaypal), falling back to the platform app when a
// tenant hasn't connected their own. The tenant is taken from req.organisation
// (set by the tenant middleware) for donor-facing routes, or resolved by slug
// for the webhook.
const Order = require("../models/order");
const Organisation = require("../models/organisation");
const { getPaypalClient, getPaypalConfig } = require("../services/tenantPaypal");

function getFrequencyFromPayPalPlan(planId) {
  if (!planId) return "monthly";
  const p = String(planId).toLowerCase();
  if (p.includes("daily")) return "daily";
  if (p.includes("weekly")) return "weekly";
  if (p.includes("monthly")) return "monthly";
  if (p.includes("yearly")) return "yearly";
  return "monthly";
}

// The tenant's public site (for PayPal redirect URLs). Prefer the request origin.
function frontendBase(req) {
  return req.headers.origin || process.env.FRONTEND_URL || "http://localhost:5173";
}

// Create one-time PayPal order
exports.createOrder = async (req, res) => {
  try {
    const { amount, currency = "AUD" } = req.body;
    if (!amount) return res.status(400).json({ error: "Amount is required" });

    const { client } = await getPaypalClient(req.organisation);
    const response = await client.post("/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: currency, value: amount.toString() } }],
    });
    res.json({ id: response.data.id });
  } catch (error) {
    console.error("Error creating PayPal order:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to create order" });
  }
};

// Capture a one-time PayPal order
exports.captureOrder = async (req, res) => {
  try {
    const { orderID } = req.body;
    if (!orderID) return res.status(400).json({ error: "Order ID is required" });

    const { client } = await getPaypalClient(req.organisation);
    const response = await client.post(`/v2/checkout/orders/${orderID}/capture`, {});
    res.json(response.data);
  } catch (error) {
    console.error("Error capturing PayPal order:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to capture payment" });
  }
};

// Create a PayPal subscription from an existing plan
exports.createSubscription = async (req, res) => {
  try {
    const { plan_id } = req.body;
    if (!plan_id) return res.status(400).json({ error: "Plan ID is required" });

    const { client } = await getPaypalClient(req.organisation);
    const base = frontendBase(req);
    const response = await client.post("/v1/billing/subscriptions", {
      plan_id,
      application_context: {
        brand_name: req.organisation?.name || "Donation",
        user_action: "SUBSCRIBE_NOW",
        return_url: `${base}/order-confirmation`,
        cancel_url: `${base}/subscription-cancelled`,
      },
    });

    const approvalLink = (response.data.links || []).find((l) => l.rel === "approve");
    if (!approvalLink) throw new Error("Approval link not found in PayPal response");
    res.json({ id: response.data.id, approvalUrl: approvalLink.href, status: response.data.status });
  } catch (error) {
    console.error("Error creating PayPal subscription:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to create subscription" });
  }
};

// Create a dynamic plan for a custom recurring donation
exports.createDynamicPlan = async (req, res) => {
  try {
    const { amount, frequency = "MONTH", currency = "AUD", total_cycles = 0 } = req.body;
    if (!amount) return res.status(400).json({ error: "Amount is required" });

    const { client } = await getPaypalClient(req.organisation);
    const cfg = getPaypalConfig(req.organisation);

    // Reuse the org's catalog product, else create one and persist it.
    let productId = cfg.productId;
    if (!productId) {
      const orgName = req.organisation?.name || "Donation";
      const productRes = await client.post("/v1/catalogs/products", {
        name: `${orgName} Recurring Donation`,
        description: `Recurring donation to ${orgName}`,
        type: "SERVICE",
        category: "CHARITY",
      });
      productId = productRes.data.id;
      if (cfg.tenant && req.organisation?._id) {
        await Organisation.findByIdAndUpdate(req.organisation._id, { $set: { "paypal.productId": productId } });
      }
    }

    const orgName = req.organisation?.name || "Donation";
    const planRes = await client.post("/v1/billing/plans", {
      product_id: productId,
      name: `${orgName} Plan ${amount} ${currency}`,
      description: `Custom recurring donation - ${amount} ${currency} per ${frequency.toLowerCase()}`,
      billing_cycles: [
        {
          frequency: { interval_unit: frequency, interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles,
          pricing_scheme: { fixed_price: { value: amount.toString(), currency_code: currency } },
        },
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee: { value: "0", currency_code: currency },
        setup_fee_failure_action: "CONTINUE",
        payment_failure_threshold: 3,
      },
    });

    res.json({ planId: planRes.data.id });
  } catch (error) {
    console.error("Error creating dynamic PayPal plan:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to create dynamic plan" });
  }
};

// Confirm a subscription and persist the Order (tenant-scoped)
exports.confirmSubscription = async (req, res) => {
  try {
    const { subscriptionId } = req.body;
    if (!subscriptionId) return res.status(400).json({ error: "subscriptionId is required" });

    const { client } = await getPaypalClient(req.organisation);
    const response = await client.get(`/v1/billing/subscriptions/${subscriptionId}`);
    const sub = response.data;

    const subscriptionAmount =
      sub.billing_info?.last_payment?.amount?.value ||
      sub.plan?.billing_cycles?.[0]?.pricing_scheme?.fixed_price?.value;

    let donorName = "Anonymous Donor";
    let donorEmail = null;
    let donorPhone = "";
    let donorAddress = {};
    let userId;
    if (req.user) {
      donorName = req.user.name || req.user.firstName || "Anonymous Donor";
      donorEmail = req.user.email;
      donorPhone = req.user.phone || "";
      donorAddress = req.user.address || {};
      userId = req.user._id;
    } else if (sub.subscriber?.email_address) {
      donorEmail = sub.subscriber.email_address;
      donorName = sub.subscriber.name?.given_name
        ? `${sub.subscriber.name.given_name} ${sub.subscriber.name.surname || ""}`.trim()
        : "Anonymous Donor";
    }

    let order = await Order.findOne({
      $or: [
        { externalId: subscriptionId },
        { "transactionDetails.subscription_id": subscriptionId },
      ],
      paymentType: "recurring",
    });

    if (!order) {
      const donationId = `DON-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const frequency = getFrequencyFromPayPalPlan(sub.plan_id);
      order = new Order({
        organisationId: req.organisation?._id || null,
        user: userId,
        donationId,
        items: [{ title: "Recurring Donation", price: subscriptionAmount || 0, quantity: 1, description: `Recurring ${frequency} donation` }],
        paymentType: "recurring",
        donationType: "general",
        paymentMethod: "paypal",
        paymentStatus: sub.status === "ACTIVE" ? "active" : "pending",
        totalAmount: subscriptionAmount || 0,
        recurringDetails: {
          frequency,
          amount: subscriptionAmount || 0,
          startDate: sub.start_time ? new Date(sub.start_time) : new Date(),
          status: sub.status === "ACTIVE" ? "active" : "pending",
          nextPaymentDate: sub.billing_info?.next_billing_time ? new Date(sub.billing_info.next_billing_time) : null,
          paypalSubscriptionId: subscriptionId,
          paypalPlanId: sub.plan_id,
        },
        externalId: subscriptionId,
        transactionDetails: { subscription_id: subscriptionId, plan_id: sub.plan_id, status: sub.status },
        details: sub,
        donorDetails: { name: donorName, email: donorEmail || "", phone: donorPhone, address: donorAddress },
      });
      await order.save();
    } else {
      order.paymentStatus = sub.status === "ACTIVE" ? "active" : "pending";
      order.details = sub;
      await order.save();
    }

    return res.json({
      success: true,
      order: { id: order._id, status: order.paymentStatus, amount: order.totalAmount, subscriptionId: order.externalId },
      subscription: { id: subscriptionId, status: sub.status, amount: subscriptionAmount },
    });
  } catch (error) {
    console.error("Error in confirmSubscription:", error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: error.response?.data?.message || "Failed to confirm subscription" });
  }
};

/* ── Per-tenant webhook ─────────────────────────────────────────────────────
 * PayPal posts to /api/webhooks/paypal/:slug. The slug resolves the org so the
 * handler is tenant-aware. (Signature verification with the org's webhookId can
 * be layered on later.)
 */
exports.handleWebhook = async (req, res) => {
  try {
    const event = req.body;
    const org = await Organisation.findOne({ slug: req.params.slug }).select("_id slug").catch(() => null);
    const orgId = org?._id || null;
    console.log(`PayPal webhook [${req.params.slug}]:`, event.event_type);

    switch (event.event_type) {
      case "BILLING.SUBSCRIPTION.ACTIVATED":
        await updateOrderStatus(orgId, event.resource?.id, { paymentStatus: "active" });
        break;
      case "BILLING.SUBSCRIPTION.CANCELLED":
        await updateOrderStatus(orgId, event.resource?.id, { paymentStatus: "cancelled" });
        break;
      case "BILLING.SUBSCRIPTION.SUSPENDED":
        await updateOrderStatus(orgId, event.resource?.id, { paymentStatus: "suspended" });
        break;
      case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
        await updateOrderStatus(orgId, event.resource?.billing_agreement_id, { paymentStatus: "failed" });
        break;
      case "PAYMENT.SALE.COMPLETED":
        await recordSalePayment(orgId, event.resource);
        break;
      default:
        console.log("Unhandled PayPal webhook event:", event.event_type);
    }
    res.status(200).json({ status: "success" });
  } catch (error) {
    console.error("PayPal webhook error:", error.message);
    res.status(500).json({ error: "Webhook processing failed" });
  }
};

// Find an order by its PayPal subscription id (org-scoped when known) and patch it.
async function updateOrderStatus(orgId, subscriptionId, patch) {
  if (!subscriptionId) return;
  const q = {
    $or: [{ externalId: subscriptionId }, { "recurringDetails.paypalSubscriptionId": subscriptionId }, { "transactionDetails.subscription_id": subscriptionId }],
  };
  if (orgId) q.organisationId = orgId;
  const order = await Order.findOne(q);
  if (!order) return;
  Object.assign(order, patch);
  if (patch.paymentStatus === "cancelled" && order.recurringDetails) order.recurringDetails.status = "cancelled";
  await order.save();
}

async function recordSalePayment(orgId, payment) {
  if (!payment?.billing_agreement_id) return;
  const q = {
    $or: [{ externalId: payment.billing_agreement_id }, { "recurringDetails.paypalSubscriptionId": payment.billing_agreement_id }],
  };
  if (orgId) q.organisationId = orgId;
  const order = await Order.findOne(q);
  if (!order) return;
  if (order.recurringDetails) {
    order.recurringDetails.paymentHistory = order.recurringDetails.paymentHistory || [];
    order.recurringDetails.paymentHistory.push({
      date: new Date(),
      amount: payment.amount?.total || order.totalAmount,
      invoiceId: payment.id,
      status: "succeeded",
    });
  }
  await order.save();
}
