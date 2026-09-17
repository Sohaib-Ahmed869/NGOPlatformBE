/**
 * services/tenantLifecycle.js — the operator actions that change a tenant's
 * lifecycle or entitlements: suspend, reactivate/restore, soft delete, rename,
 * assign a plan, and set/clear a per-tenant override.
 *
 * Called from two places that must never disagree about what these actions do:
 *   - the SuperAdmin console   (controllers/superAdminController.js)
 *   - the integration API      (controllers/integration/tenantController.js)
 *
 * Every function saves, audits (utils/writeAudit.js — which attributes the
 * write to the operator or to the integration caller), announces the change to
 * open consoles, and returns `{ organisation, changed, warnings }`. Failures are
 * thrown as ServiceError with a stable code; nothing here writes a response.
 */
const User = require("../models/user");
const Plan = require("../models/plan");
const writeAudit = require("../utils/writeAudit");
const input = require("../utils/operatorInput");
const stripePrices = require("../config/stripePrices");
const { FLAG_MAP, METER_KEYS } = require("../config/featureCatalog");
const { stripe, isStripeConfigured } = require("./platformStripe");
const { emitToSuperAdmins } = require("./socket");
const { ServiceError } = require("../utils/serviceError");

// Plan codes that predate the Plan collection. Still assignable when no Plan
// document exists, exactly as the console always allowed.
const LEGACY_PLAN_CODES = ["essentials", "professional", "enterprise"];

const announce = (org) => emitToSuperAdmins("organisation:updated", { organisationId: String(org._id) });

/**
 * The single status a tenant is in, from the four fields that encode it.
 *   deleted   — soft-deleted (data kept)
 *   active    — portal live
 *   pending   — self-serve signup that never completed its first payment
 *   suspended — portal locked (by an operator, or its Stripe subscription ended)
 */
function tenantStatus(org) {
  if (org.deletedAt) return "deleted";
  if (org.isActive) return "active";
  if (org.subscriptionStatus === "pending" && !org.adminUserId) return "pending";
  return "suspended";
}

/** True when the org's Stripe subscription is still expected to bill. */
function hasLiveStripeSubscription(org) {
  return !!(org.stripeSubscriptionId && !org.stripeSubscriptionEndedAt);
}

const isMissingResource = (err) => err && (err.code === "resource_missing" || err.statusCode === 404);

/**
 * Cancel the tenant's platform Stripe subscription, if it has a live one.
 * Mutates `org.stripeSubscriptionEndedAt` on success; the caller saves.
 * @returns {Promise<{outcome:"none"|"cancelled"|"already_ended"|"failed", message?:string}>}
 */
async function endStripeSubscription(org) {
  if (!hasLiveStripeSubscription(org)) return { outcome: "none" };
  if (!isStripeConfigured()) {
    return { outcome: "failed", message: "Stripe is not configured, so the subscription could not be cancelled" };
  }
  try {
    const sub = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
    if (sub.status === "canceled") {
      org.stripeSubscriptionEndedAt = new Date();
      return { outcome: "already_ended" };
    }
    await stripe.subscriptions.cancel(org.stripeSubscriptionId);
    org.stripeSubscriptionEndedAt = new Date();
    return { outcome: "cancelled" };
  } catch (err) {
    if (isMissingResource(err)) {
      org.stripeSubscriptionEndedAt = new Date();
      return { outcome: "already_ended" };
    }
    console.error(`Stripe cancellation failed for ${org.slug}:`, err.message);
    return { outcome: "failed", message: err.message };
  }
}

/**
 * Sign out every staff account of the tenant by bumping tokenVersion, which
 * middleware/authMiddleware.js `protect` checks on each request. The tenant
 * middleware already refuses an inactive org's traffic; this closes the
 * sessions themselves so a reactivation doesn't quietly revive them.
 */
async function revokeTenantSessions(org) {
  const r = await User.updateMany(
    { organisationId: org._id, role: { $in: ["admin", "superadmin"] } },
    { $inc: { tokenVersion: 1 } },
  );
  return r.modifiedCount || 0;
}

const billingWarning = (billing) =>
  billing.outcome === "failed"
    ? [{
        code: "STRIPE_CANCEL_FAILED",
        message: `Access was locked, but the Stripe subscription is still live and may keep billing: ${billing.message}`,
      }]
    : [];

