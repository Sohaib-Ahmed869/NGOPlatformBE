const axios = require('axios');

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_BASE_URL = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';

// Helper function to get frequency from PayPal plan ID
function getFrequencyFromPayPalPlan(planId) {
  if (!planId) return 'monthly'; // Default to monthly if no plan ID
  
  const planIdLower = planId.toLowerCase();
  if (planIdLower.includes('daily')) return 'daily';
  if (planIdLower.includes('weekly')) return 'weekly';
  if (planIdLower.includes('monthly')) return 'monthly';
  if (planIdLower.includes('yearly')) return 'yearly';
  
  return 'monthly'; // Default to monthly if no match
}

// Get your actual frontend URL - replace with your production URL when deploying
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Get PayPal access token
const getAccessToken = async () => {
  try {
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    const response = await axios.post(
      `${PAYPAL_BASE_URL}/v1/oauth2/token`,
      'grant_type=client_credentials',
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    return response.data.access_token;
  } catch (error) {
    console.error('Error getting PayPal access token:', error.response?.data || error.message);
    throw error;
  }
};

// Create PayPal order
exports.createOrder = async (req, res) => {
  try {
    const { amount } = req.body;
    
    if (!amount) {
      return res.status(400).json({ error: 'Amount is required' });
    }

    console.log('Creating PayPal order with amount:', amount);
    const accessToken = await getAccessToken();

    const response = await axios.post(
      `${PAYPAL_BASE_URL}/v2/checkout/orders`,
      {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'AUD',
            value: amount.toString(),
          },
        }],
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('PayPal order created:', response.data);
    res.json({ id: response.data.id });
  } catch (error) {
    console.error('Error creating PayPal order:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to create order' });
  }
};

// Capture PayPal order
exports.captureOrder = async (req, res) => {
  try {
    const { orderID } = req.body;
    
    if (!orderID) {
      return res.status(400).json({ error: 'Order ID is required' });
    }

    console.log('Capturing PayPal order:', orderID);
    const accessToken = await getAccessToken();

    const response = await axios.post(
      `${PAYPAL_BASE_URL}/v2/checkout/orders/${orderID}/capture`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('PayPal order captured:', response.data);
    res.json(response.data);
  } catch (error) {
    console.error('Error capturing PayPal order:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to capture payment' });
  }
};

