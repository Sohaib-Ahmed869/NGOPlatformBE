const jwt = require("jsonwebtoken");
const User = require("../models/user");

const isSuperAdmin = async (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized, no token" });
    }

    const token = authHeader.replace("Bearer ", "");
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("-password");

    if (!user || user.role !== "superadmin") {
      return res.status(403).json({ error: "Super admin access required" });
    }

    // Tokens minted at login carry the operator's tokenVersion at that time.
    // Suspending/force-logging-out an operator bumps User.tokenVersion, which
    // invalidates every token already issued to them immediately — without
    // this check "suspend" would only block future logins, not kill an
    // already-issued 30-day token.
    if (decoded.tokenVersion !== user.tokenVersion) {
      return res.status(401).json({ error: "Session expired, please log in again" });
    }

    if (user.platformStatus === "suspended") {
      return res.status(403).json({ error: "This account has been suspended" });
    }

    req.user = user;
    req.token = token;
    next();
  } catch (error) {
    res.status(401).json({ error: "Unauthorized" });
  }
};

module.exports = isSuperAdmin;
