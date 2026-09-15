/**
 * services/planService.js — create / fork / update / archive a SaaS plan.
 *
 * Shared by the SuperAdmin console (controllers/planController.js) and the
 * integration API (controllers/integration/planController.js), so a plan edited
 * from either place is validated, Stripe-synced and audited identically.
 *
 * Input uses the model's own camelCase field names; each caller translates its
 * wire format first. Failures throw ServiceError with a stable code.
 *
 * Merge semantics (state these to every caller — the failure is silent):
 *   limits, featureFlags   merged PER KEY — keys not sent are kept
 *   price                  merged PER CYCLE — a cycle not sent is kept
 *   features (bullets)     replaced wholesale
 */
const Plan = require("../models/plan");
const Organisation = require("../models/organisation");
const writeAudit = require("../utils/writeAudit");
const stripePlanService = require("./stripePlanService");
const planPricing = require("../config/planPricing");
const { METER_KEYS, FLAG_KEYS } = require("../config/featureCatalog");
const { emitToSuperAdmins } = require("./socket");
const input = require("../utils/operatorInput");
const { ServiceError } = require("../utils/serviceError");

// Tell every open operator console that the plan catalogue moved, so their
// cached copies revalidate (the console caches plans for the session).
const announcePlans = (code) => emitToSuperAdmins("plan:updated", { code: code || null });

// One platform billing currency (no per-plan currency).
const PLATFORM_CURRENCY = (planPricing.currency || "aud").toLowerCase();

// A plan code ends up in URLs (/superadmin/plans/:code), in Stripe metadata and
// on the public pricing page, so it has to be a slug. Without this, "<script>…"
// and "a/../b" were both accepted as plan codes.
const RE_PLAN_CODE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

// Prices are in whole currency units. Stripe takes an integer number of cents,
// so anything finer than 2dp cannot be charged, and a negative amount is not a
// discount — it's a plan that pays the customer.
const PRICE_RULES = { min: 0, max: 1_000_000, allowNull: true, decimals: 2 };

const invalid = (message, field) => new ServiceError(400, "VALIDATION_ERROR", message, field ? { field } : undefined);

// Mixed/Map/subdoc → plain object.
const toPlain = (v) =>
  !v ? {} : typeof v.toObject === "function" ? v.toObject() : v instanceof Map ? Object.fromEntries(v) : { ...v };

/**
 * Flags a plan whose Stripe provisioning didn't land, so the caller can say so
 * instead of reporting a clean save. Returns {} when Stripe isn't configured —
 * that's a deliberate setup, not something to warn about on every save.
 */
function planSyncWarning(plan) {
  if (!stripePlanService.isStripeEnabled()) return {};
  const missing = ["monthly", "annual"].filter(
    (cycle) => Number(plan.price?.[cycle]) > 0 && !plan.stripePriceIds?.[cycle],
  );
  if (!plan.stripeProductId || missing.length) {
    const what = !plan.stripeProductId ? "product" : `${missing.join(" and ")} price`;
    return {
      stripeSynced: false,
      warning: `Saved, but the Stripe ${what} could not be created — nobody can subscribe to "${plan.code}" until it syncs. Run "npm run fix:stripe-catalog".`,
    };
  }
  return { stripeSynced: true };
}

/**
 * Validate the price block. The old code did `Number(price?.monthly) || 0`,
 * which turned a typo'd "12o" into 0 and published the tier as FREE.
 * @returns {{monthly?:number, annual?:number}}
 */
function parsePrice(price) {
  if (price === undefined || price === null) return {};
  if (typeof price !== "object" || Array.isArray(price)) throw invalid("Price must be an object", "price");
  const out = {};
  for (const cycle of ["monthly", "annual"]) {
    if (price[cycle] === undefined) continue;
    const label = cycle === "monthly" ? "Monthly price" : "Annual price";
    const n = input.number(price[cycle], label, PRICE_RULES);
    if (n.error) throw invalid(n.error, `price.${cycle}`);
    out[cycle] = n.value === null ? 0 : n.value;
  }
  return out;
}

/**
 * Keep only catalog meter keys; "" / null → null (= unlimited). A non-numeric
 * or negative quota is refused rather than coerced — NaN fails every quota
 * comparison, so the plan silently allowed nothing. `strict` refuses unknown
 * keys instead of dropping them.
 */
function sanitizeLimits(limits = {}, { strict = false } = {}) {
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) throw invalid("Limits must be an object", "limits");
  const out = {};
  for (const k of Object.keys(limits)) {
    if (!METER_KEYS.includes(k)) {
      if (strict) throw new ServiceError(400, "UNKNOWN_LIMIT_KEY", `"${k}" is not a limit in the feature catalogue`, { key: k, allowed: METER_KEYS });
      continue;
    }
    if (typeof limits[k] === "boolean") {
      out[k] = limits[k];
      continue;
    }
    const n = input.number(limits[k], `Limit "${k}"`, { min: 0, max: 1e9, allowNull: true, integer: true });
    if (n.error) throw invalid(n.error, `limits.${k}`);
    out[k] = n.value;
  }
  return out;
}

