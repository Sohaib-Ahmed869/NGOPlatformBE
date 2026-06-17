/**
 * Test harness for the order / subscription controllers.
 *
 * No DB, no network, no Stripe account: we inject in-memory fakes for the
 * Mongoose models and a configurable fake Stripe client into the require cache
 * BEFORE loading the controllers, so the real controller code runs against our
 * fakes. Uses Node's built-in test runner (node --test) — no extra installs.
 */
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_dummy";

/* ── in-memory Order store + fake model ─────────────────────────────────── */
const store = [];
let _idc = 1;

const getPath = (obj, p) =>
  p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

const matches = (doc, query) =>
  Object.entries(query).every(([k, v]) => {
    const val = getPath(doc, k);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("$exists" in v) return (val !== undefined && val !== null) === v.$exists;
      if ("$ne" in v) return String(val) !== String(v.$ne);
      if ("$nin" in v) return !v.$nin.map(String).includes(String(val));
      if ("$lt" in v) return val != null && new Date(val) < new Date(v.$lt);
      return false;
    }
    return String(val) === String(v);
  });

class FakeOrder {
  constructor(obj = {}) {
    Object.assign(this, obj);
    if (!this._id) this._id = "ord_" + _idc++;
    this.createdAt = this.createdAt || new Date();
    this.__inStore = false;
  }
  async save() {
    if (!this.__inStore) {
      store.push(this);
      this.__inStore = true;
    }
    return this;
  }
  static async findOne(q) {
    return store.find((o) => matches(o, q)) || null;
  }
  static async findById(id) {
    return store.find((o) => String(o._id) === String(id)) || null;
  }
  static async find(q = {}) {
    return store.filter((o) => matches(o, q));
  }
  static async findByIdAndUpdate(id, upd) {
    const o = store.find((x) => String(x._id) === String(id));
    if (o) Object.assign(o, upd);
    return o || null;
  }
}

const FakeUser = {
  findByIdAndUpdate: async () => null,
  findOne: async () => null,
  findById: async () => ({ _id: "user1", email: "donor@test.com", firstName: "Test", name: "Test Donor" }),
};
const FakeProgram = { findById: async () => null };

let currentOrg = { _id: "org1", slug: "test", name: "Test Org" };
const FakeOrg = {
  findById: async () => currentOrg,
  findOne: async () => currentOrg,
};

/* ── configurable fake Stripe ───────────────────────────────────────────── */
let currentStripe = null;

