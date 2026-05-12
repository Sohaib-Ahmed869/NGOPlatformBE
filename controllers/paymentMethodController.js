// controllers/paymentMethodController.js
const PaymentMethod = require("../models/paymentMethods");
const User = require("../models/user");

exports.addPaymentMethod = async (req, res) => {
  try {
    const {
      type,
      cardNumber,
      cardType,
      expiryMonth,
      expiryYear,
      bankName,
      accountLastFour,
      routingNumber,
      isDefault,
    } = req.body;

    // If setting as default, unset any existing default
    if (isDefault) {
      await PaymentMethod.updateMany(
        { user: req.user._id },
        { isDefault: false }
      );
    }

    const paymentMethod = new PaymentMethod({
      user: req.user._id,
      type,
      cardNumber: cardNumber ? cardNumber.slice(-4) : undefined,
      cardType,
      expiryMonth,
      expiryYear,
      bankName,
      accountLastFour,
      routingNumber,
      isDefault,
    });

    await paymentMethod.save();

    // If this is the first payment method or set as default,
    // update user's default payment method
    if (isDefault) {
      await User.findByIdAndUpdate(req.user._id, {
        defaultPaymentMethod: paymentMethod._id,
      });
    }

    res.status(201).json({
      status: "Success",
      message: "Payment method added successfully",
      paymentMethod,
    });
  } catch (error) {
    res.status(400).json({
      status: "Error",
      message: "Failed to add payment method",
      error: error.message,
    });
  }
};

exports.getPaymentMethods = async (req, res) => {
  try {
    const paymentMethods = await PaymentMethod.find({
      user: req.user._id,
      isActive: true,
    });

    res.json({
      status: "Success",
      paymentMethods,
    });
  } catch (error) {
    res.status(400).json({
      status: "Error",
      message: "Failed to fetch payment methods",
      error: error.message,
    });
  }
};

exports.deletePaymentMethod = async (req, res) => {
  try {
    const { id } = req.params;

    // Soft delete by setting isActive to false
    await PaymentMethod.findOneAndUpdate(
      { _id: id, user: req.user._id },
      { isActive: false }
    );

    res.json({
      status: "Success",
      message: "Payment method deleted successfully",
    });
  } catch (error) {
    res.status(400).json({
      status: "Error",
      message: "Failed to delete payment method",
      error: error.message,
    });
  }
};

exports.setDefaultPaymentMethod = async (req, res) => {
  try {
    const { id } = req.params;

    // Unset any existing default
    await PaymentMethod.updateMany(
      { user: req.user._id },
      { isDefault: false }
    );

    // Set new default
    const paymentMethod = await PaymentMethod.findOneAndUpdate(
      { _id: id, user: req.user._id },
      { isDefault: true },
      { new: true }
    );

    // Update user's default payment method
    await User.findByIdAndUpdate(req.user._id, {
      defaultPaymentMethod: paymentMethod._id,
    });

    res.json({
      status: "Success",
      message: "Default payment method updated successfully",
      paymentMethod,
    });
  } catch (error) {
    res.status(400).json({
      status: "Error",
      message: "Failed to update default payment method",
      error: error.message,
    });
  }
};