/** Lock the portal and stop platform billing. Idempotent on an already-suspended tenant. */
async function suspendTenant(org, req, { reason = "" } = {}) {
  const status = tenantStatus(org);
  if (status === "deleted") throw new ServiceError(409, "TENANT_DELETED", "This tenant is deleted — restore it before changing its status");
  if (status === "pending") throw new ServiceError(409, "TENANT_PENDING_PAYMENT", "This tenant never completed signup, so there is nothing to suspend");
  if (status === "suspended" && org.subscriptionStatus === "cancelled" && !hasLiveStripeSubscription(org)) {
    return { organisation: org, changed: false, warnings: [] };
  }

  const billing = await endStripeSubscription(org);
  org.isActive = false;
  org.subscriptionStatus = "cancelled";
  await org.save();
  const sessionsRevoked = await revokeTenantSessions(org);

  await writeAudit(req, "org.suspended", {
    organisationId: org._id,
    targetType: "organisation",
    targetId: String(org._id),
    meta: { name: org.name, slug: org.slug, reason, stripe: billing.outcome, sessionsRevoked },
  });
  announce(org);
  return { organisation: org, changed: true, warnings: billingWarning(billing), billing: billing.outcome, sessionsRevoked };
}

/**
 * Re-open a suspended tenant, or restore a soft-deleted one. Platform billing
 * is NOT restarted: a Stripe subscription cancelled on suspend/delete stays
 * cancelled, so the tenant runs unbilled until it is comped or re-subscribed.
 *
 * @param {object} opts
 * @param {"active"|"suspended"} [opts.to="active"] — restoring a deleted
 *   tenant straight into "suspended" is allowed (undelete without reopening).
 */
async function reactivateTenant(org, req, { reason = "", to = "active" } = {}) {
  const status = tenantStatus(org);
  if (status === "pending") {
    throw new ServiceError(409, "TENANT_PENDING_PAYMENT", "This tenant never completed its first payment; activating it would skip billing and it has no owner account");
  }
  if (!org.adminUserId) {
    throw new ServiceError(409, "TENANT_HAS_NO_OWNER", "This tenant has no owner account, so reopening it would leave nobody able to sign in");
  }
  if (status === to) return { organisation: org, changed: false, warnings: [] };

  const wasDeleted = status === "deleted";
  if (wasDeleted) {
    org.deletedAt = null;
    org.deletedBy = null;
  }
  if (to === "active") {
    org.isActive = true;
    org.subscriptionStatus = "active";
  }
  await org.save();

  const action = wasDeleted ? "org.restored" : "org.reactivated";
  await writeAudit(req, action, {
    organisationId: org._id,
    targetType: "organisation",
    targetId: String(org._id),
    meta: { name: org.name, slug: org.slug, reason, from: status, to },
  });
  announce(org);

  const warnings = [];
  if (to === "active" && !org.isComp && !hasLiveStripeSubscription(org)) {
    warnings.push({
      code: "BILLING_NOT_RESTARTED",
      message:
        "The tenant is open again but nothing bills it: it is not comped and has no live Stripe subscription (a subscription cancelled by suspend/delete is not restarted)",
    });
  }
  return { organisation: org, changed: true, warnings };
}

/** Soft delete: lock + cancel billing + hide from lists. Nothing is erased. */
async function softDeleteTenant(org, req, { reason = "" } = {}) {
  if (org.deletedAt) throw new ServiceError(409, "TENANT_ALREADY_DELETED", "Organisation already deleted");

  const billing = await endStripeSubscription(org);
  org.isActive = false;
  org.subscriptionStatus = "cancelled";
  org.deletedAt = new Date();
  org.deletedBy = req?.user?._id || null;
  await org.save();
  const sessionsRevoked = await revokeTenantSessions(org);

  await writeAudit(req, "org.deleted", {
    organisationId: org._id,
    targetType: "organisation",
    targetId: String(org._id),
    meta: { name: org.name, slug: org.slug, reason, stripe: billing.outcome, sessionsRevoked },
  });
  announce(org);
  return { organisation: org, changed: true, warnings: billingWarning(billing), billing: billing.outcome, sessionsRevoked };
}

/** Change the display name. The slug is a DNS label and never changes. */
async function renameTenant(org, rawName, req, { reason = "" } = {}) {
  const parsed = input.text(rawName, "Name", { max: 200, required: true, allowEmpty: false });
  if (parsed.error) throw new ServiceError(400, "VALIDATION_ERROR", parsed.error, { field: "name" });
  if (parsed.value === org.name) return { organisation: org, changed: false, warnings: [] };

  const from = org.name;
  org.name = parsed.value;
  await org.save();
  await writeAudit(req, "org.renamed", {
    organisationId: org._id,
    targetType: "organisation",
    targetId: String(org._id),
    meta: { from, to: org.name, reason },
  });
  announce(org);
  return { organisation: org, changed: true, warnings: [] };
}

