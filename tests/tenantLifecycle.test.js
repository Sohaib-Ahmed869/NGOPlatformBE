const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { inject, load, matches } = require("./_plansHarness");

/* ── fakes ───────────────────────────────────────────────────────────────── */
const plans = [];
inject("models/plan", { findOne: async (q) => plans.find((p) => matches(p, q)) || null });

const userUpdates = [];
inject("models/user", {
  updateMany: async (filter, update) => {
    userUpdates.push({ filter, update });
    return { modifiedCount: 2 };
  },
});

const audits = [];
inject("utils/writeAudit", async (req, action, extra) => audits.push({ action, extra }));
inject("services/socket", { emitToSuperAdmins: () => {}, emitToOrg: () => {} });

const stripeCalls = [];
const stripeState = { configured: true, sub: null, failCancel: null, failUpdate: null, failRetrieve: null };
inject("services/platformStripe", {
  isStripeConfigured: () => stripeState.configured,
  stripe: {
    subscriptions: {
      retrieve: async (id) => {
        stripeCalls.push(["retrieve", id]);
        if (stripeState.failRetrieve) throw stripeState.failRetrieve;
        return stripeState.sub;
      },
      cancel: async (id) => {
        stripeCalls.push(["cancel", id]);
        if (stripeState.failCancel) throw stripeState.failCancel;
        return { id, status: "canceled" };
      },
      update: async (id, body) => {
        stripeCalls.push(["update", id, body]);
        if (stripeState.failUpdate) throw stripeState.failUpdate;
        return { id };
      },
    },
  },
});

const lifecycle = load("services/tenantLifecycle");

function makeOrg(o = {}) {
  const org = {
    _id: "org1",
    name: "Hope Trust",
    slug: "hope-trust",
    plan: "essentials",
    billingCycle: "monthly",
    subscriptionStatus: "active",
    isActive: true,
    adminUserId: "user1",
    deletedAt: null,
    stripeSubscriptionId: "",
    stripeSubscriptionEndedAt: null,
    isComp: false,
    saves: 0,
    ...o,
  };
  org.save = async () => {
    org.saves++;
    return org;
  };
  return org;
}

const req = { integration: { keyName: "hyper", actorEmail: "a@b.co", actorLabel: "integration:hyper (a@b.co)" }, user: null, headers: {} };

beforeEach(() => {
  plans.length = 0;
  userUpdates.length = 0;
  audits.length = 0;
  stripeCalls.length = 0;
  Object.assign(stripeState, { configured: true, sub: null, failCancel: null, failUpdate: null, failRetrieve: null });
});

/* ── status ──────────────────────────────────────────────────────────────── */
test("tenantStatus maps the four stored fields to one status", () => {
  assert.equal(lifecycle.tenantStatus(makeOrg()), "active");
  assert.equal(lifecycle.tenantStatus(makeOrg({ isActive: false, subscriptionStatus: "cancelled" })), "suspended");
  assert.equal(lifecycle.tenantStatus(makeOrg({ isActive: false, subscriptionStatus: "pending", adminUserId: null })), "pending");
  assert.equal(lifecycle.tenantStatus(makeOrg({ deletedAt: new Date(), isActive: false })), "deleted");
});

/* ── suspend ─────────────────────────────────────────────────────────────── */
test("suspend: cancels the live Stripe subscription, locks the portal, signs staff out, audits", async () => {
  stripeState.sub = { id: "sub_1", status: "active" };
  const org = makeOrg({ stripeSubscriptionId: "sub_1" });
  const r = await lifecycle.suspendTenant(org, req, { reason: "non-payment" });

  assert.equal(r.changed, true);
  assert.equal(org.isActive, false);
  assert.equal(org.subscriptionStatus, "cancelled");
  assert.ok(org.stripeSubscriptionEndedAt instanceof Date, "billing marked as ended");
  assert.ok(stripeCalls.some((c) => c[0] === "cancel"));
  assert.deepEqual(userUpdates[0].update, { $inc: { tokenVersion: 1 } }, "staff tokens invalidated");
  assert.equal(audits[0].action, "org.suspended");
  assert.equal(audits[0].extra.meta.reason, "non-payment");
  assert.deepEqual(r.warnings, []);
});

test("suspend: a Stripe failure still locks access, and says billing may continue", async () => {
  stripeState.sub = { id: "sub_1", status: "active" };
  stripeState.failCancel = Object.assign(new Error("network down"), { code: "api_connection_error" });
  const org = makeOrg({ stripeSubscriptionId: "sub_1" });
  const r = await lifecycle.suspendTenant(org, req);

  assert.equal(org.isActive, false, "access locked regardless");
  assert.equal(org.stripeSubscriptionEndedAt, null, "billing NOT marked ended");
  assert.equal(r.warnings[0].code, "STRIPE_CANCEL_FAILED");
});

