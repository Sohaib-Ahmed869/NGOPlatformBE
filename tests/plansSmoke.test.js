const { test } = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./_plansHarness");

test("smoke: all plan/entitlement modules load with expected exports", () => {
  const catalog = load("config/featureCatalog");
  assert.ok(catalog.FLAGS && catalog.METERS && catalog.PAGE_TO_FLAG && catalog.FLAG_KEYS);

  const svc = load("services/stripePlanService");
  for (const fn of ["provisionPlan", "syncProduct", "resyncPlan", "repriceChangedCycles", "archivePlanStripe", "migrateSubscribers", "isStripeEnabled"]) {
    assert.equal(typeof svc[fn], "function", `stripePlanService.${fn}`);
  }

  const eff = load("utils/effectiveLimits");
  assert.equal(typeof eff.getEffectiveEntitlements, "function");
  assert.equal(typeof eff.getEffectiveLimits, "function");

  const mw = load("middleware/planEnforcement");
  for (const fn of ["requirePlan", "checkLimit", "requireFeature"]) {
    assert.equal(typeof mw[fn], "function", `planEnforcement.${fn}`);
  }

  const ctrl = load("controllers/planController");
  for (const fn of ["listPlans", "createPlan", "updatePlan", "archivePlan", "migrateSubscribers", "resyncPlan", "getFeatureCatalog", "bulkUpdateEntitlements"]) {
    assert.equal(typeof ctrl[fn], "function", `planController.${fn}`);
  }
});

test("smoke: Plan model has the new flexible fields", () => {
  const Plan = load("models/plan");
  const paths = Plan.schema.paths;
  assert.ok(paths.featureFlags, "featureFlags path exists");
  assert.ok(paths.limits, "limits path exists");
  assert.equal(Plan.schema.path("currency").defaultValue, "aud", "currency defaults to aud");
});
