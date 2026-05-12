// controllers/admin/subscriptionController.js
const Order = require("../../models/order");

// Send email when admin approves a cancellation request
const sendCancellationApprovalEmail = async (subscription) => {
  try {
    const { sendEmail } = require("../../services/emailUtil");
    const User = require("../../models/user");
    
    // Get user from the subscription
    const user = await User.findById(subscription.user);
    if (!user || !user.email) {
      console.error("Missing user or user email for subscription:", subscription._id);
      return;
    }

    console.log("Attempting to send cancellation approval email to:", user.email);

    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="text-align: center; padding: 20px 0;">
          <img src="https://safimages.s3.ap-southeast-2.amazonaws.com/events/Screenshot+2025-02-27+014744.png" alt="Shahid Afridi Foundation" style="max-width: 150px;">
        </div>
        
        <h2 style="color: #4a7c59;">Subscription Cancellation Approved</h2>
        
        <p>Dear ${user.name},</p>
        
        <p>We are writing to confirm that your request to cancel your recurring donation has been approved.</p>
        
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Subscription Details:</h3>
          <p><strong>Amount:</strong> $${subscription.totalAmount.toFixed(2)} AUD</p>
          <p><strong>Frequency:</strong> ${subscription.recurringDetails.frequency}</p>
          <p><strong>Cancellation Date:</strong> ${new Date().toLocaleDateString()}</p>
        </div>

        <p>Thank you for your generous support. We hope you will consider supporting our cause again in the future.</p>
        
        <p>If you have any questions, please don't hesitate to contact us.</p>
      </div>
    `;

    const result = await sendEmail(
      user.email,
      emailBody,
      "Subscription Cancellation Approved - Shahid Afridi Foundation"
    );

    if (!result.success) {
      console.error("Failed to send cancellation approval email:", result.error);
    } else {
      console.log("Cancellation approval email sent successfully to:", user.email);
    }
  } catch (error) {
    console.error("Error sending cancellation approval email:", error);
  }
};

// Send email when admin denies a cancellation request
const sendCancellationDenialEmail = async (subscription) => {
  try {
    const { sendEmail } = require("../../services/emailUtil");
    const User = require("../../models/user");
    
    // Get user from the subscription
    const user = await User.findById(subscription.user);
    if (!user || !user.email) {
      console.error("Missing user or user email for subscription:", subscription._id);
      return;
    }

    console.log("Attempting to send cancellation denial email to:", user.email);

    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="text-align: center; padding: 20px 0;">
          <img src="https://safimages.s3.ap-southeast-2.amazonaws.com/events/Screenshot+2025-02-27+014744.png" alt="Shahid Afridi Foundation" style="max-width: 150px;">
        </div>
        
        <h2 style="color: #dc2626;">Subscription Cancellation Request Denied</h2>
        
        <p>Dear ${user.name},</p>
        
        <p>We are writing to inform you that your request to cancel your recurring donation could not be processed at this time.</p>
        
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Subscription Details:</h3>
          <p><strong>Amount:</strong> $${subscription.totalAmount.toFixed(2)} AUD</p>
          <p><strong>Frequency:</strong> ${subscription.recurringDetails.frequency}</p>
        </div>

        <p>If you have any questions or would like to discuss this further, please contact us at info@ShahidAfridiFoundation.org.au.</p>
        
        <p>Thank you for your continued support.</p>
      </div>
    `;

    const result = await sendEmail(
      user.email,
      emailBody,
      "Subscription Cancellation Request Update - Shahid Afridi Foundation"
    );

    if (!result.success) {
      console.error("Failed to send cancellation denial email:", result.error);
    } else {
      console.log("Cancellation denial email sent successfully to:", user.email);
    }
  } catch (error) {
    console.error("Error sending cancellation denial email:", error);
  }
};

