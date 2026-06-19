/**
 * config/featureCatalog.js
 *
 * THE single source of truth for every plan-gateable capability and metered
 * quota on the platform. The SuperAdmin "Features" matrix renders one row per
 * entry here; the entitlement resolver + enforcement middleware read the
 * `pages` / `adminNav` / `count` metadata to gate the public site, the admin
 * portal, and resource creation.
 *
 * Two row types:
 *   - type:"flag"  → a boolean capability stored on Plan.featureFlags[key].
 *                    `pages`   = public Page keys this flag makes available.
 *                    `adminNav`= admin nav routes this flag makes available.
 *                    `core`    = always available (matrix shows it locked ON).
 *                    `vertical`= extra gate (e.g. "muslim" needs isMuslimCharity).
 *   - type:"meter" → a numeric quota stored on Plan.limits[key]. null=Unlimited.
 *                    `count`   = how to count current usage for enforcement:
 *                               { model, filter } counted scoped to the org.
 *
 * Adding a feature is ONE entry here — the matrix, resolver, gating and
 * enforcement all pick it up automatically.
 */

// Display groups, in render order.
const GROUPS = [
  { key: "fundraising", label: "Fundraising", blurb: "Donations, recurring giving and campaigns." },
  { key: "engagement", label: "Engagement", blurb: "How the org reaches and grows its supporters." },
  { key: "content", label: "Website & Content", blurb: "Public site pages, builder and design." },
  { key: "islamic", label: "Islamic Giving", blurb: "Zakat, Ramadan and the giving hub (Muslim charities)." },
  { key: "integrations", label: "Integrations", blurb: "Bring-your-own payment & email accounts." },
  { key: "quotas", label: "Limits & Quotas", blurb: "How much of each resource a plan allows." },
];

/**
 * @typedef {Object} CatalogFlag
 * @property {string} key
 * @property {"flag"} type
 * @property {string} group
 * @property {string} label
 * @property {string} [description]
 * @property {string[]} [pages]      public Page keys (models/page.js `key`)
 * @property {string[]} [adminNav]   admin nav routes (Admin/navConfig.js paths)
 * @property {boolean} [core]        always-on (cannot be switched off)
 * @property {"muslim"} [vertical]   extra vertical gate
 *
 * @typedef {Object} CatalogMeter
 * @property {string} key
 * @property {"meter"} type
 * @property {string} group
 * @property {string} label
 * @property {string} [description]
 * @property {string} [unit]
 * @property {{model:string, filter?:object, window?:"month"}} [count]
 */