/**
 * Put the tenant on a plan and/or billing cycle.
 *
 * With a live Stripe subscription, the subscription item is swapped to the
 * plan's current Stripe Price for that cycle (proration: create_prorations —
 * credited/charged on the next invoice, not immediately). Stripe keeps the
 * billing anchor for a same-interval swap and resets it to now when the
 * interval changes. If the Stripe update fails, NOTHING is saved — a tenant on
 * the new plan's features but still paying the old price is the failure this
 * refuses to create.
 *
 * Without a live subscription (comped, manually provisioned, or billing ended)
 * only the stored plan changes. The tenant's status is never touched.
 */
async function assignPlan(org, { planCode, billingCycle } = {}, req, { reason = "" } = {}) {
  const parsed = input.text(planCode, "Plan", { max: 60, required: true, allowEmpty: false });
  if (parsed.error) throw new ServiceError(400, "VALIDATION_ERROR", "Invalid plan", { field: "plan_code" });
  const code = parsed.value.toLowerCase();

  const cycle = billingCycle === undefined || billingCycle === null ? org.billingCycle || "monthly" : billingCycle;
  if (!["monthly", "annual"].includes(cycle)) {
    throw new ServiceError(400, "VALIDATION_ERROR", "Billing cycle must be monthly or yearly", { field: "billing_cycle" });
  }

  // Prefer a dynamic Plan; fall back to the legacy static tiers so this keeps
  // working before the Plan collection has been seeded.
  const planDoc = await Plan.findOne({ code });
  if (!planDoc && !LEGACY_PLAN_CODES.includes(code)) {
    throw new ServiceError(404, "PLAN_NOT_FOUND", "Invalid plan", { plan_code: code });
  }
  // An archived plan is off-sale. Moving a tenant onto one leaves them on a
  // tier nobody can newly buy.
  if (planDoc && planDoc.isActive === false) {
    throw new ServiceError(409, "PLAN_ARCHIVED", `"${code}" is archived — reactivate the plan before assigning it`, { plan_code: code });
  }
  if (org.deletedAt) throw new ServiceError(409, "TENANT_DELETED", "This tenant is deleted — restore it before changing its plan");

  const fromPlan = org.plan;
  const fromCycle = org.billingCycle || "monthly";
  if (fromPlan === code && fromCycle === cycle) {
    return { organisation: org, changed: false, warnings: [], billingSync: { status: "skipped", reason: "unchanged" } };
  }

  let billingSync = { status: "skipped", reason: org.isComp ? "comp" : "no_live_subscription" };
  if (hasLiveStripeSubscription(org)) {
    if (!isStripeConfigured()) {
      throw new ServiceError(503, "STRIPE_UNAVAILABLE", "This tenant has a live Stripe subscription but Stripe is not configured, so the plan change can't be billed");
    }
    let sub = null;
    try {
      sub = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
    } catch (err) {
      if (!isMissingResource(err)) {
        throw new ServiceError(502, "STRIPE_UPDATE_FAILED", `Stripe could not be reached: ${err.message}`);
      }
    }
    if (!sub || sub.status === "canceled") {
      // Stripe says it has already ended — record that and treat the tenant as unbilled.
      org.stripeSubscriptionEndedAt = new Date();
    } else {
      const priceId = planDoc?.stripePriceIds?.[cycle] || stripePrices[code]?.[cycle];
      if (!priceId) {
        throw new ServiceError(
          409,
          "PLAN_NOT_BILLABLE",
          `"${code}" has no Stripe price for ${cycle === "annual" ? "yearly" : "monthly"} billing, so this tenant's paying subscription can't be moved onto it`,
          { plan_code: code, billing_cycle: cycle },
        );
      }
      const item = sub.items?.data?.[0];
      if (!item) throw new ServiceError(502, "STRIPE_UPDATE_FAILED", "The tenant's Stripe subscription has no items to update");
      if (item.price?.id === priceId) {
        billingSync = { status: "skipped", reason: "already_on_price" };
      } else {
        try {
          await stripe.subscriptions.update(org.stripeSubscriptionId, {
            items: [{ id: item.id, price: priceId }],
            proration_behavior: "create_prorations",
            metadata: { plan: code, billingCycle: cycle },
          });
        } catch (err) {
          throw new ServiceError(502, "STRIPE_UPDATE_FAILED", `Stripe rejected the plan change, so nothing was changed: ${err.message}`);
        }
        billingSync = {
          status: "updated",
          proration: "create_prorations",
          billing_anchor_reset: (item.price?.recurring?.interval || null) !== (cycle === "annual" ? "year" : "month"),
        };
      }
    }
  }

  org.plan = code;
  org.billingCycle = cycle;
  await org.save();

  await writeAudit(req, "subscription.plan_changed", {
    organisationId: org._id,
    targetType: "organisation",
    targetId: String(org._id),
    meta: { from: fromPlan, to: code, fromCycle, toCycle: cycle, billingSync, reason },
  });
  announce(org);
  return { organisation: org, changed: true, warnings: [], billingSync };
}