// Approve a subscription cancellation request
exports.approveCancellationRequest = async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

    // Find the subscription with pending cancellation status
    const subscription = await Order.findOne({
      _id: subscriptionId,
      paymentStatus: "pending_cancellation",
    });

    if (!subscription) {
      return res.status(404).json({
        status: "Error",
        message: "Pending cancellation request not found",
      });
    }

    // If this is a Stripe subscription, cancel it in Stripe
    if (
      subscription.paymentType === "recurring" &&
      subscription.transactionDetails?.stripeSubscriptionId
    ) {
      try {
        // Cancel subscription in Stripe
        await stripe.subscriptions.cancel(
          subscription.transactionDetails.stripeSubscriptionId
        );

        console.log(
          `Cancelled Stripe subscription: ${subscription.transactionDetails.stripeSubscriptionId}`
        );
      } catch (stripeError) {
        console.error("Stripe subscription cancellation error:", stripeError);
        return res.status(400).json({
          status: "Error",
          message: `Failed to cancel subscription in Stripe: ${stripeError.message}`,
        });
      }
    }

    // Update local subscription record
    subscription.paymentStatus = "cancelled";
    if (subscription.cancellationDetails) {
      subscription.cancellationDetails.status = "approved";
      subscription.cancellationDetails.approvedBy = req.user._id;
      subscription.cancellationDetails.approvalDate = new Date();
    }

    await subscription.save();

    // Send email notification to the user
    await sendCancellationApprovalEmail(subscription);

    res.json({
      status: "Success",
      message: "Subscription cancellation request approved",
      subscription,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to approve cancellation request",
      error: error.message,
    });
  }
};

// Deny a subscription cancellation request
exports.denyCancellationRequest = async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const { reason } = req.body;

    // Find the subscription with pending cancellation status
    const subscription = await Order.findOne({
      _id: subscriptionId,
      paymentStatus: "pending_cancellation",
    });

    if (!subscription) {
      return res.status(404).json({
        status: "Error",
        message: "Pending cancellation request not found",
      });
    }

    // Update subscription record
    subscription.paymentStatus = "active"; // Revert back to active
    if (subscription.cancellationDetails) {
      subscription.cancellationDetails.status = "denied";
      subscription.cancellationDetails.deniedBy = req.user._id;
      subscription.cancellationDetails.denialDate = new Date();
      subscription.cancellationDetails.denialReason = reason || "Request denied by administrator";
    }

    await subscription.save();

    // Send email notification to the user
    await sendCancellationDenialEmail(subscription);

    res.json({
      status: "Success",
      message: "Subscription cancellation request denied",
      subscription,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to deny cancellation request",
      error: error.message,
    });
  }
};

// Get all pending cancellation requests
exports.getPendingCancellationRequests = async (req, res) => {
  try {
    const pendingRequests = await Order.find({
      paymentStatus: "pending_cancellation",
    }).populate("user", "name email");

    res.json({
      status: "Success",
      count: pendingRequests.length,
      pendingRequests,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch pending cancellation requests",
      error: error.message,
    });
  }
};