test("suspend: already suspended with no live billing → no-op", async () => {
  const org = makeOrg({ isActive: false, subscriptionStatus: "cancelled" });
  const r = await lifecycle.suspendTenant(org, req);
  assert.equal(r.changed, false);
  assert.equal(org.saves, 0);
  assert.equal(audits.length, 0);
});

test("suspend: pending signup and deleted tenants are refused with stable codes", async () => {
  await assert.rejects(
    lifecycle.suspendTenant(makeOrg({ isActive: false, subscriptionStatus: "pending", adminUserId: null }), req),
    { code: "TENANT_PENDING_PAYMENT", status: 409 },
  );
  await assert.rejects(lifecycle.suspendTenant(makeOrg({ deletedAt: new Date(), isActive: false }), req), { code: "TENANT_DELETED" });
});

/* ── reactivate / restore / delete ───────────────────────────────────────── */
test("reactivate: reopens but warns that billing was not restarted", async () => {
  const org = makeOrg({ isActive: false, subscriptionStatus: "cancelled", stripeSubscriptionId: "sub_1", stripeSubscriptionEndedAt: new Date() });
  const r = await lifecycle.reactivateTenant(org, req);
  assert.equal(org.isActive, true);
  assert.equal(org.subscriptionStatus, "active");
  assert.equal(audits[0].action, "org.reactivated");
  assert.equal(r.warnings[0].code, "BILLING_NOT_RESTARTED");
});

test("reactivate: a comped tenant gets no billing warning", async () => {
  const org = makeOrg({ isActive: false, subscriptionStatus: "cancelled", isComp: true });
  const r = await lifecycle.reactivateTenant(org, req);
  assert.deepEqual(r.warnings, []);
});

test("soft delete then restore: data kept, deletedAt cleared, audited as restored", async () => {
  const org = makeOrg();
  await lifecycle.softDeleteTenant(org, req);
  assert.ok(org.deletedAt);
  assert.equal(lifecycle.tenantStatus(org), "deleted");
  await assert.rejects(lifecycle.softDeleteTenant(org, req), { code: "TENANT_ALREADY_DELETED", status: 409 });

  await lifecycle.reactivateTenant(org, req);
  assert.equal(org.deletedAt, null);
  assert.equal(lifecycle.tenantStatus(org), "active");
  assert.deepEqual(audits.map((a) => a.action), ["org.deleted", "org.restored"]);
});

test("restore a deleted tenant straight into suspended", async () => {
  const org = makeOrg({ deletedAt: new Date(), isActive: false, subscriptionStatus: "cancelled" });
  await lifecycle.reactivateTenant(org, req, { to: "suspended" });
  assert.equal(lifecycle.tenantStatus(org), "suspended");
});

test("reactivate: a never-paid signup can't be switched on", async () => {
  await assert.rejects(
    lifecycle.reactivateTenant(makeOrg({ isActive: false, subscriptionStatus: "pending", adminUserId: null }), req),
    { code: "TENANT_PENDING_PAYMENT" },
  );
});

/* ── assign plan ─────────────────────────────────────────────────────────── */
test("assignPlan without live billing: DB-only, reason recorded, status untouched", async () => {
  plans.push({ code: "growth", name: "Growth", isActive: true, stripePriceIds: { monthly: "price_gm", annual: "price_ga" } });
  const org = makeOrg({ isActive: false, subscriptionStatus: "cancelled" });
  const r = await lifecycle.assignPlan(org, { planCode: "growth", billingCycle: "annual" }, req, { reason: "upsell" });
  assert.equal(org.plan, "growth");
  assert.equal(org.billingCycle, "annual");
  assert.equal(org.isActive, false, "status is never changed by a plan assignment");
  assert.deepEqual(r.billingSync, { status: "skipped", reason: "no_live_subscription" });
  assert.equal(stripeCalls.length, 0);
  assert.equal(audits[0].extra.meta.reason, "upsell");
});

test("assignPlan with live billing: swaps the Stripe price with prorations; interval change flagged", async () => {
  plans.push({ code: "growth", name: "Growth", isActive: true, stripePriceIds: { monthly: "price_gm", annual: "price_ga" } });
  stripeState.sub = { id: "sub_1", status: "active", items: { data: [{ id: "si_1", price: { id: "price_old", recurring: { interval: "month" } } }] } };
  const org = makeOrg({ stripeSubscriptionId: "sub_1" });
  const r = await lifecycle.assignPlan(org, { planCode: "growth", billingCycle: "annual" }, req);

  const update = stripeCalls.find((c) => c[0] === "update");
  assert.deepEqual(update[2].items, [{ id: "si_1", price: "price_ga" }]);
  assert.equal(update[2].proration_behavior, "create_prorations");
  assert.equal(r.billingSync.status, "updated");
  assert.equal(r.billingSync.billing_anchor_reset, true);
});