/**
 * Replace the tenant's override wholesale (PUT semantics — keys you leave out
 * are gone). `strict` rejects catalog keys it doesn't know instead of dropping
 * them; the integration API is strict, the console is not.
 */
async function setOverride(org, body = {}, req, { strict = false } = {}) {
  const { limits, featureFlags, pricing } = body;
  const parsedReason = input.text(body.reason, "Reason", { max: 500, required: true, allowEmpty: false });
  if (parsedReason.error) throw new ServiceError(400, "REASON_REQUIRED", "A reason is required", { field: "reason" });

  const badShape = (v) => v !== undefined && v !== null && (typeof v !== "object" || Array.isArray(v));
  if (badShape(limits)) throw new ServiceError(400, "VALIDATION_ERROR", "Limits must be an object", { field: "limits" });
  if (badShape(featureFlags)) throw new ServiceError(400, "VALIDATION_ERROR", "Feature flags must be an object", { field: "feature_flags" });
  if (badShape(pricing)) throw new ServiceError(400, "VALIDATION_ERROR", "Pricing must be an object", { field: "pricing" });

  // Limits are validated against the catalog's meter keys and the numbers are
  // checked rather than coerced. `Number(v)` alone wrote NaN into the document
  // for a typo, and NaN compares false against every quota — the tenant ended
  // up with an override that silently blocked everything.
  const cleanLimits = {};
  for (const k of Object.keys(limits || {})) {
    if (!METER_KEYS.includes(k)) {
      if (strict) throw new ServiceError(400, "UNKNOWN_LIMIT_KEY", `"${k}" is not a limit in the feature catalogue`, { key: k, allowed: METER_KEYS });
      continue;
    }
    const v = limits[k];
    if (typeof v === "boolean") {
      cleanLimits[k] = v;
      continue;
    }
    const n = input.number(v, `Limit "${k}"`, { min: 0, max: 1e9, allowNull: true, integer: true });
    if (n.error) throw new ServiceError(400, "VALIDATION_ERROR", n.error, { field: `limits.${k}` });
    cleanLimits[k] = n.value;
  }

  const cleanFlags = {};
  for (const k of Object.keys(featureFlags || {})) {
    const def = FLAG_MAP[k];
    if (!def) {
      if (strict) throw new ServiceError(400, "UNKNOWN_FEATURE_FLAG", `"${k}" is not a feature flag in the catalogue`, { key: k });
      continue;
    }
    if (typeof featureFlags[k] !== "boolean") {
      throw new ServiceError(400, "VALIDATION_ERROR", `Feature flag "${k}" must be true or false`, { field: `feature_flags.${k}` });
    }
    if (def.core && featureFlags[k] === false) {
      throw new ServiceError(400, "CORE_FLAG_LOCKED", `"${k}" is a core capability and cannot be switched off`, { key: k });
    }
    if (!def.core) cleanFlags[k] = featureFlags[k];
  }

  const cleanPricing = {};
  for (const cycle of ["monthly", "annual"]) {
    const n = input.number(pricing?.[cycle], `${cycle === "annual" ? "Yearly" : "Monthly"} price`, {
      min: 0,
      max: 1e7,
      allowNull: true,
      decimals: 2,
    });
    if (n.error) throw new ServiceError(400, "VALIDATION_ERROR", n.error, { field: `pricing.${cycle}` });
    cleanPricing[cycle] = n.value;
  }

  org.override = {
    limits: Object.keys(cleanLimits).length ? cleanLimits : null,
    featureFlags: Object.keys(cleanFlags).length ? cleanFlags : null,
    pricing: cleanPricing,
    reason: parsedReason.value,
    setBy: req?.user?._id || null,
    setByLabel: req?.integration?.actorLabel || req?.user?.email || "",
    setAt: new Date(),
  };
  await org.save();
  await writeAudit(req, "org.override_set", {
    organisationId: org._id,
    targetType: "organisation",
    targetId: String(org._id),
    meta: { limits: cleanLimits, featureFlags: cleanFlags, pricing: cleanPricing, reason: parsedReason.value },
  });
  announce(org);
  return { organisation: org, changed: true, warnings: [] };
}