// Get Dashboard Stats
// Get Dashboard Stats
exports.getDashboardStats = async (req, res) => {
  try {
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

    // Get all valid orders (excluding failed)
    const allOrders = await Order.find({
      paymentStatus: { $ne: "failed" }
    }).lean();

    console.log("=== SUBSCRIPTION STATS CALCULATION ===");
    console.log("Total valid orders found:", allOrders.length);

    // Initialize stats
    let activeSubscriptions = 0;
    let monthlyRecurringRevenue = 0;
    let totalRecurringOrders = 0;
    let activeRecurringOrders = 0;

    // Process each order to calculate MRR and active subscriptions
    await Promise.all(
      allOrders.map(async (order) => {
        // Count total recurring/installment orders
        if (order.paymentType === "recurring" || order.paymentType === "installments") {
          totalRecurringOrders++;

          // Count active subscriptions
          if (order.paymentStatus === "active" || order.paymentStatus === "completed") {
            activeRecurringOrders++;

            // Calculate MRR only from orders with actual payments
            if (order.paymentType === "recurring" && order.recurringDetails) {
              // Check if there are successful payments
              let hasSuccessfulPayments = false;
              
              if (order.recurringDetails.paymentHistory && 
                  Array.isArray(order.recurringDetails.paymentHistory)) {
                hasSuccessfulPayments = order.recurringDetails.paymentHistory.some(
                  p => p.status === "succeeded" || p.status === "completed"
                );
              }

              // Try Stripe if no local payment history
              if (!hasSuccessfulPayments && order.transactionDetails?.stripeSubscriptionId) {
                try {
                  const invoices = await stripe.invoices.list({
                    subscription: order.transactionDetails.stripeSubscriptionId,
                    status: "paid",
                    limit: 1,
                  });
                  hasSuccessfulPayments = invoices.data.length > 0;
                } catch (stripeError) {
                  console.error("Error checking Stripe invoices:", stripeError);
                }
              }

              // Add to MRR only if there are successful payments
              if (hasSuccessfulPayments && order.recurringDetails.amount && order.recurringDetails.frequency) {
                activeSubscriptions++;
                
                const amount = order.recurringDetails.amount;
                const frequency = order.recurringDetails.frequency;
                
                let monthlyAmount = 0;
                switch (frequency.toLowerCase()) {
                  case "monthly":
                    monthlyAmount = amount;
                    break;
                  case "weekly":
                    monthlyAmount = amount * 4.33; // Average weeks per month
                    break;
                  case "yearly":
                    monthlyAmount = amount / 12;
                    break;
                  case "quarterly":
                    monthlyAmount = amount / 3;
                    break;
                  case "daily":
                    monthlyAmount = amount * 30; // Average days per month
                    break;
                  default:
                    monthlyAmount = amount; // Default to monthly
                }
                
                monthlyRecurringRevenue += monthlyAmount;
                console.log(`Added ${monthlyAmount} to MRR from recurring (${frequency})`);
              }
            }
            else if (order.paymentType === "installments" && order.installmentDetails) {
              // Check if there are completed installments
              let hasCompletedInstallments = false;
              
              if (order.installmentDetails.installmentHistory && 
                  Array.isArray(order.installmentDetails.installmentHistory)) {
                hasCompletedInstallments = order.installmentDetails.installmentHistory.some(
                  installment => installment.status === "completed"
                );
              } else if (order.installmentDetails.installmentsPaid > 0) {
                hasCompletedInstallments = true;
              }

              // Add to MRR only if there are completed installments
              if (hasCompletedInstallments && order.installmentDetails.installmentAmount) {
                activeSubscriptions++;
                monthlyRecurringRevenue += order.installmentDetails.installmentAmount;
                console.log(`Added ${order.installmentDetails.installmentAmount} to MRR from installments`);
              }
            }
          }
        }
      })
    );

    // Calculate retention rate (active vs total recurring orders)
    const retentionRate = totalRecurringOrders > 0 
      ? (activeRecurringOrders / totalRecurringOrders) * 100 
      : 0;

    // Calculate average lifetime value for recurring orders
    const recurringOrders = allOrders.filter(order => 
      order.paymentType === "recurring" || order.paymentType === "installments"
    );
    
    const avgLifetimeValue = recurringOrders.length > 0
      ? recurringOrders.reduce((sum, order) => sum + order.totalAmount, 0) / recurringOrders.length
      : 0;

    // Get subscription growth trend (last 6 months)
    const currentDate = new Date();
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(currentDate.getMonth() - 6);

    const monthlyTrend = await Order.aggregate([
      {
        $match: {
          paymentStatus: { $ne: "failed" },
          createdAt: { $gte: sixMonthsAgo },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
          },
          totalAmount: { $sum: "$totalAmount" },
          totalOrders: { $sum: 1 },
          recurringOrders: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ["$paymentType", "recurring"] },
                    { $eq: ["$paymentType", "installments"] }
                  ]
                },
                1,
                0
              ]
            }
          },
          oneTimeOrders: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ["$paymentType", "single"] },
                    { $eq: ["$paymentType", "one_time"] },
                    { $eq: ["$paymentType", null] }
                  ]
                },
                1,
                0
              ]
            }
          }
        },
      },
      {
        $sort: { "_id.year": 1, "_id.month": 1 },
      },
    ]);

    // Format trend data properly including the year
    const trendData = monthlyTrend.map((item) => ({
      month: new Date(item._id.year, item._id.month - 1).toLocaleString(
        "default",
        { month: "long" }
      ),
      year: item._id.year,
      amount: item.totalAmount,
      count: item.totalOrders,
      recurring: item.recurringOrders,
      oneTime: item.oneTimeOrders,
    }));

    console.log("=== SUBSCRIPTION STATS RESULTS ===");
    console.log("Active Subscriptions:", activeSubscriptions);
    console.log("Monthly Recurring Revenue:", monthlyRecurringRevenue);
    console.log("Total Recurring Orders:", totalRecurringOrders);
    console.log("Active Recurring Orders:", activeRecurringOrders);
    console.log("Retention Rate:", retentionRate);
    console.log("Avg Lifetime Value:", avgLifetimeValue);

    const stats = {
      activeSubscriptions: activeSubscriptions,
      monthlyRecurringRevenue: monthlyRecurringRevenue,
      retentionRate: retentionRate,
      avgLifetimeValue: avgLifetimeValue,
      totalRecurringOrders: totalRecurringOrders,
      activeRecurringOrders: activeRecurringOrders,
      trendData: trendData,
    };

    res.json({ status: "Success", data: { stats } });
  } catch (error) {
    console.error("Error in subscription dashboard stats:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch subscription statistics",
      error: error.message,
    });
  }
};

