const { test } = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./_plansHarness");

const catalog = load("config/featureCatalog");

test("catalog: groups + features are well-formed", () => {
  assert.ok(catalog.GROUPS.length > 0, "has groups");
  assert.ok(catalog.FEATURES.length > 0, "has features");
  const groupKeys = new Set(catalog.GROUPS.map((g) => g.key));
  for (const f of catalog.FEATURES) {
    assert.ok(f.key, "feature has a key");
    assert.ok(["flag", "meter"].includes(f.type), `${f.key} type is flag|meter`);
    assert.ok(f.label, `${f.key} has a label`);
    assert.ok(groupKeys.has(f.group), `${f.key} group "${f.group}" is a known group`);
  }
});

test("catalog: keys are unique within each namespace (flags / meters)", () => {
  // Flags and meters are separate namespaces (Plan.featureFlags vs Plan.limits),
  // so a key may appear once as a flag AND once as a meter — but never twice
  // within the same namespace.
  assert.equal(new Set(catalog.FLAG_KEYS).size, catalog.FLAG_KEYS.length, "flag keys unique");
  assert.equal(new Set(catalog.METER_KEYS).size, catalog.METER_KEYS.length, "meter keys unique");
});

test("catalog: every meter declares a count source", () => {
  for (const m of catalog.METERS) {
    assert.ok(m.count && m.count.model, `meter ${m.key} has count.model`);
  }
});

test("catalog: FLAGS / METERS partition matches type", () => {
  assert.deepEqual(
    catalog.FLAGS.map((f) => f.key).sort(),
    catalog.FEATURES.filter((f) => f.type === "flag").map((f) => f.key).sort()
  );
  assert.deepEqual(
    catalog.METERS.map((f) => f.key).sort(),
    catalog.FEATURES.filter((f) => f.type === "meter").map((f) => f.key).sort()
  );
});

test("catalog: PAGE_TO_FLAG maps real page keys to real flags", () => {
  const flagKeys = new Set(catalog.FLAG_KEYS);
  // Known public page keys map to the expected controlling flag.
  assert.equal(catalog.PAGE_TO_FLAG["events"], "events");
  assert.equal(catalog.PAGE_TO_FLAG["giving"], "islamicGiving");
  assert.equal(catalog.PAGE_TO_FLAG["zakat"], "islamicGiving");
  assert.equal(catalog.PAGE_TO_FLAG["p2p-campaigns"], "p2pCampaigns");
  assert.equal(catalog.PAGE_TO_FLAG["teamHope"], "volunteers");
  for (const flag of Object.values(catalog.PAGE_TO_FLAG)) {
    assert.ok(flagKeys.has(flag), `PAGE_TO_FLAG target "${flag}" is a real flag`);
  }
});

test("catalog: ADMIN_ROUTE_TO_FLAG targets real flags", () => {
  const flagKeys = new Set(catalog.FLAG_KEYS);
  assert.equal(catalog.ADMIN_ROUTE_TO_FLAG["/admin/events"], "events");
  assert.equal(catalog.ADMIN_ROUTE_TO_FLAG["/admin/newsletter"], "newsletter");
  for (const flag of Object.values(catalog.ADMIN_ROUTE_TO_FLAG)) {
    assert.ok(flagKeys.has(flag), `ADMIN_ROUTE_TO_FLAG target "${flag}" is a real flag`);
  }
});

test("catalog: islamicGiving is vertical-gated to muslim", () => {
  const f = catalog.FLAG_MAP["islamicGiving"];
  assert.equal(f.vertical, "muslim");
});