/** True when the org carries an override with any actual content. */
function hasOverride(org) {
  const o = org?.override;
  if (!o) return false;
  const nonEmpty = (v) => v && typeof v === "object" && Object.keys(v.toObject ? v.toObject() : v).length > 0;
  return !!(nonEmpty(o.limits) || nonEmpty(o.featureFlags) || o.pricing?.monthly != null || o.pricing?.annual != null);
}

async function clearOverride(org, req, { reason = "" } = {}) {
  if (!hasOverride(org)) return { organisation: org, changed: false, warnings: [] };
  org.override = undefined;
  await org.save();
  await writeAudit(req, "org.override_cleared", {
    organisationId: org._id,
    targetType: "organisation",
    targetId: String(org._id),
    meta: { reason },
  });
  announce(org);
  return { organisation: org, changed: true, warnings: [] };
}

/**
 * Comp (free of charge) or un-comp a tenant. A reason is required to comp —
 * a whitespace-only reason used to satisfy the old check, leaving a free
 * tenant with no recorded justification.
 *
 * Comping does not cancel a live Stripe subscription, and un-comping does not
 * start one: this flag records who pays, it doesn't move money.
 */
async function setComp(org, { isComp, reason } = {}, req) {
  if (typeof isComp !== "boolean") throw new ServiceError(400, "VALIDATION_ERROR", "is_comp must be true or false", { field: "is_comp" });
  const parsed = input.text(reason, "Reason", { max: 500, required: isComp, allowEmpty: !isComp });
  if (parsed.error) {
    throw isComp
      ? new ServiceError(400, "REASON_REQUIRED", "A reason is required", { field: "reason" })
      : new ServiceError(400, "VALIDATION_ERROR", parsed.error, { field: "reason" });
  }
  if (org.deletedAt) throw new ServiceError(409, "TENANT_DELETED", "This tenant is deleted — restore it before changing its billing");

  const value = parsed.value || "";
  if (!!org.isComp === isComp && (!isComp || org.compReason === value)) return { organisation: org, changed: false, warnings: [] };

  org.isComp = isComp;
  org.compReason = isComp ? value : "";
  await org.save();
  await writeAudit(req, isComp ? "org.comped" : "org.uncomped", {
    organisationId: org._id,
    targetType: "organisation",
    targetId: String(org._id),
    meta: { reason: value },
  });
  announce(org);

  const warnings = [];
  if (isComp && hasLiveStripeSubscription(org)) {
    warnings.push({ code: "STRIPE_STILL_BILLING", message: "The tenant is marked comped but its Stripe subscription is still live and will keep charging" });
  }
  if (!isComp && !hasLiveStripeSubscription(org) && tenantStatus(org) === "active") {
    warnings.push({ code: "NOT_BILLED", message: "The tenant is no longer comped and has no Stripe subscription — nothing will bill it automatically" });
  }
  return { organisation: org, changed: true, warnings };
}

/**
 * Set (or clear, with null) the trial end date. Informational — nothing locks
 * the tenant when it passes. A date already in the past is refused: it reads
 * as "set" while gating nothing.
 */
async function setTrial(org, { trialEndsAt, reason = "" } = {}, req) {
  const parsed = input.date(trialEndsAt, "Trial end date", { allowNull: true, future: true });
  if (parsed.error) throw new ServiceError(400, "VALIDATION_ERROR", parsed.error, { field: "trial_ends_at" });
  if (org.deletedAt) throw new ServiceError(409, "TENANT_DELETED", "This tenant is deleted — restore it before changing its trial");

  const from = org.trialEndsAt || null;
  org.trialEndsAt = parsed.value;
  await org.save();
  await writeAudit(req, "org.trial_set", {
    organisationId: org._id,
    targetType: "organisation",
    targetId: String(org._id),
    meta: { trialEndsAt: org.trialEndsAt, from, ...(reason ? { reason } : {}) },
  });
  announce(org);
  return { organisation: org, changed: true, warnings: [] };
}

module.exports = {
  LEGACY_PLAN_CODES,
  tenantStatus,
  hasLiveStripeSubscription,
  hasOverride,
  endStripeSubscription,
  revokeTenantSessions,
  suspendTenant,
  reactivateTenant,
  softDeleteTenant,
  renameTenant,
  assignPlan,
  setOverride,
  clearOverride,
  setComp,
  setTrial,
};
