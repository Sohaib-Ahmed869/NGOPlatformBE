const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { inject, load, matches, makeReq, makeRes } = require("./_plansHarness");

/* ── in-memory Plan model ─────────────────────────────────────────────────── */
const store = [];
let idc = 1;
class FakePlan {
  constructor(o = {}) {
    Object.assign(this, o);
    if (!this._id) this._id = "plan_" + idc++;
    this.priceHistory = this.priceHistory || [];
    this.stripePriceIds = this.stripePriceIds || { monthly: "", annual: "" };
    this.stripeProductId = this.stripeProductId || "";
    this.limits = this.limits || {};
    this.featureFlags = this.featureFlags || {};
  }
  async save() { if (!store.includes(this)) store.push(this); return this; }
  markModified() {}
  toObject() { const o = { ...this }; delete o.save; return o; }
  static async findOne(q) { return store.find((p) => matches(p, q)) || null; }
  static async find(q = {}) { return store.filter((p) => matches(p, q)); }
}
function seedPlan(o) { const p = new FakePlan(o); store.push(p); return p; }

/* ── fake Organisation + Stripe service + audit ───────────────────────────── */
let orgCount = 0;
const FakeOrg = { countDocuments: async () => orgCount, aggregate: async () => [] };

const stripeCalls = [];
const fakeStripeSvc = {
  isStripeEnabled: () => true,
  provisionPlan: async (plan) => { stripeCalls.push(["provision", plan.code]); return { stripeProductId: "prod_test", stripePriceIds: { monthly: "price_m", annual: "price_a" } }; },
  syncProduct: async (plan) => { stripeCalls.push(["syncProduct", plan.name]); },
  repriceChangedCycles: async (plan, cycles) => { stripeCalls.push(["reprice", cycles.join(",")]); const ids = {}; for (const c of cycles) ids[c] = "price_new_" + c; return { stripeProductId: plan.stripeProductId || "prod_test", stripePriceIds: ids }; },
  resyncPlan: async (plan) => { stripeCalls.push(["resync", plan.code]); return { stripeProductId: "prod_resynced", stripePriceIds: { monthly: "price_rm", annual: "price_ra" } }; },
  archivePlanStripe: async () => {},
  migrateSubscribers: async () => ({ migrated: 0, failed: 0, skipped: 0 }),
};

inject("models/plan", FakePlan);
inject("models/organisation", FakeOrg);
inject("services/stripePlanService", fakeStripeSvc);
inject("utils/writeAudit", async () => {});

const ctrl = load("controllers/planController");

beforeEach(() => { store.length = 0; stripeCalls.length = 0; orgCount = 0; });

test("createPlan: provisions Stripe, forces AUD, persists flags + limits", async () => {
  const req = makeReq({
    code: "Pro Plus",
    name: "Pro Plus",
    description: "desc",
    currency: "usd", // must be ignored — platform currency wins
    price: { monthly: 50, annual: 480 },
    featureFlags: { events: true, newsletter: false, bogusFlag: true },
    limits: { campaigns: 10, bogusMeter: 5 },
  });
  const res = makeRes();
  await ctrl.createPlan(req, res);

  assert.equal(res.statusCode, 201);
  const plan = res.body.plan;
  assert.equal(plan.code, "pro-plus", "code normalized");
  assert.equal(plan.currency, "aud", "currency forced to platform AUD");
  assert.equal(plan.stripeProductId, "prod_test");
  assert.equal(plan.stripePriceIds.monthly, "price_m");
  assert.equal(plan.featureFlags.events, true);
  assert.equal(plan.featureFlags.newsletter, false);
  assert.equal(plan.featureFlags.bogusFlag, undefined, "non-catalog flag dropped");
  assert.equal(plan.limits.campaigns, 10);
  assert.equal(plan.limits.bogusMeter, undefined, "non-catalog meter dropped");
  assert.ok(stripeCalls.some((c) => c[0] === "provision"), "Stripe provision called");
});

test("createPlan: duplicate code → 409", async () => {
  seedPlan({ code: "basic", name: "Basic" });
  const res = makeRes();
  await ctrl.createPlan(makeReq({ code: "basic", name: "Basic again" }), res);
  assert.equal(res.statusCode, 409);
});