// Create PayPal subscription
exports.createSubscription = async (req, res) => {
  try {
    const { plan_id } = req.body;
    if (!plan_id) {
      return res.status(400).json({ error: 'Plan ID is required' });
    }
    
    console.log('Creating PayPal subscription with plan:', plan_id);
    const accessToken = await getAccessToken();
    
    const response = await axios.post(
      `${PAYPAL_BASE_URL}/v1/billing/subscriptions`,
      {
        plan_id,
        application_context: {
          brand_name: "Shahid Afridi Foundation",
          user_action: "SUBSCRIBE_NOW",
          return_url: `${FRONTEND_URL}/order-confirmation`,
          cancel_url: `${FRONTEND_URL}/subscription-cancelled`
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
    
    console.log('PayPal subscription created:', response.data);
    
    // Find approval link
    const approvalLink = response.data.links.find(link => link.rel === 'approve');
    
    if (!approvalLink) {
      throw new Error('Approval link not found in PayPal response');
    }
    
    res.json({ 
      id: response.data.id, 
      approvalUrl: approvalLink.href,
      status: response.data.status
    });
  } catch (error) {
    console.error('Error creating PayPal subscription:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
};

// Create dynamic PayPal plan for custom recurring donation
exports.createDynamicPlan = async (req, res) => {
  try {
    const { amount, frequency = "MONTH", currency = "AUD", total_cycles = 0 } = req.body;
    if (!amount) return res.status(400).json({ error: "Amount is required" });
    
    console.log('Creating dynamic PayPal plan:', { amount, frequency, currency, total_cycles });
    const accessToken = await getAccessToken();
    
    // 1. Create (or reuse) a product
    let productId = process.env.PAYPAL_PRODUCT_ID;
    if (!productId) {
      console.log('Creating new PayPal product...');
      const productRes = await axios.post(
        `${PAYPAL_BASE_URL}/v1/catalogs/products`,
        {
          name: "SAF Recurring Donation",
          description: "Recurring donation to Shahid Afridi Foundation",
          type: "SERVICE",
          category: "CHARITY"
        },
        { 
          headers: { 
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          } 
        }
      );
      productId = productRes.data.id;
      console.log('PayPal product created:', productId);
      // Optionally: save this productId for future use
    }
    
    // 2. Create plan
    const planRes = await axios.post(
      `${PAYPAL_BASE_URL}/v1/billing/plans`,
      {
        product_id: productId,
        name: `SAF Donation Plan ${amount} ${currency}`,
        description: `Custom recurring donation plan - ${amount} ${currency} per ${frequency.toLowerCase()}`,
        billing_cycles: [
          {
            frequency: { interval_unit: frequency, interval_count: 1 },
            tenure_type: "REGULAR",
            sequence: 1,
            total_cycles: total_cycles,
            pricing_scheme: {
              fixed_price: { value: amount.toString(), currency_code: currency }
            }
          }
        ],
        payment_preferences: {
          auto_bill_outstanding: true,
          setup_fee: { value: "0", currency_code: currency },
          setup_fee_failure_action: "CONTINUE",
          payment_failure_threshold: 3
        }
      },
      { 
        headers: { 
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        } 
      }
    );
    
    console.log('PayPal plan created:', planRes.data.id);
    res.json({ planId: planRes.data.id });
  } catch (error) {
    console.error("Error creating dynamic PayPal plan:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to create dynamic plan" });
  }
};

exports.confirmSubscription = async (req, res) => {
  console.log('=== START confirmSubscription ===');
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  
  try {
    const { subscriptionId } = req.body;
    if (!subscriptionId) {
      const error = new Error('No subscriptionId provided in request body');
      console.error(error.message);
      return res.status(400).json({ error: 'subscriptionId is required' });
    }

    console.log('Getting PayPal access token...');
    const accessToken = await getAccessToken();
    if (!accessToken) {
      const error = new Error('Failed to get PayPal access token');
      console.error(error.message);
      return res.status(500).json({ error: 'Failed to authenticate with PayPal' });
    }

    console.log('Fetching subscription details from PayPal...');
    const response = await axios.get(
      `${PAYPAL_BASE_URL}/v1/billing/subscriptions/${subscriptionId}`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
    
    const sub = response.data;
    console.log('PayPal subscription details received');
    
    // Log important subscription details
    const subscriptionAmount = sub.billing_info?.last_payment?.amount?.value || 
                             sub.plan?.billing_cycles?.[0]?.pricing_scheme?.fixed_price?.value;
    console.log('Subscription amount:', subscriptionAmount);
    console.log('Subscription status:', sub.status);

    // Always use the logged-in user's information if available
    let donorName = 'Anonymous Donor';
    let donorEmail = null;
    let donorPhone = '';
    let donorAddress = {};
    let userId = undefined;
    if (req.user) {
      donorName = req.user.name || req.user.firstName || 'Anonymous Donor';
      donorEmail = req.user.email;
      donorPhone = req.user.phone || '';
      donorAddress = req.user.address || {};
      userId = req.user._id;
    } else if (sub.subscriber?.email_address) {
      // Fall back to PayPal subscriber info only if no user is logged in
      donorEmail = sub.subscriber.email_address;
      donorName = sub.subscriber.name?.given_name ? 
        `${sub.subscriber.name.given_name} ${sub.subscriber.name.surname || ''}`.trim() : 
        'Anonymous Donor';
      donorPhone = '';
      donorAddress = {};
    }

    try {
      // Import required models and utilities
      const Order = require('../models/order');
      const { v4: uuidv4 } = require('uuid');
      
      // Check if order already exists
      let order = await Order.findOne({ 
        $or: [
          { externalId: subscriptionId },
          { 'details.id': subscriptionId },
          { 'transactionDetails.subscription_id': subscriptionId }
        ],
        paymentType: 'recurring'
      });
      
      if (!order) {
        console.log('Creating new order in database...');
        const donationId = `DON-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const frequency = getFrequencyFromPayPalPlan(sub.plan_id);
        
        const orderData = {
          user: userId,
          donationId: donationId,
          items: [{
            title: 'Recurring Donation',
            price: subscriptionAmount || 0,
            quantity: 1,
            description: `Recurring ${frequency} donation`
          }],
          paymentType: 'recurring',
          donationType: 'general',
          paymentMethod: 'paypal',
          paymentStatus: sub.status === 'ACTIVE' ? 'active' : 'pending',
          totalAmount: subscriptionAmount || 0,
          recurringDetails: {
            frequency: frequency,
            amount: subscriptionAmount || 0,
            startDate: sub.start_time ? new Date(sub.start_time) : new Date(),
            endDate: sub.billing_info?.final_payment_time ? new Date(sub.billing_info.final_payment_time) : null,
            status: sub.status === 'ACTIVE' ? 'active' : 'pending',
            nextPaymentDate: sub.billing_info?.next_billing_time ? new Date(sub.billing_info.next_billing_time) : null,
            paymentHistory: sub.billing_info?.last_payment ? [{
              date: new Date(sub.billing_info.last_payment.time),
              amount: subscriptionAmount || 0,
              invoiceId: sub.billing_info.last_payment.id,
              status: sub.status === 'ACTIVE' ? 'succeeded' : 'pending',
              receiptUrl: sub.links?.find(link => link.rel === 'self')?.href || ''
            }] : [],
            paypalSubscriptionId: subscriptionId,
            paypalPlanId: sub.plan_id
          },
          externalId: subscriptionId,
          transactionDetails: {
            subscription_id: subscriptionId,
            plan_id: sub.plan_id,
            status: sub.status,
            create_time: sub.create_time,
            links: sub.links
          },
          details: sub,
          donorDetails: {
            name: donorName,
            email: donorEmail || '',
            phone: donorPhone,
            address: donorAddress
          },
          createdAt: sub.create_time ? new Date(sub.create_time) : new Date(),
          updatedAt: new Date()
        };
        
        console.log('Order data to be saved:', JSON.stringify(orderData, null, 2));
        
        order = new Order(orderData);
        await order.save();
        console.log('Order created successfully. Order ID:', order._id);
        
        // Verify the order was saved
        const savedOrder = await Order.findById(order._id);
        console.log('Verified saved order exists:', !!savedOrder);
      } else {
        console.log('Found existing order. Order ID:', order._id);
        
        // Update existing order if needed
        order.status = sub.status === 'ACTIVE' ? 'active' : 'pending';
        order.amount = subscriptionAmount || order.amount;
        order.details = sub;
        order.updatedAt = new Date();
        
        await order.save();
        console.log('Updated existing order');
      }
      
      // Prepare response
      const responseData = { 
        success: true,
        order: {
          id: order._id,
          status: order.status,
          amount: order.amount,
          subscriptionId: order.externalId,
          createdAt: order.createdAt
        },
        subscription: {
          id: subscriptionId,
          status: sub.status,
          amount: subscriptionAmount,
          createdAt: order.createdAt
        }
      };
      
      console.log('Sending success response:', JSON.stringify(responseData, null, 2));
      return res.json(responseData);
      
    } catch (dbError) {
      console.error('Database error:', {
        message: dbError.message,
        stack: dbError.stack,
        code: dbError.code,
        name: dbError.name
      });
      
      if (dbError.name === 'ValidationError') {
        console.error('Validation errors:', dbError.errors);
      }
      
      // Return the subscription details even if database save fails
      const subscriptionData = {
        success: true,
        subscription: {
          id: subscriptionId,
          status: sub.status,
          amount: subscriptionAmount,
          createdAt: new Date()
        },
        warning: 'Subscription confirmed but could not save to database',
        error: process.env.NODE_ENV === 'development' ? dbError.message : undefined
      };
      
      console.log('Sending response with database warning:', JSON.stringify(subscriptionData, null, 2));
      return res.json(subscriptionData);
    }
    
  } catch (error) {
    const errorDetails = {
      message: error.message,
      name: error.name,
      code: error.code,
      response: error.response?.data,
      stack: error.stack
    };
    
    console.error('Error in confirmSubscription:', JSON.stringify(errorDetails, null, 2));
    
    const statusCode = error.response?.status || 500;
    const errorMessage = error.response?.data?.message || 'Failed to confirm subscription';
    
    const errorResponse = { 
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? errorDetails : undefined
    };
    
    console.log('Sending error response:', JSON.stringify(errorResponse, null, 2));
    return res.status(statusCode).json(errorResponse);
  } finally {
    console.log('=== END confirmSubscription ===');
  }
};

// PayPal Webhook Handler
exports.handleWebhook = async (req, res) => {
  try {
    const event = req.body;
    console.log('PayPal webhook received:', event.event_type, event.resource_type);

    // Verify webhook signature (recommended for production)
    // const isValid = await verifyWebhookSignature(req);
    // if (!isValid) {
    //   return res.status(400).json({ error: 'Invalid webhook signature' });
    // }

    switch (event.event_type) {
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
        await handleSubscriptionActivated(event);
        break;
      
      case 'BILLING.SUBSCRIPTION.PAYMENT.COMPLETED':
        await handleSubscriptionPaymentCompleted(event);
        break;
      
      case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
        await handleSubscriptionPaymentFailed(event);
        break;
      
      case 'BILLING.SUBSCRIPTION.CANCELLED':
        await handleSubscriptionCancelled(event);
        break;
      
      case 'BILLING.SUBSCRIPTION.SUSPENDED':
        await handleSubscriptionSuspended(event);
        break;
      
      case 'PAYMENT.SALE.COMPLETED':
        await handlePaymentSaleCompleted(event);
        break;
      
      default:
        console.log('Unhandled PayPal webhook event:', event.event_type);
    }

    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('PayPal webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
};

// Handle subscription activation
const handleSubscriptionActivated = async (event) => {
  const subscription = event.resource;
  console.log('Subscription activated:', subscription.id);
  
  // Find order by PayPal subscription ID
  const order = await Order.findOne({ 
    'paypalDetails.subscriptionId': subscription.id 
  });
  
  if (order) {
    order.paymentStatus = 'active';
    order.paypalDetails = {
      ...order.paypalDetails,
      status: subscription.status,
      lastUpdated: new Date()
    };
    await order.save();
    console.log('Order updated for activated subscription:', order.donationId);
  }
};

// Handle successful subscription payment
const handleSubscriptionPaymentCompleted = async (event) => {
  const payment = event.resource;
  console.log('Webhook payment resource:', JSON.stringify(payment, null, 2));
  // Find order by PayPal subscription ID
  const order = await Order.findOne({ 
    'paypalDetails.subscriptionId': payment.billing_agreement_id 
  });
  
  if (order) {
    if (order.paymentType === 'installments') {
      // Update installment progress
      const currentPaid = order.installmentDetails.installmentsPaid || 0;
      const totalInstallments = order.installmentDetails.numberOfInstallments;
      const installmentLog = {
        installmentNumber: currentPaid + 1,
        amount: payment.amount.total,
        paymentDate: new Date(),
        paypalPaymentId: payment.id,
        status: 'completed'
      };
      console.log('Adding to installmentHistory:', installmentLog);
      order.installmentDetails.installmentsPaid = currentPaid + 1;
      order.installmentDetails.installmentHistory.push(installmentLog);
      
      // Check if all installments are paid
      if (order.installmentDetails.installmentsPaid >= totalInstallments) {
        order.paymentStatus = 'completed';
        order.installmentDetails.status = 'completed';
      } else {
        // Set next installment date
        const nextDate = new Date();
        nextDate.setMonth(nextDate.getMonth() + 1);
        order.installmentDetails.nextInstallmentDate = nextDate;
      }
    } else if (order.paymentType === 'recurring') {
      // Add to payment history for recurring
      if (!order.paymentHistory) order.paymentHistory = [];
      order.paymentHistory.push({
        paymentDate: new Date(),
        amount: payment.amount.total,
        paypalPaymentId: payment.id,
        status: 'completed'
      });
    }
    
    order.paypalDetails = {
      ...order.paypalDetails,
      lastPaymentDate: new Date(),
      lastPaymentId: payment.id,
      lastUpdated: new Date()
    };
    
    await order.save();
    console.log('Order updated for payment:', order.donationId);
  }
};

// Handle failed subscription payment
const handleSubscriptionPaymentFailed = async (event) => {
  const payment = event.resource;
  console.log('Subscription payment failed:', payment.id);
  
  const order = await Order.findOne({ 
    'paypalDetails.subscriptionId': payment.billing_agreement_id 
  });
  
  if (order) {
    if (order.paymentType === 'installments') {
      // Add failed payment to history
      const currentPaid = order.installmentDetails.installmentsPaid || 0;
      order.installmentDetails.installmentHistory.push({
        installmentNumber: currentPaid + 1,
        amount: payment.amount.total,
        paymentDate: new Date(),
        paypalPaymentId: payment.id,
        status: 'failed'
      });
    }
    
    order.paymentStatus = 'failed';
    order.paypalDetails = {
      ...order.paypalDetails,
      lastPaymentDate: new Date(),
      lastPaymentId: payment.id,
      lastUpdated: new Date()
    };
    
    await order.save();
    console.log('Order marked as failed:', order.donationId);
  }
};

// Handle subscription cancellation
const handleSubscriptionCancelled = async (event) => {
  const subscription = event.resource;
  console.log('Subscription cancelled:', subscription.id);
  
  const order = await Order.findOne({ 
    'paypalDetails.subscriptionId': subscription.id 
  });
  
  if (order) {
    order.paymentStatus = 'cancelled';
    order.paypalDetails = {
      ...order.paypalDetails,
      status: subscription.status,
      lastUpdated: new Date()
    };
    
    if (order.paymentType === 'installments') {
      order.installmentDetails.status = 'cancelled';
    }
    
    await order.save();
    console.log('Order cancelled:', order.donationId);
  }
};

// Handle subscription suspension
const handleSubscriptionSuspended = async (event) => {
  const subscription = event.resource;
  console.log('Subscription suspended:', subscription.id);
  
  const order = await Order.findOne({ 
    'paypalDetails.subscriptionId': subscription.id 
  });
  
  if (order) {
    order.paymentStatus = 'suspended';
    order.paypalDetails = {
      ...order.paypalDetails,
      status: subscription.status,
      lastUpdated: new Date()
    };
    
    await order.save();
    console.log('Order suspended:', order.donationId);
  }
};

// Handle one-time payment completion
const handlePaymentSaleCompleted = async (event) => {
  const payment = event.resource;
  console.log('Payment sale completed:', payment.id);
  
  // This handles one-time payments that might be part of installments
  // You might need to match by custom_id or other identifier
  const order = await Order.findOne({ 
    'paypalDetails.paymentId': payment.id 
  });
  
  if (order) {
    // Update payment status for one-time payments
    order.paymentStatus = 'completed';
    order.paypalDetails = {
      ...order.paypalDetails,
      paymentCompleted: true,
      lastUpdated: new Date()
    };
    
    await order.save();
    console.log('One-time payment completed for order:', order.donationId);
  }
};