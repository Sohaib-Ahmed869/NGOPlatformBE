/**
 * Shared helpers for the plan / entitlement tests.
 *
 * Same approach as tests/_harness.js: inject in-memory fakes into the require
 * cache BEFORE loading the real module under test, so the real code runs
 * against our fakes — no DB, no Stripe, no network. Node runs each *.test.js in
 * its own process, so injections never leak between files.
 */
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
process.env.PLATFORM_CURRENCY = process.env.PLATFORM_CURRENCY || "aud";

/** Replace a module's exports in the require cache (call BEFORE requiring the SUT). */
function inject(spec, exportsObj) {
  const resolved = require.resolve(path.join(ROOT, spec));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
/** Require a real app module by repo-relative path. */
function load(spec) {
  return require(path.join(ROOT, spec));
}

const getPath = (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);

/** Minimal Mongo-ish query matcher supporting equality + $in/$nin/$ne. */
function matches(doc, query) {
  return Object.entries(query || {}).every(([k, v]) => {
    const val = getPath(doc, k);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("$in" in v) return v.$in.map(String).includes(String(val));
      if ("$nin" in v) return !v.$nin.map(String).includes(String(val));
      if ("$ne" in v) return String(val) !== String(v.$ne);
      return false;
    }
    return String(val) === String(v);
  });
}

function makeReq(body, extra = {}) {
  return {
    body: body || {},
    params: extra.params || {},
    organisation: extra.organisation,
    user: extra.user || { _id: "sa1", email: "sa@test" },
    headers: extra.headers || {},
    ip: "127.0.0.1",
  };
}
function makeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (o) => ((res.body = o), res);
  res.send = (o) => ((res.body = o), res);
  res.end = () => res;
  return res;
}

module.exports = { ROOT, inject, load, matches, makeReq, makeRes };
