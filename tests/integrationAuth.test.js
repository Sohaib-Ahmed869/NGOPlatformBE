const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { load, makeRes } = require("./_plansHarness");

const auth = load("middleware/integrationAuth");

const KEY_A = "dnx_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_B = "dnx_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function reqWith(headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: lower, get: (h) => lower[h.toLowerCase()] };
}

function run(headers) {
  const req = reqWith(headers);
  const res = makeRes();
  let nextCalled = false;
  auth(req, res, () => (nextCalled = true));
  return { req, res, nextCalled };
}

beforeEach(() => {
  delete process.env.INTEGRATION_API_KEYS;
});

test("unset INTEGRATION_API_KEYS → 503 INTEGRATION_DISABLED", () => {
  const { res, nextCalled } = run({ "x-api-key": KEY_A });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { success: false, error: { code: "INTEGRATION_DISABLED", message: res.body.error.message } });
});

test("only malformed / too-short pairs configured → still 503", () => {
  process.env.INTEGRATION_API_KEYS = "hyper:short,nokeyhere, :" + KEY_A;
  const { res } = run({ "x-api-key": "short" });
  assert.equal(res.statusCode, 503);
});

test("missing key → 401 API_KEY_MISSING", () => {
  process.env.INTEGRATION_API_KEYS = `hyper:${KEY_A}`;
  const { res, nextCalled } = run({});
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, "API_KEY_MISSING");
});

test("unknown key → 401 API_KEY_INVALID", () => {
  process.env.INTEGRATION_API_KEYS = `hyper:${KEY_A}`;
  const { res } = run({ "x-api-key": KEY_B });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, "API_KEY_INVALID");
});

test("valid key → next(), caller named by the pair's NAME, no user", () => {
  process.env.INTEGRATION_API_KEYS = `hyper:${KEY_A}`;
  const { req, nextCalled } = run({ "x-api-key": KEY_A });
  assert.equal(nextCalled, true);
  assert.equal(req.user, null);
  assert.deepEqual(req.integration, { keyName: "hyper", actorEmail: "", actorLabel: "integration:hyper" });
});

test("rotation: old and new keys both accepted, each resolving to its own name", () => {
  process.env.INTEGRATION_API_KEYS = ` hyper:${KEY_B} , hyper-old:${KEY_A} `;
  assert.equal(run({ "x-api-key": KEY_B }).req.integration.keyName, "hyper");
  assert.equal(run({ "x-api-key": KEY_A }).req.integration.keyName, "hyper-old");
});

test("x-actor-email is recorded alongside the key name", () => {
  process.env.INTEGRATION_API_KEYS = `hyper:${KEY_A}`;
  const { req } = run({ "x-api-key": KEY_A, "x-actor-email": "Sohaib@Calcite.live" });
  assert.equal(req.integration.actorEmail, "sohaib@calcite.live");
  assert.equal(req.integration.actorLabel, "integration:hyper (sohaib@calcite.live)");
});

test("malformed x-actor-email → 400 rather than a silently unattributed write", () => {
  process.env.INTEGRATION_API_KEYS = `hyper:${KEY_A}`;
  const { res, nextCalled } = run({ "x-api-key": KEY_A, "x-actor-email": "not an email" });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, "INVALID_ACTOR_EMAIL");
});

test("a key containing ':' after the first separator is kept whole", () => {
  const weird = "dnx_live_with:colon_inside_abcdefghijkl";
  process.env.INTEGRATION_API_KEYS = `hyper:${weird}`;
  assert.equal(run({ "x-api-key": weird }).nextCalled, true);
});
