/**
 * config/platformRoles.js
 *
 * THE single source of truth for what each SuperAdmin operator role
 * (`User.platformRole`, only meaningful when `role === "superadmin"`) is
 * allowed to touch. `middleware/requireCapability.js` and
 * `controllers/superAdminUserController.js` both read this table — nowhere
 * else should hardcode a role→capability mapping.
 *
 * Capability groups mirror the SuperAdmin nav sections:
 *   tenants  -> Organisations, Branding Requests, Leads
 *   billing  -> Plans, Features, Coupons, Billing, Invoices
 *   support  -> Support Tickets, Kanban, Contact Queries, Support Sessions
 *              (list/detail/revoke-one, act-as/impersonate)
 *   ops      -> Audit Log, Support Sessions revoke-all (panic switch),
 *              Platform Settings, Team/Users management itself
 */

const ROLE_CAPABILITIES = {
  owner: ["tenants", "billing", "support", "ops"],
  admin: ["tenants", "billing", "support", "ops"],
  support: ["support"],
  billing: ["billing"],
  tenant_manager: ["tenants"],
};

const ROLE_LABELS = {
  owner: "Owner",
  admin: "Admin",
  support: "Support Agent",
  billing: "Billing Operator",
  tenant_manager: "Tenant Manager",
};

const ROLE_DESCRIPTIONS = {
  owner: "Full platform access. The only role that can create, edit or remove other Owners.",
  admin: "Full platform access, same reach as Owner except managing Owner accounts.",
  support: "Support Tickets, Contact Queries, and support sessions — including impersonation.",
  billing: "Plans, Features, Coupons, Billing and Invoices.",
  tenant_manager: "Organisations, Branding Requests and Leads.",
};

// Roles required to have MFA enabled before they can use the SuperAdmin console.
const MFA_REQUIRED_ROLES = ["owner", "admin"];

const ALL_ROLES = Object.keys(ROLE_CAPABILITIES);

function hasCapability(platformRole, capability) {
  return (ROLE_CAPABILITIES[platformRole] || []).includes(capability);
}

function rolesWithCapability(capability) {
  return ALL_ROLES.filter((role) => hasCapability(role, capability));
}

module.exports = {
  ROLE_CAPABILITIES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  MFA_REQUIRED_ROLES,
  ALL_ROLES,
  hasCapability,
  rolesWithCapability,
};
