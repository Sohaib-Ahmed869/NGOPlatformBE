const { User } = require('../models/user');

const admin = async (req, res, next) => {
  try {
    // Check if user is authenticated
    if (!req.user) {
      return res.status(401).json({ 
        success: false, 
        message: 'Authentication required' 
      });
    }

    // Check if user has admin role
    if (!req.user.role || !req.user.role.includes('admin')) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Admin privileges required.' 
      });
    }

    // If user is admin, proceed to the next middleware
    next();
  } catch (error) {
    console.error('Admin middleware error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
};

module.exports = admin;