/** @type {(CatalogFlag|CatalogMeter)[]} */
const FEATURES = [
  // ── Fundraising ──────────────────────────────────────────────────────────
  {
    key: "donations",
    type: "flag",
    group: "fundraising",
    label: "Donations & Checkout",
    description: "Accept one-off donations and the public checkout.",
    pages: ["donate"],
    adminNav: ["/admin/donations", "/admin/donors"],
    core: true,
  },
  {
    key: "recurringGiving",
    type: "flag",
    group: "fundraising",
    label: "Recurring & Installments",
    description: "Recurring subscriptions, installment plans and cancellation requests.",
    adminNav: ["/admin/subscriptions", "/admin/installments", "/admin/cancellation-requests"],
  },
  {
    key: "programs",
    type: "flag",
    group: "fundraising",
    label: "Programs / Causes",
    description: "Program & cause pages with their own donations and payments.",
    pages: ["programs"],
    adminNav: ["/admin/programs", "/admin/program-payments", "/admin/donation-types"],
  },
  {
    key: "p2pCampaigns",
    type: "flag",
    group: "fundraising",
    label: "P2P Fundraisers",
    description: "Supporter-created peer-to-peer fundraising campaigns.",
    pages: ["p2p-campaigns"],
    adminNav: ["/admin/p2p-campaigns", "/admin/campaign-payments"],
  },
  {
    key: "store",
    type: "flag",
    group: "fundraising",
    label: "Products / Store",
    description: "Sell products / tickets / merchandise.",
    adminNav: ["/admin/products"],
  },

  // ── Engagement ───────────────────────────────────────────────────────────
  {
    key: "events",
    type: "flag",
    group: "engagement",
    label: "Events",
    description: "Public events calendar, RSVP and paid registration.",
    pages: ["events"],
    adminNav: ["/admin/events", "/admin/event-payments"],
  },
  {
    key: "volunteers",
    type: "flag",
    group: "engagement",
    label: "Volunteers",
    description: "Public volunteer application form and management.",
    pages: ["teamHope"],
    adminNav: ["/admin/volunteers"],
  },
  {
    key: "newsletter",
    type: "flag",
    group: "engagement",
    label: "Newsletter Campaigns",
    description: "Compose, segment and send email campaigns.",
    adminNav: ["/admin/newsletter"],
  },
  {
    key: "contacts",
    type: "flag",
    group: "engagement",
    label: "Contacts Inbox",
    description: "Public contact form and the internal split-inbox.",
    pages: ["contact"],
    adminNav: ["/admin/contacts"],
    core: true,
  },
  {
    key: "supportTickets",
    type: "flag",
    group: "engagement",
    label: "Support Tickets",
    description: "Public support request form and the helpdesk.",
    pages: ["support"],
    adminNav: ["/admin/support"],
  },
  {
    key: "partners",
    type: "flag",
    group: "engagement",
    label: "Partners",
    description: "Our Partners wall and partner-inquiry management.",
    pages: ["partners"],
    adminNav: ["/admin/partners"],
  },

  // ── Website & Content ────────────────────────────────────────────────────
  {
    key: "cmsPages",
    type: "flag",
    group: "content",
    label: "Website Pages (CMS)",
    description: "Editable public pages, auto-nav and the page manager.",
    pages: ["home", "about", "team", "getInvolved"],
    adminNav: ["/admin/pages", "/admin/branding"],
    core: true,
  },
  {
    key: "initiatives",
    type: "flag",
    group: "content",
    label: "Initiative Pages",
    description: "What-we-do / initiative landing pages (Education, Water, Food, Emergencies).",
    pages: ["initiatives", "education", "water", "food", "emergencies"],
  },
  {
    key: "sectionBuilder",
    type: "flag",
    group: "content",
    label: "Section Page Builder",
    description: "Drag-and-drop block/section page builder.",
  },
  {
    key: "designSystem",
    type: "flag",
    group: "content",
    label: "Design System",
    description: "Per-tenant fonts, shape and layout templates (draft/publish).",
    adminNav: ["/admin/design"],
  },

  // ── Islamic Giving (also requires the Muslim-charity vertical) ────────────
  {
    key: "islamicGiving",
    type: "flag",
    group: "islamic",
    label: "Islamic Giving Suite",
    description: "Giving hub, Zakat calculator and Ramadan pages.",
    pages: ["giving", "zakat", "ramadan"],
    vertical: "muslim",
  },

  // ── Integrations ─────────────────────────────────────────────────────────
  {
    key: "ownStripe",
    type: "flag",
    group: "integrations",
    label: "Own Stripe Account",
    description: "Tenant connects their own Stripe account for donations.",
    core: true,
  },
  {
    key: "paypal",
    type: "flag",
    group: "integrations",
    label: "PayPal",
    description: "Tenant connects their own PayPal app.",
  },
  {
    key: "customEmail",
    type: "flag",
    group: "integrations",
    label: "Custom Email (SMTP)",
    description: "Send transactional + campaign email from the tenant's own SMTP.",
  },
  {
    key: "savedCards",
    type: "flag",
    group: "integrations",
    label: "Saved Cards Vault",
    description: "Let donors securely save cards for reuse (Stripe SetupIntent).",
  },

  // ── Limits & Quotas (numeric; null = Unlimited) ──────────────────────────
  {
    key: "campaigns",
    type: "meter",
    group: "quotas",
    label: "Active Campaigns",
    unit: "campaigns",
    description: "Maximum number of active programs/campaigns.",
    count: { model: "Program", filter: { status: "active" } },
  },
  {
    key: "volunteers",
    type: "meter",
    group: "quotas",
    label: "Volunteer Applications",
    unit: "applications",
    description: "Maximum volunteer applications received.",
    count: { model: "Join" },
  },
  {
    key: "eventsQuota",
    type: "meter",
    group: "quotas",
    label: "Events",
    unit: "events",
    description: "Maximum number of events.",
    count: { model: "Event" },
  },
  {
    key: "p2pQuota",
    type: "meter",
    group: "quotas",
    label: "P2P Fundraisers",
    unit: "fundraisers",
    description: "Maximum supporter fundraisers.",
    count: { model: "P2PCampaign" },
  },
  {
    key: "productsQuota",
    type: "meter",
    group: "quotas",
    label: "Products",
    unit: "products",
    description: "Maximum products in the store.",
    count: { model: "Product" },
  },
  {
    key: "adminSeats",
    type: "meter",
    group: "quotas",
    label: "Admin Seats",
    unit: "admins",
    description: "Maximum admin users.",
    count: { model: "User", filter: { role: "admin" } },
  },
];

// ── Derived lookups ────────────────────────────────────────────────────────
const FLAGS = FEATURES.filter((f) => f.type === "flag");
const METERS = FEATURES.filter((f) => f.type === "meter");
// Flags and meters are SEPARATE namespaces (Plan.featureFlags vs Plan.limits),
// so a key like "volunteers" can legitimately exist as both — keep their lookup
// maps separate rather than collapsing them into one.
const FLAG_MAP = Object.fromEntries(FLAGS.map((f) => [f.key, f]));
const METER_MAP = Object.fromEntries(METERS.map((f) => [f.key, f]));
const FLAG_KEYS = FLAGS.map((f) => f.key);
const METER_KEYS = METERS.map((f) => f.key);

// Page key → controlling flag key (for the public-site PageGate composition).
const PAGE_TO_FLAG = {};
for (const f of FLAGS) for (const p of f.pages || []) PAGE_TO_FLAG[p] = f.key;

// Admin nav route → controlling flag key (for admin sidebar filtering).
const ADMIN_ROUTE_TO_FLAG = {};
for (const f of FLAGS) for (const r of f.adminNav || []) ADMIN_ROUTE_TO_FLAG[r] = f.key;

module.exports = {
  GROUPS,
  FEATURES,
  FLAGS,
  METERS,
  FLAG_MAP,
  METER_MAP,
  FLAG_KEYS,
  METER_KEYS,
  PAGE_TO_FLAG,
  ADMIN_ROUTE_TO_FLAG,
};