function makeStripe(opts = {}) {
  const calls = {};
  const rec = (name, args) => {
    (calls[name] = calls[name] || []).push(args);
    return args;
  };
  const subStatus = opts.subscriptionStatus || "active";
  const piStatus = opts.paymentIntentStatus || "succeeded";

  return {
    _calls: calls,
    last: (name) => (calls[name] || [])[(calls[name] || []).length - 1],
    count: (name) => (calls[name] || []).length,
    paymentIntents: {
      create: async (a) => {
        rec("paymentIntents.create", a);
        return {
          id: "pi_" + calls["paymentIntents.create"].length,
          status: piStatus,
          latest_charge: { id: "ch_pi", receipt_url: "https://receipt/pi" },
          client_secret: "cs_x",
        };
      },
      retrieve: async (id, o) => {
        rec("paymentIntents.retrieve", { id, o });
        return { id, status: "succeeded", latest_charge: { id: "ch_pi", receipt_url: "https://receipt/" + id } };
      },
      confirm: async (id, o) => {
        rec("paymentIntents.confirm", { id, o });
        return { id, status: "succeeded", latest_charge: { receipt_url: "https://receipt/" + id } };
      },
    },
    paymentMethods: {
      retrieve: async (pm) => {
        rec("paymentMethods.retrieve", pm);
        return { id: pm, customer: opts.pmCustomer || null, type: opts.pmType || "card" };
      },
      attach: async (pm, a) => {
        rec("paymentMethods.attach", { pm, a });
        if (opts.attachFails) throw Object.assign(new Error("payment method already attached"), { code: "resource_already_exists" });
        return {};
      },
      detach: async (pm) => {
        rec("paymentMethods.detach", pm);
        if (opts.detachFails) throw new Error("cannot detach this payment method");
        return {};
      },
    },
    customers: {
      create: async (a) => rec("customers.create", a) && { id: "cus_x" },
      retrieve: async (id) => {
        rec("customers.retrieve", id);
        if (opts.customerDeleted) {
          const err = new Error(`No such customer: '${id}'`);
          err.code = "resource_missing";
          throw err;
        }
        return { id };
      },
      update: async (id, a) => rec("customers.update", { id, a }) && {},
    },
    products: { create: async (a) => rec("products.create", a) && { id: "prod_x" } },
    subscriptions: {
      create: async (a) => {
        rec("subscriptions.create", a);
        const nowSec = Math.floor(Date.now() / 1000);
        return {
          id: "sub_x",
          status: subStatus,
          // Stripe's real anchor (here ≈ now, or overridden to simulate a test
          // clock); the controller must read these rather than the app clock.
          current_period_start: opts.periodStart || nowSec,
          current_period_end: opts.periodEnd || nowSec + 7 * 86400,
          latest_invoice: {
            id: "in_1",
            payment_intent: { id: "pi_sub", status: "succeeded", latest_charge: { receipt_url: "https://receipt/sub" } },
          },
        };
      },
      retrieve: async (id) => rec("subscriptions.retrieve", id) && { id, status: "active", items: { data: [{ id: "si_x", price: { product: "prod_x" } }] } },
      cancel: async (id) => rec("subscriptions.cancel", id) && { id, status: "canceled" },
      del: async (id) => rec("subscriptions.del", id) && { id, status: "canceled" },
      update: async (id, a) => rec("subscriptions.update", { id, a }) && { id, status: "active" },
    },
    invoices: {
      pay: async (id) => rec("invoices.pay", id) && { id, payment_intent: { status: "succeeded", latest_charge: { receipt_url: "https://receipt/inv" } } },
      list: async (a) => rec("invoices.list", a) && { data: opts.invoices || [] },
    },
    charges: {
      retrieve: async (id) => rec("charges.retrieve", id) && { id, receipt_url: "https://receipt/charge/" + id },
    },
    webhooks: { constructEvent: (raw) => JSON.parse(raw) },
  };
}

/* ── inject fakes, then load the real controllers ───────────────────────── */
function inject(spec, exportsObj) {
  const resolved = require.resolve(path.join(ROOT, spec));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
inject("models/order", FakeOrder);
inject("models/user", FakeUser);
inject("models/program", FakeProgram);
inject("models/organisation", FakeOrg);
// multer-like stub: upload.single(...) etc. return a passthrough middleware,
// since the controller wires these at module load time.
const passthrough = () => (req, res, next) => (typeof next === "function" ? next() : undefined);
inject("config/s3", { upload: { single: passthrough, array: passthrough, fields: passthrough, none: passthrough, any: passthrough } });
inject("services/recieptUtils", { sendReceiptEmail: async () => {} });
inject("services/emailUtil", { sendEmail: async () => {} });
inject("services/tenantStripe", {
  getTenantStripe: () => currentStripe,
  getTenantWebhookSecret: () => "whsec_test",
});

const orderCtrl = require(path.join(ROOT, "controllers/orderContrller.js"));
const subCtrl = require(path.join(ROOT, "controllers/subscriptionController.js"));
const adminSubCtrl = require(path.join(ROOT, "controllers/admin/subcriptionController.js"));
const recurringDates = require(path.join(ROOT, "services/recurringDates.js"));

/* ── request / response fakes ───────────────────────────────────────────── */
function makeReq(body, extra = {}) {
  return {
    body,
    user: "user" in extra ? extra.user : { _id: "user1" },
    organisation: "organisation" in extra ? extra.organisation : { _id: "org1", slug: "test" },
    headers: extra.headers || {},
    params: extra.params || {},
    rawBody: extra.rawBody,
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

function resetStore() {
  store.length = 0;
}
function setStripe(s) {
  currentStripe = s;
}
function seedOrder(obj) {
  const o = new FakeOrder(obj);
  o.__inStore = true;
  store.push(o);
  return o;
}

module.exports = {
  orderCtrl,
  subCtrl,
  adminSubCtrl,
  recurringDates,
  store,
  resetStore,
  setStripe,
  makeStripe,
  makeReq,
  makeRes,
  seedOrder,
  FakeOrder,
};
