// controllers/installmentController.js

const Order = require("../models/order");
const { processNextInstallment } = require("../services/installmentScheduler");

/**
 * Get all installment orders for the authenticated user
 */
exports.getInstallmentOrders = async (req, res) => {
  try {
    const installmentOrders = await Order.find({
      user: req.user._id,
      paymentType: "installments",
    }).sort({ createdAt: -1 });

    const formattedOrders = installmentOrders.map((order) => ({
      id: order._id,
      donationId: order.donationId,
      cause: order.items[0]?.title,
      totalAmount: order.totalAmount,
      installmentAmount: order.installmentDetails.installmentAmount,
      numberOfInstallments: order.installmentDetails.numberOfInstallments,
      installmentsPaid: order.installmentDetails.installmentsPaid || 0,
      nextInstallmentDate: order.installmentDetails.nextInstallmentDate,
      status: order.paymentStatus,
      startDate: order.installmentDetails.startDate,
      installmentHistory: order.installmentDetails.installmentHistory || [],
      remainingAmount:
        (order.installmentDetails.numberOfInstallments -
          (order.installmentDetails.installmentsPaid || 0)) *
        order.installmentDetails.installmentAmount,
    }));

    res.json({
      status: "Success",
      installmentOrders: formattedOrders,
    });
  } catch (error) {
    console.error("Error fetching installment orders:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch installment orders",
      error: error.message,
    });
  }
};

/**
 * Get details of a specific installment order
 */
exports.getInstallmentOrder = async (req, res) => {
  try {
    const order = await Order.findOne({
      _id: req.params.orderId,
      user: req.user._id,
      paymentType: "installments",
    });

    if (!order) {
      return res.status(404).json({
        status: "Error",
        message: "Installment order not found",
      });
    }

    res.json({
      status: "Success",
      order,
    });
  } catch (error) {
    console.error("Error fetching installment order:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch installment order",
      error: error.message,
    });
  }
};

/**
 * Process the next installment payment manually (useful for admin or if auto-processing fails)
 */
exports.processNextInstallmentPayment = async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findOne({
      _id: orderId,
      user: req.user._id,
      paymentType: "installments",
    });

    if (!order) {
      return res.status(404).json({
        status: "Error",
        message: "Installment order not found",
      });
    }

    if (
      order.paymentStatus === "completed" ||
      order.paymentStatus === "cancelled"
    ) {
      return res.status(400).json({
        status: "Error",
        message: `Cannot process installment for an order with ${order.paymentStatus} status`,
      });
    }

    if (
      order.installmentDetails.installmentsPaid >=
      order.installmentDetails.numberOfInstallments
    ) {
      return res.status(400).json({
        status: "Error",
        message: "All installments have already been paid",
      });
    }

    const result = await processNextInstallment(orderId);

    if (result.success) {
      res.json({
        status: "Success",
        message: "Installment payment processed successfully",
        paymentStatus: result.paymentStatus,
      });
    } else {
      res.status(400).json({
        status: "Error",
        message: result.error || "Failed to process installment payment",
      });
    }
  } catch (error) {
    console.error("Error processing installment payment:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to process installment payment",
      error: error.message,
    });
  }
};

/**
 * Cancel remaining installment payments
 */
exports.cancelRemainingInstallments = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body;

    const order = await Order.findOne({
      _id: orderId,
      user: req.user._id,
      paymentType: "installments",
    });

    if (!order) {
      return res.status(404).json({
        status: "Error",
        message: "Installment order not found",
      });
    }

    if (
      order.paymentStatus === "completed" ||
      order.paymentStatus === "cancelled"
    ) {
      return res.status(400).json({
        status: "Error",
        message: `Order is already in ${order.paymentStatus} status`,
      });
    }

    // Update the order status
    order.paymentStatus = "cancelled";
    order.installmentDetails.status = "cancelled";
    order.cancellationDetails = {
      date: new Date(),
      reason: reason || "User requested cancellation",
      cancelledBy: req.user._id,
    };

    await order.save();

    res.json({
      status: "Success",
      message: "Remaining installments cancelled successfully",
      order: {
        id: order._id,
        status: order.paymentStatus,
        installmentsPaid: order.installmentDetails.installmentsPaid || 0,
        cancellationDate: order.cancellationDetails.date,
      },
    });
  } catch (error) {
    console.error("Error cancelling installments:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to cancel remaining installments",
      error: error.message,
    });
  }
};

/**
 * Update installment amount for remaining payments
 */
exports.updateInstallmentAmount = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { newAmount } = req.body;

    if (!newAmount || newAmount <= 0) {
      return res.status(400).json({
        status: "Error",
        message: "Invalid amount provided",
      });
    }

    const order = await Order.findOne({
      _id: orderId,
      user: req.user._id,
      paymentType: "installments",
    });

    if (!order) {
      return res.status(404).json({
        status: "Error",
        message: "Installment order not found",
      });
    }

    if (
      order.paymentStatus === "completed" ||
      order.paymentStatus === "cancelled"
    ) {
      return res.status(400).json({
        status: "Error",
        message: `Cannot update amount for an order with ${order.paymentStatus} status`,
      });
    }

    const remainingInstallments =
      order.installmentDetails.numberOfInstallments -
      (order.installmentDetails.installmentsPaid || 0);

    if (remainingInstallments <= 0) {
      return res.status(400).json({
        status: "Error",
        message: "All installments have already been paid",
      });
    }

    // Store previous amount for history
    const oldAmount = order.installmentDetails.installmentAmount;

    // Update the installment amount
    order.installmentDetails.installmentAmount = newAmount;

    // Record the change in history
    order.amountHistory = order.amountHistory || [];
    order.amountHistory.push({
      oldAmount,
      newAmount,
      date: new Date(),
      updatedBy: req.user._id,
    });

    // Update total amount based on remaining installments
    const paidAmount =
      (order.installmentDetails.installmentsPaid || 0) * oldAmount;
    const remainingAmount = remainingInstallments * newAmount;
    order.totalAmount = paidAmount + remainingAmount;

    await order.save();

    res.json({
      status: "Success",
      message: "Installment amount updated successfully",
      order: {
        id: order._id,
        newInstallmentAmount: newAmount,
        totalAmount: order.totalAmount,
        remainingInstallments,
      },
    });
  } catch (error) {
    console.error("Error updating installment amount:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to update installment amount",
      error: error.message,
    });
  }
};
