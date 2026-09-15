/**
 * Helpers shared by the integration controllers.
 */
const mongoose = require("mongoose");
const Organisation = require("../../models/organisation");
const input = require("../../utils/operatorInput");
const { ServiceError } = require("../../utils/serviceError");

/**
 * Refuse fields this endpoint doesn't know. Silently ignoring them is how
 * `featureFlags` (camelCase) instead of `feature_flags` would "succeed" while
 * changing nothing — exactly the silent failure a caller can't see.
 */
function assertKnownFields(body, allowed) {
  if (body === undefined || body === null) return;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ServiceError(400, "VALIDATION_ERROR", "The request body must be a JSON object");
  }
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new ServiceError(400, "UNKNOWN_FIELD", `Unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`, {
      unknown,
      allowed,
    });
  }
}

/** Optional audit `reason`, capped. */
function reasonFrom(body) {
  const r = input.text(body?.reason, "reason", { max: 500 });
  if (r.error) throw new ServiceError(400, "VALIDATION_ERROR", r.error, { field: "reason" });
  return r.value;
}

function requireBoolean(v, field) {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new ServiceError(400, "VALIDATION_ERROR", `${field} must be true or false`, { field });
  return v;
}

const isObjectId = (v) => mongoose.Types.ObjectId.isValid(v) && String(new mongoose.Types.ObjectId(v)) === String(v);

/**
 * Resolve `:id` to an Organisation — by ObjectId, or by slug for convenience.
 * Deleted tenants ARE found (they can be read and restored).
 */
async function findTenant(idOrSlug) {
  const key = String(idOrSlug || "").trim();
  if (!key) return null;
  if (isObjectId(key)) {
    const byId = await Organisation.findById(key);
    if (byId) return byId;
  }
  if (/^[a-z0-9-]{1,63}$/.test(key)) return Organisation.findOne({ slug: key });
  return null;
}

/** Route middleware: loads req.tenant or answers 404 TENANT_NOT_FOUND. */
const loadTenant = async (req, res, next) => {
  try {
    const org = await findTenant(req.params.id);
    if (!org) throw new ServiceError(404, "TENANT_NOT_FOUND", "No tenant with that id or slug", { id: req.params.id });
    req.tenant = org;
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { assertKnownFields, reasonFrom, requireBoolean, isObjectId, findTenant, loadTenant };
