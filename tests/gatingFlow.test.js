const { test } = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./_plansHarness");

const { PAGE_TO_FLAG } = load("config/featureCatalog");

// Mirror of the fold in controllers/saas/registrationController.js#getBySlug:
// a page whose controlling plan flag is OFF is forced enabled:false/showInNav:false.
// It only ever DOWNGRADES (never force-enables a tenant-disabled page).
function gatePages(pages, features) {
  return pages.map((p) => {
    const flag = PAGE_TO_FLAG[p.key];
    const planAllows = !flag || features[flag] !== false;
    return planAllows ? p : { ...p, enabled: false, showInNav: false };
  });
}

test("plan flag OFF hides the controlled page", () => {
  const pages = [
    { key: "events", path: "/events", enabled: true, showInNav: true },
    { key: "home", path: "/", enabled: true, showInNav: true },
  ];
  const out = gatePages(pages, { events: false });
  const events = out.find((p) => p.key === "events");
  const home = out.find((p) => p.key === "home");
  assert.equal(events.enabled, false);
  assert.equal(events.showInNav, false);
  assert.equal(home.enabled, true, "unrelated page untouched");
});

test("plan flag ON leaves the tenant's own toggle intact (no force-enable)", () => {
  const pages = [{ key: "events", path: "/events", enabled: false, showInNav: false }];
  const out = gatePages(pages, { events: true });
  assert.equal(out[0].enabled, false, "tenant had it off; plan-on does not force it on");
});

test("pages with no controlling flag are never gated", () => {
  const pages = [{ key: "contactUnmanaged", path: "/whatever", enabled: true, showInNav: true }];
  const out = gatePages(pages, {}); // empty features
  assert.equal(out[0].enabled, true);
});

test("islamic pages are gated by islamicGiving flag", () => {
  const pages = [
    { key: "giving", path: "/giving", enabled: true, showInNav: true },
    { key: "zakat", path: "/zakat/calculator", enabled: true, showInNav: true },
  ];
  const out = gatePages(pages, { islamicGiving: false });
  assert.ok(out.every((p) => p.enabled === false), "giving + zakat hidden");
});