/** Keep only catalog flag keys, coerced to booleans (strict: unknown keys and non-booleans refused). */
function sanitizeFlags(flags = {}, { strict = false } = {}) {
  if (flags === null || typeof flags !== "object" || Array.isArray(flags)) throw invalid("Feature flags must be an object", "feature_flags");
  const out = {};
  for (const k of Object.keys(flags)) {
    if (!FLAG_KEYS.includes(k)) {
      if (strict) throw new ServiceError(400, "UNKNOWN_FEATURE_FLAG", `"${k}" is not a feature flag in the catalogue`, { key: k });
      continue;
    }
    if (strict && typeof flags[k] !== "boolean") throw invalid(`Feature flag "${k}" must be true or false`, `feature_flags.${k}`);
    out[k] = !!flags[k];
  }
  return out;
}

function parseOnboardingFee(v) {
  if (v === undefined) return undefined;
  const n = input.number(v, "Onboarding fee", PRICE_RULES);
  if (n.error) throw invalid(n.error, "onboarding_fee");
  return n.value === null ? 0 : n.value;
}

/** Field-level diff of the editable parts of a plan, for the audit trail. */
function diffPlans(before, after) {
  const changes = {};
  const note = (key, a, b) => {
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changes[key] = { from: a ?? null, to: b ?? null };
  };
  for (const f of ["name", "description", "onboardingFee", "color", "isPublic", "isPopular", "isActive", "sortOrder", "features"]) {
    note(f, before[f], after[f]);
  }
  for (const c of ["monthly", "annual"]) note(`price.${c}`, before.price?.[c], after.price?.[c]);
  for (const group of ["limits", "featureFlags"]) {
    const a = toPlain(before[group]);
    const b = toPlain(after[group]);
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) note(`${group}.${k}`, a[k], b[k]);
  }
  return changes;
}

const snapshot = (plan) => JSON.parse(JSON.stringify(plan.toObject ? plan.toObject() : plan));

/**
 * Create a plan, optionally forked from an existing one.
 *
 * `forkFrom` copies description, price, onboarding fee, limits, feature flags,
 * marketing bullets and colour from the source; anything in `body` wins, with
 * limits and flags merged per key over the copy. A fork defaults to
 * isPublic:false — a bespoke customer plan should not appear on the pricing page.
 *
 * @returns {Promise<{plan:object, stripeSynced?:boolean, warning?:string}>}
 */
