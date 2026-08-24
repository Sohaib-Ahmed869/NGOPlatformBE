const { hasCapability } = require("../config/platformRoles");

/**
 * Must run after isSuperAdmin (needs req.user). Fails closed: a superadmin
 * row with no platformRole yet (not migrated — see scripts/migratePlatformRoles.js)
 * is denied rather than defaulted to full access.
 */
function requireCapability(capability) {
  return (req, res, next) => {
    if (!hasCapability(req.user?.platformRole, capability)) {
      return res.status(403).json({ error: "You don't have access to this area" });
    }
    next();
  };
}

module.exports = requireCapability;
