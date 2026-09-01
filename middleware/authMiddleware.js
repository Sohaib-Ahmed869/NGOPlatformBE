const jwt = require('jsonwebtoken');
const User = require('../models/user');

// Middleware to authenticate user using JWT token
const protect = async (req, res, next) => {
  let token;

  // Check for token in Authorization header
  if (
    req.headers.authorization && 
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      // Get token from header
      token = req.headers.authorization.split(' ')[1];

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Get user from the token
      req.user = await User.findById(decoded.id).select('-password');

      if (!req.user) {
        return res.status(401).json({ 
          success: false,
          message: 'Not authorized, user not found' 
        });
      }

      // STAFF ACCOUNTS ONLY — suspension and forced sign-out.
      //
      // middleware/isSuperAdmin.js has always enforced these for platform
      // operators, but every tenant-admin request comes through here instead,
      // where nothing checked either. That made "suspend this admin" a promise
      // this middleware did not keep: loginAdmin refuses a suspended account,
      // so a NEW sign-in was blocked, while the 30-day token already in their
      // browser kept working on every admin API until it expired.
      //
      // Scoped to admin/superadmin on purpose. Donor tokens are minted without
      // a tokenVersion claim (see generateToken call sites in
      // controllers/userController.js — only loginAdmin passes one), so a
      // version check applied to them could never be satisfied by logging back
      // in, and would lock every donor out permanently. `|| 0` normalises a
      // legacy staff token, issued before this claim existed, to the schema
      // default — so shipping this does not sign anyone out who has not
      // actually been suspended or forced out.
      if (req.user.role === 'admin' || req.user.role === 'superadmin') {
        if ((decoded.tokenVersion || 0) !== (req.user.tokenVersion || 0)) {
          return res.status(401).json({
            success: false,
            message: 'Session expired, please log in again',
          });
        }
        if (req.user.platformStatus === 'suspended') {
          return res.status(403).json({
            success: false,
            message: 'This account has been suspended',
          });
        }
      }

      next();
    } catch (error) {
      console.error('Authentication error:', error);
      return res.status(401).json({ 
        success: false,
        message: 'Not authorized, token failed' 
      });
    }
  }

  if (!token) {
    return res.status(401).json({ 
      success: false,
      message: 'Not authorized, no token' 
    });
  }
};

// Middleware to check if user is an admin
const admin = (req, res, next) => {
  if (req.user && ['admin', 'superadmin'].includes(req.user.role)) {
    next();
  } else {
    res.status(403).json({
      success: false,
      message: 'Not authorized as an admin'
    });
  }
};

// Middleware to check if user is a donor
const donor = (req, res, next) => {
  if (req.user && req.user.role === 'donor') {
    next();
  } else {
    res.status(403).json({ 
      success: false,
      message: 'Not authorized as a donor' 
    });
  }
};

// Middleware to check if user is a beneficiary
const beneficiary = (req, res, next) => {
  if (req.user && req.user.role === 'beneficiary') {
    next();
  } else {
    res.status(403).json({ 
      success: false,
      message: 'Not authorized as a beneficiary' 
    });
  }
};

// Middleware to check if user is an admin or donor
const adminOrDonor = (req, res, next) => {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'donor')) {
    next();
  } else {
    res.status(403).json({ 
      success: false,
      message: 'Not authorized' 
    });
  }
};

// Middleware to check if user is an admin or beneficiary
const adminOrBeneficiary = (req, res, next) => {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'beneficiary')) {
    next();
  } else {
    res.status(403).json({ 
      success: false,
      message: 'Not authorized' 
    });
  }
};

module.exports = { 
  protect, 
  admin, 
  donor, 
  beneficiary, 
  adminOrDonor, 
  adminOrBeneficiary 
};