test("assignPlan: a Stripe rejection changes NOTHING", async () => {
  plans.push({ code: "growth", name: "Growth", isActive: true, stripePriceIds: { monthly: "price_gm" } });
  stripeState.sub = { id: "sub_1", status: "active", items: { data: [{ id: "si_1", price: { id: "price_old" } }] } };
  stripeState.failUpdate = new Error("card_declined");
  const org = makeOrg({ stripeSubscriptionId: "sub_1" });
  await assert.rejects(lifecycle.assignPlan(org, { planCode: "growth" }, req), { code: "STRIPE_UPDATE_FAILED", status: 502 });
  assert.equal(org.plan, "essentials");
  assert.equal(org.saves, 0);
  assert.equal(audits.length, 0);
});

test("assignPlan: paying tenant onto a plan with no Stripe price for the cycle → 409", async () => {
  plans.push({ code: "bespoke", name: "Bespoke", isActive: true, stripePriceIds: { monthly: "", annual: "" } });
  stripeState.sub = { id: "sub_1", status: "active", items: { data: [{ id: "si_1", price: { id: "price_old" } }] } };
  const org = makeOrg({ stripeSubscriptionId: "sub_1" });
  await assert.rejects(lifecycle.assignPlan(org, { planCode: "bespoke" }, req), { code: "PLAN_NOT_BILLABLE" });
});

test("assignPlan: Stripe says the subscription is gone → recorded as ended, DB-only change", async () => {
  plans.push({ code: "growth", name: "Growth", isActive: true, stripePriceIds: { monthly: "price_gm" } });
  stripeState.failRetrieve = Object.assign(new Error("No such subscription"), { code: "resource_missing" });
  const org = makeOrg({ stripeSubscriptionId: "sub_gone" });
  const r = await lifecycle.assignPlan(org, { planCode: "growth" }, req);
  assert.equal(org.plan, "growth");
  assert.ok(org.stripeSubscriptionEndedAt);
  assert.equal(r.billingSync.status, "skipped");
});

test("assignPlan: unknown and archived plans are refused; same plan+cycle is a no-op", async () => {
  plans.push({ code: "old", name: "Old", isActive: false });
  const org = makeOrg();
  await assert.rejects(lifecycle.assignPlan(org, { planCode: "nope" }, req), { code: "PLAN_NOT_FOUND", status: 404 });
  await assert.rejects(lifecycle.assignPlan(org, { planCode: "old" }, req), { code: "PLAN_ARCHIVED", status: 409 });
  const r = await lifecycle.assignPlan(org, { planCode: "essentials", billingCycle: "monthly" }, req);
  assert.equal(r.changed, false);
});

/* ── override ────────────────────────────────────────────────────────────── */
test("setOverride (strict): requires a reason, validates keys, records who set it", async () => {
  const org = makeOrg();
  await assert.rejects(lifecycle.setOverride(org, { limits: { adminSeats: 25 } }, req, { strict: true }), { code: "REASON_REQUIRED" });
  await assert.rejects(lifecycle.setOverride(org, { limits: { seats: 25 }, reason: "deal" }, req, { strict: true }), { code: "UNKNOWN_LIMIT_KEY" });
  await assert.rejects(lifecycle.setOverride(org, { featureFlags: { donations: false }, reason: "deal" }, req, { strict: true }), { code: "CORE_FLAG_LOCKED" });
  await assert.rejects(lifecycle.setOverride(org, { limits: { adminSeats: "lots" }, reason: "deal" }, req, { strict: true }), { code: "VALIDATION_ERROR" });

  await lifecycle.setOverride(org, { limits: { adminSeats: 25, campaigns: null }, featureFlags: { events: true }, pricing: { monthly: 149 }, reason: "Enterprise deal" }, req, { strict: true });
  assert.deepEqual(org.override.limits, { adminSeats: 25, campaigns: null });
  assert.deepEqual(org.override.featureFlags, { events: true });
  assert.deepEqual(org.override.pricing, { monthly: 149, annual: null });
  assert.equal(org.override.setByLabel, "integration:hyper (a@b.co)");
  assert.equal(lifecycle.hasOverride(org), true);

  const cleared = await lifecycle.clearOverride(org, req);
  assert.equal(cleared.changed, true);
  assert.equal(lifecycle.hasOverride(org), false);
  assert.equal((await lifecycle.clearOverride(org, req)).changed, false, "clearing nothing is a no-op");
});

test("setOverride (console, non-strict): unknown keys are dropped as before", async () => {
  const org = makeOrg();
  await lifecycle.setOverride(org, { limits: { campaigns: 9, bogus: 1 }, reason: "x" }, { user: { _id: "sa1", email: "sa@x" }, headers: {} });
  assert.deepEqual(org.override.limits, { campaigns: 9 });
  assert.equal(org.override.setByLabel, "sa@x");
});
