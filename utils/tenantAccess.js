const Organisation = require("../models/organisation");

const SUSPENDED_MESSAGE = "This organisation's account is suspended. Please contact support.";

/**
 * Why this user may not sign in because of their ORGANISATION, or null.
 *
 * A suspended or soft-deleted tenant's traffic is already refused by
 * middleware/tenant.js, but sign-in lives on the non-tenant /api/users routes,
 * so a suspended charity's admins and donors could still obtain fresh tokens.
 * Platform operators (no organisationId) are never blocked here.
 */
async function organisationLoginBlock(user) {
  if (!user || !user.organisationId || user.role === "superadmin") return null;
  const org = await Organisation.findById(user.organisationId).select("isActive deletedAt").lean();
  if (!org) return null;
  if (org.deletedAt || !org.isActive) return SUSPENDED_MESSAGE;
  return null;
}

module.exports = { organisationLoginBlock, SUSPENDED_MESSAGE };
