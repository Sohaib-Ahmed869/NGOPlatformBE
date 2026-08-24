const User = require("../models/user");
const { rolesWithCapability } = require("../config/platformRoles");

/**
 * Operators assignable to a given area — e.g. "who can this lead/contact-query
 * go to?" Excludes suspended accounts and roles without the capability, so a
 * Billing Operator no longer shows up as an assignable "support" staff member.
 */
function listAssignableStaff(capability) {
  return User.find({
    role: "superadmin",
    platformStatus: { $ne: "suspended" },
    platformRole: { $in: rolesWithCapability(capability) },
  })
    .select("name email")
    .sort({ name: 1 });
}

module.exports = { listAssignableStaff };
