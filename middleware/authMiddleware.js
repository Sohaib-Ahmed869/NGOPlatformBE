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
  if (req.user && req.user.role === 'admin') {
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