async function createPlan(body = {}, req, { strict = false } = {}) {
  const normCode = String(body.code ?? "").toLowerCase().trim().replace(/\s+/g, "-");
  if (!normCode) throw invalid("code and name are required", "code");
  if (!RE_PLAN_CODE.test(normCode)) {
    throw new ServiceError(400, "INVALID_PLAN_CODE", "Plan code must be 3–40 characters, lowercase letters, numbers and hyphens only", { field: "code" });
  }

  let source = null;
  if (body.forkFrom !== undefined && body.forkFrom !== null && body.forkFrom !== "") {
    const forkCode = input.text(body.forkFrom, "fork_from", { max: 60, required: true, allowEmpty: false });
    if (forkCode.error) throw invalid(forkCode.error, "fork_from");
    source = await Plan.findOne({ code: forkCode.value.toLowerCase() });
    if (!source) throw new ServiceError(404, "FORK_SOURCE_NOT_FOUND", `No plan "${forkCode.value}" to fork from`, { fork_from: forkCode.value });
  }

  // The name is capped because Stripe rejects product names over 5 000
  // characters — an over-long name saved here and then permanently broke
  // every later sync for that plan.
  const v = input.collect({
    name: input.text(body.name, "Name", { max: 120, required: true, allowEmpty: false }),
    description: body.description === undefined && source ? { value: source.description || "" } : input.text(body.description, "Description", { max: 500 }),
    sortOrder: input.number(body.sortOrder, "Sort order", { min: -9999, max: 9999, allowNull: true, integer: true }),
    features:
      body.features === undefined && source
        ? { value: [...(source.features || [])] }
        : input.stringList(body.features, "Features", { max: 30, maxLength: 120 }),
  });
  if (v.error) throw invalid(v.error, v.field);

  const price = { ...(source ? { monthly: source.price?.monthly || 0, annual: source.price?.annual || 0 } : {}), ...parsePrice(body.price) };
  const limits = { ...(source ? toPlain(source.limits) : {}), ...(body.limits !== undefined ? sanitizeLimits(body.limits, { strict }) : {}) };
  const featureFlags = {
    ...(source ? toPlain(source.featureFlags) : {}),
    ...(body.featureFlags !== undefined ? sanitizeFlags(body.featureFlags, { strict }) : {}),
  };
  const onboardingFee = parseOnboardingFee(body.onboardingFee);

  if (await Plan.findOne({ code: normCode })) {
    throw new ServiceError(409, "PLAN_CODE_TAKEN", "A plan with this code already exists", { code: normCode });
  }

  const plan = new Plan({
    code: normCode,
    name: v.values.name,
    description: v.values.description,
    currency: PLATFORM_CURRENCY, // single platform currency
    price: { monthly: price.monthly || 0, annual: price.annual || 0 },
    onboardingFee: onboardingFee ?? (source ? source.onboardingFee || 0 : 0),
    limits,
    featureFlags,
    features: v.values.features,
    color: body.color || source?.color || "#10b981",
    isPublic: body.isPublic === undefined ? !source : body.isPublic !== false,
    isPopular: !!body.isPopular,
    sortOrder: v.values.sortOrder ?? (source ? source.sortOrder || 0 : 0),
  });

  // Provision in Stripe (best-effort — plan still saves if Stripe is down).
  try {
    const synced = await stripePlanService.provisionPlan(plan);
    plan.stripeProductId = synced.stripeProductId;
    plan.stripePriceIds = synced.stripePriceIds;
  } catch (e) {
    console.error("Stripe provision failed (plan saved unsynced):", e.message);
  }

  try {
    await plan.save();
  } catch (err) {
    // Two callers saving the same new code milliseconds apart both clear the
    // findOne above; the unique index catches the loser and it belongs as a 409.
    if (input.isDuplicateKey(err)) throw new ServiceError(409, "PLAN_CODE_TAKEN", "A plan with this code already exists", { code: normCode });
    throw err;
  }
  await writeAudit(req, "plan.created", {
    targetType: "plan",
    targetId: plan.code,
    meta: { name: plan.name, price: plan.price, forkedFrom: source?.code || null },
  });
  announcePlans(plan.code);
  // A plan with no Stripe Price can't be subscribed to — don't report that as clean.
  return { plan, ...planSyncWarning(plan) };
}

/**
 * Update a plan in place. See the merge semantics at the top of this file.
 * @returns {Promise<{plan, priceChanged:boolean, subscribersAffected:number, changes:object}>}
 */
