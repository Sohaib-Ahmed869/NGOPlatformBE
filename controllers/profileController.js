// controllers/profileController.js
const User = require("../models/user");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("-password");
    res.json({ profile: user });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch profile",
      error: error.message,
    });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const { firstName, lastName, phone, country, language, currency, address } =
      req.body;

    const user = await User.findById(req.user._id);

    user.firstName = firstName;
    user.lastName = lastName;
    user.phone = phone;
    user.country = country;
    user.language = language;
    user.currency = currency;

    // Update address if provided
    if (address) {
      // Initialize address object if it doesn't exist
      if (!user.address) {
        user.address = {};
      }
      
      // Only update fields that are explicitly provided
      if (address.street !== undefined) {
        user.address.street = address.street;
      }
      
      if (address.city !== undefined) {
        user.address.city = address.city;
      }
      
      if (address.state !== undefined) {
        user.address.state = address.state;
      }
      
      if (address.postalCode !== undefined) {
        user.address.postalCode = address.postalCode;
      }
      
      // Log the address update for debugging
      console.log('Updated user address:', user.address);
    }

    await user.save();

    res.json({ profile: user });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to update profile",
      error: error.message,
    });
  }
};

exports.updateNotifications = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    user.notifications = {
      ...user.notifications,
      ...req.body,
    };

    await user.save();

    res.json({ message: "Notification preferences updated" });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to update notifications",
      error: error.message,
    });
  }
};

exports.updatePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await User.findById(req.user._id);
    const isMatch = await bcrypt.compare(currentPassword, user.password);

    if (!isMatch) {
      return res.status(400).json({
        status: "Error",
        message: "Current password is incorrect",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    user.passwordLastChanged = new Date();

    await user.save();

    res.json({ message: "Password updated successfully" });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to update password",
      error: error.message,
    });
  }
};

exports.uploadProfileImage = async (req, res) => {
  try {
    if (!req.file) {
      throw new Error("No file uploaded");
    }

    const user = await User.findById(req.user._id);
    user.profileImage = req.file.path; // Assuming you're storing the file path
    await user.save();

    res.json({
      message: "Profile image updated",
      imageUrl: user.profileImage,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to upload profile image",
      error: error.message,
    });
  }
};

exports.updateTwoFactor = async (req, res) => {
  try {
    const { enabled } = req.body;

    const user = await User.findById(req.user._id);
    user.twoFactorEnabled = enabled;
    await user.save();

    res.json({ message: "2FA settings updated" });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to update 2FA settings",
      error: error.message,
    });
  }
};

exports.signOutAllDevices = async (req, res) => {
  try {
    // Invalidate all tokens except current
    const user = await User.findById(req.user._id);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    res.json({ message: "Signed out of all other devices" });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to sign out all devices",
      error: error.message,
    });
  }
};
