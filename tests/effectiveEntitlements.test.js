const { test } = require("node:test");
const assert = require("node:assert/strict");
const { inject, load } = require("./_plansHarness");

// The plan doc that Plan.findOne(...).select(...) resolves to (set per test).
let nextPlanDoc = undefined;
inject("models/plan", {
  findOne: () => ({ select: () => Promise.resolve(nextPlanDoc) }),
});

// Real resolver, running against the faked Plan model.
const { getEffectiveEntitlements, getEffectiveLimits } = load("utils/effectiveLimits");

test("no dynamic plan → legacy static fallback (basic)", async () => {
  nextPlanDoc = null;
  const { features, limits } = await getEffectiveEntitlements({ plan: "basic" });
  // Legacy config/planLimits.basic = { campaigns:3, volunteers:0, volunteerEnabled:false }
  assert.equal(limits.campaigns, 3);
  assert.equal(limits.volunteers, 0);
  assert.equal(features.volunteers, false, "volunteerEnabled:false → volunteers flag off");
  // Other flags default available in the legacy branch.
  assert.equal(features.events, true);
});

test("plan with NO featureFlags configured → gates nothing (all flags on)", async () => {
  nextPlanDoc = { limits: { campaigns: 7 }, featureFlags: {} };
  const { features, limits } = await getEffectiveEntitlements({ plan: "x" });
  assert.equal(features.events, true);
  assert.equal(features.newsletter, true);
  assert.equal(limits.campaigns, 7);
});

test("configured featureFlags gate non-core flags; core stays on", async () => {
  nextPlanDoc = {
    limits: { campaigns: 5, volunteers: 50 },
    featureFlags: { events: false, newsletter: true, volunteers: true },
  };
  const { features } = await getEffectiveEntitlements({ plan: "pro" });
  assert.equal(features.events, false, "explicitly off");
  assert.equal(features.newsletter, true, "explicitly on");
  assert.equal(features.volunteers, true);
  // Unset non-core flag → off once any config exists.
  assert.equal(features.p2pCampaigns, false, "unset non-core → off");
  // Core flags are always on regardless of config.
  assert.equal(features.donations, true);
  assert.equal(features.cmsPages, true);
  assert.equal(features.ownStripe, true);
});

test("null limit = unlimited passes through", async () => {
  nextPlanDoc = { limits: { campaigns: null }, featureFlags: {} };
  const { limits } = await getEffectiveEntitlements({ plan: "ent" });
  assert.equal(limits.campaigns, null);
});

test("per-tenant override merges over plan (limits + flags)", async () => {
  nextPlanDoc = {
    limits: { campaigns: 5 },
    featureFlags: { events: false },
  };
  const org = {
    plan: "pro",
    override: { limits: { campaigns: 999, events: true } },
  };
  const { features, limits } = await getEffectiveEntitlements(org);
  assert.equal(limits.campaigns, 999, "override raises the cap");
  assert.equal(features.events, true, "override flips the flag on");
});

test("legacy override key volunteerEnabled maps to volunteers flag", async () => {
  nextPlanDoc = { limits: {}, featureFlags: { volunteers: false } };
  const org = { plan: "pro", override: { limits: { volunteerEnabled: true } } };
  const { features } = await getEffectiveEntitlements(org);
  assert.equal(features.volunteers, true);
});

test("getEffectiveLimits keeps the legacy flat shape (volunteerEnabled folded in)", async () => {
  nextPlanDoc = { limits: { campaigns: 5 }, featureFlags: { volunteers: true } };
  const flat = await getEffectiveLimits({ plan: "pro" });
  assert.equal(flat.campaigns, 5);
  assert.equal(flat.volunteerEnabled, true);
});