async function updatePlan(code, body = {}, req, { strict = false } = {}) {
  const plan = await Plan.findOne({ code });
  if (!plan) throw new ServiceError(404, "PLAN_NOT_FOUND", "Plan not found", { code });

  const { name, description, price, limits, featureFlags, features, color, isPublic, isPopular, isActive, sortOrder } = body;

  // Validate everything BEFORE mutating the document, so a rejected save
  // leaves the plan exactly as it was.
  const v = input.collect({
    name: name === undefined ? { value: undefined } : input.text(name, "Name", { max: 120, required: true, allowEmpty: false }),
    description: description === undefined ? { value: undefined } : input.text(description, "Description", { max: 500 }),
    sortOrder: sortOrder === undefined ? { value: undefined } : input.number(sortOrder, "Sort order", { min: -9999, max: 9999, integer: true }),
    features: features === undefined ? { value: undefined } : input.stringList(features, "Features", { max: 30, maxLength: 120 }),
  });
  if (v.error) throw invalid(v.error, v.field);
  const parsedLimits = limits !== undefined ? sanitizeLimits(limits, { strict }) : undefined;
  const parsedFlags = featureFlags !== undefined ? sanitizeFlags(featureFlags, { strict }) : undefined;
  const parsedPrice = parsePrice(price);
  const onboardingFee = parseOnboardingFee(body.onboardingFee);

  const before = snapshot(plan);
  const prevName = plan.name;
  const prevDescription = plan.description;
  const wasActive = plan.isActive !== false;

  if (v.values.name !== undefined) plan.name = v.values.name;
  if (v.values.description !== undefined) plan.description = v.values.description;
  // currency is platform-wide (PLATFORM_CURRENCY) — intentionally not editable.
  if (parsedLimits) {
    plan.limits = { ...toPlain(plan.limits), ...parsedLimits };
    plan.markModified("limits");
  }
  if (parsedFlags) {
    plan.featureFlags = { ...toPlain(plan.featureFlags), ...parsedFlags };
    plan.markModified("featureFlags");
  }
  if (v.values.features !== undefined) plan.features = v.values.features;
  if (onboardingFee !== undefined) plan.onboardingFee = onboardingFee;
  if (color !== undefined) plan.color = color;
  if (isPublic !== undefined) plan.isPublic = !!isPublic;
  if (isPopular !== undefined) plan.isPopular = !!isPopular;
  if (v.values.sortOrder !== undefined) plan.sortOrder = v.values.sortOrder;
  if (isActive !== undefined) {
    plan.isActive = !!isActive;
    if (isActive) plan.archivedAt = null;
  }

  // Push name/description edits to the Stripe Product (best-effort).
  if (plan.stripeProductId && (plan.name !== prevName || plan.description !== prevDescription)) {
    try {
      await stripePlanService.syncProduct(plan);
    } catch (e) {
      console.error("Stripe product sync failed:", e.message);
    }
  }

  // Archiving deactivated the Stripe product and prices; un-archiving has to
  // switch them back on or the plan is back on sale with nothing to buy.
  if (!wasActive && plan.isActive) {
    try {
      await stripePlanService.unarchivePlanStripe(plan);
    } catch (e) {
      console.error("Stripe unarchive failed:", e.message);
    }
  }

  // Detect amount changes per cycle (against the validated values).
  const changed = [];
  for (const cycle of ["monthly", "annual"]) {
    if (parsedPrice[cycle] !== undefined && parsedPrice[cycle] !== Number(plan.price[cycle])) changed.push(cycle);
  }

  let priceChanged = false;
  if (changed.length) {
    // Snapshot the old amounts + price IDs before mutating (grandfathering).
    plan.priceHistory.push({
      monthly: plan.price.monthly,
      annual: plan.price.annual,
      stripePriceIds: {
        monthly: plan.stripePriceIds?.monthly || "",
        annual: plan.stripePriceIds?.annual || "",
      },
      replacedAt: new Date(),
    });
    for (const cycle of changed) plan.price[cycle] = parsedPrice[cycle];

    // Mint new immutable Stripe Prices for the changed cycles.
    try {
      const synced = await stripePlanService.repriceChangedCycles(plan, changed);
      if (synced.stripeProductId) plan.stripeProductId = synced.stripeProductId;
      for (const cycle of changed) {
        if (synced.stripePriceIds?.[cycle] !== undefined) plan.stripePriceIds[cycle] = synced.stripePriceIds[cycle];
      }
    } catch (e) {
      console.error("Stripe reprice failed:", e.message);
    }
    priceChanged = true;
  }

  await plan.save();

  // How many live-subscription tenants are still on the old price.
  let subscribersAffected = 0;
  if (priceChanged) {
    subscribersAffected = await Organisation.countDocuments({
      plan: plan.code,
      stripeSubscriptionId: { $nin: [null, ""] },
      subscriptionStatus: "active",
    });
  }

  const changes = diffPlans(before, snapshot(plan));
  await writeAudit(req, priceChanged ? "plan.price_changed" : "plan.updated", {
    targetType: "plan",
    targetId: plan.code,
    meta: { changed, price: plan.price, changes },
  });
  announcePlans(plan.code);
  return { plan, priceChanged, subscribersAffected, changes };
}

/**
 * Archive: off-sale for new assignments; existing subscribers keep renewing
 * (Stripe keeps billing subscriptions on a deactivated Price). With tenants
 * still active on the plan the caller must pass confirm:true.
 */
async function archivePlan(code, { confirm = false } = {}, req) {
  const plan = await Plan.findOne({ code });
  if (!plan) throw new ServiceError(404, "PLAN_NOT_FOUND", "Plan not found", { code });
  if (plan.isActive === false) throw new ServiceError(409, "PLAN_ALREADY_ARCHIVED", `"${code}" is already archived`, { code });

  const stillOn = await Organisation.countDocuments({ plan: plan.code, subscriptionStatus: "active", deletedAt: null });
  if (stillOn > 0 && confirm !== true) {
    throw new ServiceError(
      409,
      "PLAN_HAS_ACTIVE_TENANTS",
      `${stillOn} active tenant${stillOn === 1 ? " is" : "s are"} still on "${plan.code}". Move them to another plan first, or resend with confirm:true to archive anyway.`,
      { subscribersAffected: stillOn, needsConfirmation: true },
    );
  }

  plan.isActive = false;
  plan.isPublic = false;
  plan.archivedAt = new Date();
  await plan.save();
  await stripePlanService.archivePlanStripe(plan);
  await writeAudit(req, "plan.archived", {
    targetType: "plan",
    targetId: plan.code,
    meta: { subscribersAffected: stillOn, forced: stillOn > 0 },
  });
  announcePlans(plan.code);
  return { plan, subscribersAffected: stillOn };
}

module.exports = {
  PLATFORM_CURRENCY,
  RE_PLAN_CODE,
  announcePlans,
  planSyncWarning,
  sanitizeLimits,
  sanitizeFlags,
  toPlain,
  createPlan,
  updatePlan,
  archivePlan,
};
