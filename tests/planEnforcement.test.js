const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { inject, load } = require("./_plansHarness");

// Faked Plan model feeding the real resolver.
let nextPlanDoc = undefined;
inject("models/plan", { findOne: () => ({ select: () => Promise.resolve(nextPlanDoc) }) });

// Intercept mongoose.model(name) for the count lookup; delegate otherwise.
let counts = {}; // { Program: n }
const origModel = mongoose.model.bind(mongoose);
mongoose.model = (name, ...rest) => {
  if (rest.length === 0 && name in counts) {
    return { countDocuments: async () => counts[name] };
  }
  return origModel(name, ...rest);
};

const { checkLimit, requireFeature } = load("middleware/planEnforcement");

function runMw(mw, org) {
  return new Promise((resolve) => {
    const req = { organisation: org };
    const res = {
      statusCode: 200,
      body: undefined,
      status(c) { this.statusCode = c; return this; },
      json(o) { this.body = o; resolve({ blocked: true, res: this }); return this; },
    };
    mw(req, res, () => resolve({ blocked: false, res }));
  });
}

beforeEach(() => { nextPlanDoc = undefined; counts = {}; });

test("checkLimit: blocks at the cap (403 upgradeRequired)", async () => {
  nextPlanDoc = { limits: { campaigns: 2 }, featureFlags: {} };
  counts = { Program: 2 }; // already at 2 active campaigns
  const out = await runMw(checkLimit("campaigns"), { _id: "o1", plan: "basic" });
  assert.equal(out.blocked, true);
  assert.equal(out.res.statusCode, 403);
  assert.equal(out.res.body.upgradeRequired, true);
  assert.equal(out.res.body.limit, 2);
  assert.equal(out.res.body.current, 2);
});

test("checkLimit: allows under the cap", async () => {
  nextPlanDoc = { limits: { campaigns: 5 }, featureFlags: {} };
  counts = { Program: 1 };
  const out = await runMw(checkLimit("campaigns"), { _id: "o1", plan: "pro" });
  assert.equal(out.blocked, false);
});

test("checkLimit: null limit = unlimited → always allows", async () => {
  nextPlanDoc = { limits: { campaigns: null }, featureFlags: {} };
  counts = { Program: 9999 };
  const out = await runMw(checkLimit("campaigns"), { _id: "o1", plan: "ent" });
  assert.equal(out.blocked, false);
});

test("checkLimit: unknown counter model → does not block", async () => {
  // p2pQuota counts model 'P2PCampaign' which we don't register → getModel null.
  nextPlanDoc = { limits: { p2pQuota: 0 }, featureFlags: {} };
  const out = await runMw(checkLimit("p2pQuota"), { _id: "o1", plan: "basic" });
  assert.equal(out.blocked, false, "no counter → allow rather than hard-fail");
});

test("requireFeature: blocks when flag is off", async () => {
  nextPlanDoc = { limits: {}, featureFlags: { events: false } };
  const out = await runMw(requireFeature("events", "Events"), { _id: "o1", plan: "basic" });
  assert.equal(out.blocked, true);
  assert.equal(out.res.statusCode, 403);
  assert.equal(out.res.body.upgradeRequired, true);
});

test("requireFeature: allows when flag is on", async () => {
  nextPlanDoc = { limits: {}, featureFlags: { events: true } };
  const out = await runMw(requireFeature("events"), { _id: "o1", plan: "pro" });
  assert.equal(out.blocked, false);
});

test("requireFeature: legacy alias volunteerEnabled → volunteers", async () => {
  nextPlanDoc = { limits: {}, featureFlags: { volunteers: true } };
  const out = await runMw(requireFeature("volunteerEnabled"), { _id: "o1", plan: "pro" });
  assert.equal(out.blocked, false);
});

test("middleware: 400 when no organisation context", async () => {
  const out = await runMw(checkLimit("campaigns"), undefined);
  assert.equal(out.res.statusCode, 400);
});