// Get Subscriptions List
exports.getSubscriptions = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const frequency = req.query.frequency;
    const status = req.query.status;
    const sortBy = req.query.sortBy || "createdAt";
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;

    const skip = (page - 1) * limit;

    // Build match conditions
    const matchConditions = {
      paymentType: "recurring",
    };

    if (search) {
      matchConditions.$or = [
        { "donorDetails.name": { $regex: search, $options: "i" } },
        { "donorDetails.email": { $regex: search, $options: "i" } },
        { "items.title": { $regex: search, $options: "i" } },
      ];
    }

    if (frequency && frequency !== "All") {
      matchConditions["recurringDetails.frequency"] = frequency.toLowerCase();
    }

    if (status && status !== "All") {
      matchConditions.paymentStatus = status.toLowerCase();
    }

    // Aggregate pipeline
    const subscriptions = await Order.aggregate([
      { $match: matchConditions },
      {
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "donor",
        },
      },
      { $unwind: { path: "$donor", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          id: "$_id",
          donationId: 1,
          donorName: "$donorDetails.name",
          donorEmail: "$donorDetails.email",
          cause: { $arrayElemAt: ["$items.title", 0] },
          frequency: "$recurringDetails.frequency",
          amount: "$recurringDetails.amount",
          startDate: "$recurringDetails.startDate",
          status: "$paymentStatus",
          nextBilling: "$recurringDetails.endDate",
          paymentMethod: 1,
          totalAmount: 1,
        },
      },
      { $sort: { [sortBy]: sortOrder } },
      { $skip: skip },
      { $limit: limit },
    ]);

    // Get total count
    const total = await Order.countDocuments(matchConditions);

    res.json({
      status: "Success",
      data: {
        subscriptions,
        pagination: {
          total,
          pages: Math.ceil(total / limit),
          currentPage: page,
          perPage: limit,
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch subscriptions",
      error: error.message,
    });
  }
};

// Get Subscription Details
exports.getSubscriptionDetails = async (req, res) => {
  try {
    const subscription = await Order.findOne({
      _id: req.params.id,
      paymentType: "recurring",
    }).populate("user", "name email phone");

    if (!subscription) {
      return res.status(404).json({
        status: "Error",
        message: "Subscription not found",
      });
    }

    res.json({
      status: "Success",
      data: {
        subscription,
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch subscription details",
      error: error.message,
    });
  }
};

// Update Subscription Status
exports.updateSubscriptionStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ["active", "paused", "cancelled", "failed"];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        status: "Error",
        message: "Invalid status value",
      });
    }

    const subscription = await Order.findOneAndUpdate(
      {
        _id: req.params.id,
        paymentType: "recurring",
      },
      {
        $set: {
          paymentStatus: status,
          updatedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!subscription) {
      return res.status(404).json({
        status: "Error",
        message: "Subscription not found",
      });
    }

    res.json({
      status: "Success",
      data: { subscription },
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to update subscription status",
      error: error.message,
    });
  }
};