test("createPlan: missing name/code → 400", async () => {
  const res = makeRes();
  await ctrl.createPlan(makeReq({ code: "x" }), res);
  assert.equal(res.statusCode, 400);
});

test("updatePlan: name change pushes to Stripe product", async () => {
  seedPlan({ code: "pro", name: "Pro", description: "d", price: { monthly: 50, annual: 480 }, stripeProductId: "prod_test" });
  const res = makeRes();
  await ctrl.updatePlan(makeReq({ name: "Professional" }, { params: { code: "pro" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.plan.name, "Professional");
  assert.equal(res.body.priceChanged, false);
  assert.ok(stripeCalls.some((c) => c[0] === "syncProduct"), "syncProduct called");
});

test("updatePlan: price change mints new price, grandfathers, counts affected", async () => {
  seedPlan({ code: "pro", name: "Pro", price: { monthly: 50, annual: 480 }, stripeProductId: "prod_test", stripePriceIds: { monthly: "price_old", annual: "price_a" } });
  orgCount = 3;
  const res = makeRes();
  await ctrl.updatePlan(makeReq({ price: { monthly: 60 } }, { params: { code: "pro" } }), res);
  assert.equal(res.body.priceChanged, true);
  assert.equal(res.body.subscribersAffected, 3);
  const plan = store.find((p) => p.code === "pro");
  assert.equal(plan.price.monthly, 60);
  assert.equal(plan.stripePriceIds.monthly, "price_new_monthly");
  assert.equal(plan.priceHistory.length, 1, "old price snapshotted");
  assert.equal(plan.priceHistory[0].stripePriceIds.monthly, "price_old");
});

test("updatePlan: featureFlags + limits MERGE (don't clobber existing keys)", async () => {
  seedPlan({ code: "pro", name: "Pro", price: { monthly: 50, annual: 480 }, featureFlags: { events: true }, limits: { campaigns: 5 } });
  const res = makeRes();
  await ctrl.updatePlan(makeReq({ featureFlags: { newsletter: true }, limits: { volunteers: 20 } }, { params: { code: "pro" } }), res);
  const plan = store.find((p) => p.code === "pro");
  assert.equal(plan.featureFlags.events, true, "existing flag preserved");
  assert.equal(plan.featureFlags.newsletter, true, "new flag merged");
  assert.equal(plan.limits.campaigns, 5, "existing limit preserved");
  assert.equal(plan.limits.volunteers, 20, "new limit merged");
});

test("bulkUpdateEntitlements: saves the matrix across plans", async () => {
  seedPlan({ code: "basic", name: "Basic", featureFlags: {}, limits: {} });
  seedPlan({ code: "pro", name: "Pro", featureFlags: {}, limits: {} });
  const res = makeRes();
  await ctrl.bulkUpdateEntitlements(
    makeReq({ plans: { basic: { features: { events: false }, limits: { campaigns: 5 } }, pro: { features: { events: true } } } }),
    res
  );
  assert.deepEqual(res.body.updated.sort(), ["basic", "pro"]);
  const basic = store.find((p) => p.code === "basic");
  const pro = store.find((p) => p.code === "pro");
  assert.equal(basic.featureFlags.events, false);
  assert.equal(basic.limits.campaigns, 5);
  assert.equal(pro.featureFlags.events, true);
});

test("resyncPlan: repairs a plan via Stripe and stores new ids", async () => {
  seedPlan({ code: "pro", name: "Pro", price: { monthly: 50, annual: 480 }, stripeProductId: "", stripePriceIds: { monthly: "", annual: "" } });
  const res = makeRes();
  await ctrl.resyncPlan(makeReq({}, { params: { code: "pro" } }), res);
  assert.equal(res.statusCode, 200);
  assert.ok(stripeCalls.some((c) => c[0] === "resync"));
  const plan = store.find((p) => p.code === "pro");
  assert.equal(plan.stripeProductId, "prod_resynced");
  assert.equal(plan.stripePriceIds.monthly, "price_rm");
});

test("getFeatureCatalog: returns groups + features", async () => {
  const res = makeRes();
  await ctrl.getFeatureCatalog(makeReq({}), res);
  assert.ok(Array.isArray(res.body.groups) && res.body.groups.length);
  assert.ok(Array.isArray(res.body.features) && res.body.features.length);
});
