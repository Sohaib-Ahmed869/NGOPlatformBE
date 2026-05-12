// middleware/optionalAuth.js
const jwt = require("jsonwebtoken");
const User = require("../models/user");

/**
 * Optional authentication middleware - doesn't require authentication
 * but will attach the user to the request if a valid token is present
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      // No token or invalid format - continue as anonymous user
      req.user = null;
      return next();
    }

    const token = authHeader.replace("Bearer ", "");
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (user) {
      req.user = user;
      req.token = token;
    } else {
      req.user = null;
    }

    next();
  } catch (error) {
    // If there's an error with the token, just continue as anonymous
    req.user = null;
    next();
  }
};

module.exports = optionalAuth;
