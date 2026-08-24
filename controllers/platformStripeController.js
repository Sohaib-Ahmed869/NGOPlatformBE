const Stripe = require("stripe");
const PlatformSettings = require("../models/platformSettings");
const { encrypt, decrypt } = require("../utils/crypto");
const platformStripe = require("../services/platformStripe");
const { stripe } = require("../services/platformStripe");
const stripeCatalogResync = require("../services/stripeCatalogResync");
const writeAudit = require("../utils/writeAudit");
const { emitToSuperAdmins } = require("../services/socket");
const { publicBaseUrl, isPubliclyReachable } = require("../utils/publicUrl");

/**
 * Platform-level Stripe credentials (the account that bills tenants for their
 * SaaS subscription). The tenant-level equivalent is paymentConfigController.js.
 *
 * Rules this file exists to enforce:
 *  - A secret never leaves the server. Responses carry a masked hint only.
 *  - A key that doesn't authenticate is never stored. Getting this wrong breaks
 *    tenant signup and subscription billing for every tenant at once, so the
 *    save path verifies against Stripe first rather than after.
 *  - Test and live keys are never mixed, which otherwise fails much later with
 *    an opaque "No such customer".
 */

const RE_SECRET = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/;
const RE_PUBLISHABLE = /^pk_(test|live)_[A-Za-z0-9]{10,}$/;
const RE_WEBHOOK = /^whsec_[A-Za-z0-9_]{10,}$/;

const keyMode = (key) => (/_live_/.test(key) ? "live" : /_test_/.test(key) ? "test" : null);

/** "sk_live_••••••••4242" — enough to identify the key, useless to an attacker. */
function maskKey(key) {
  if (!key) return "";
  const prefix = key.slice(0, key.indexOf("_", key.indexOf("_") + 1) + 1); // "sk_live_"
  return `${prefix}${"•".repeat(8)}${key.slice(-4)}`;
}

/**
 * Load ONLY the stripe sub-document (creating the singleton if it's missing).
 * getSingleton() pulls the whole settings document — branding, socials, the
 * plan-bullet library — none of which this controller touches.
 */
async function loadStripeDoc() {
  const doc = await PlatformSettings.findOne({ key: "platform" }).select("stripe");
  return doc || PlatformSettings.create({ key: "platform" });
}

/** Exactly what the console is allowed to see. Contains no secret material. */
function maskedConfig(s, req) {
  const c = s.stripe || {};
  const runtime = platformStripe.describeSource();
  const base = req ? publicBaseUrl(req) : "";
  const webhookUrl = base ? `${base}/api/saas/webhooks/stripe` : "";
  // Enabled with a stored key, yet the resolver ISN'T using it → the ciphertext
  // wouldn't decrypt (PAYMENT_ENC_KEY rotated) or the read failed. Derived from
  // the resolver rather than by decrypting here, so the read path stays free of
  // plaintext and this reflects what the server is actually doing.
  const secretBroken = !!c.enabled && !!c.secretKeyEnc && runtime.secretSource !== "database";

  return {
    enabled: !!c.enabled,
    mode: c.mode || "test",
    publishableKey: c.publishableKey || "",
    hasSecretKey: !!c.secretKeyEnc,
    secretKeyMask: c.secretKeyMask || "",
    secretKeyBroken: secretBroken,
    hasWebhookSecret: !!c.webhookSecretEnc,
    // Set only when the endpoint was created FROM the console, so the screen can
    // offer "recreate" instead of "create" and avoid a second endpoint quietly
    // delivering duplicate events to the same URL.
    webhookEndpointId: c.webhookEndpointId || "",
    accountLabel: c.accountLabel || "",
    accountId: c.accountId || "",
    lastVerifiedAt: c.lastVerifiedAt || null,
    // The single deliberate bridge to the TENANT Stripe setup. Off means a
    // tenant with no account of their own simply cannot take card donations.
    allowTenantFallback: c.allowTenantFallback !== false,
    // Which credentials the running server is ACTUALLY using right now. Without
    // this the screen can't distinguish "saved and live" from "saved but the
    // env var is still winning", which is the confusing half of this feature.
    runtime,
    envFallbackAvailable: !!(process.env.STRIPE_SECRET_KEY || "").trim(),
    // The endpoint to register in Stripe. Flagged when it resolves to a local
    // address, because Stripe cannot deliver there — the same trap that makes
    // webhook-only tenant activation fail in development.
    webhookUrl,
    webhookReachable: isPubliclyReachable(base),
  };
}

/** Tell other open consoles their cached Stripe view is stale. */
function broadcast() {
  try {
    emitToSuperAdmins("platform:updated", { section: "stripe" });
  } catch (e) {
    // A socket failure must never fail the save that already committed.
    console.error("platform stripe broadcast failed:", e.message);
  }
}

/** Authenticate a secret key against Stripe. Throws with Stripe's own message. */
async function verifyKey(secret) {
  const acct = await Stripe(secret).accounts.retrieve();
  return {
    id: acct.id,
    label:
      acct.settings?.dashboard?.display_name ||
      acct.business_profile?.name ||
      acct.email ||
      acct.id,
    email: acct.email || "",
    country: acct.country || "",
  };
}

/**
 * GET /api/platform/settings/stripe  (superadmin)
 */
exports.getConfig = async (req, res) => {
  try {
    const s = await loadStripeDoc();
    // Self-heal rows saved before the mask was stored: decrypt once, persist the
    // hint, and never decrypt on a read again.
    if (s.stripe?.secretKeyEnc && !s.stripe.secretKeyMask) {
      const plain = decrypt(s.stripe.secretKeyEnc);
      if (plain) {
        s.stripe.secretKeyMask = maskKey(plain);
        s.markModified("stripe");
        await s.save();
      }
    }
    res.json(maskedConfig(s, req));
  } catch (error) {
    console.error("Get platform Stripe config error:", error);
    res.status(500).json({ error: "Failed to load Stripe configuration" });
  }
};

/**
 * PUT /api/platform/settings/stripe  (superadmin)
 * Blank secret fields mean "leave unchanged" — the client never receives them,
 * so it cannot echo them back.
 */
exports.updateConfig = async (req, res) => {
  try {
    const b = req.body || {};
    const s = await loadStripeDoc();
    const cur = s.stripe || {};

    const secretKey = typeof b.secretKey === "string" ? b.secretKey.trim() : "";
    const webhookSecret = typeof b.webhookSecret === "string" ? b.webhookSecret.trim() : "";
    const publishableKey =
      b.publishableKey !== undefined ? String(b.publishableKey).trim() : undefined;

    if (secretKey && !RE_SECRET.test(secretKey)) {
      return res.status(400).json({
        error: "That doesn't look like a Stripe secret key. It should start with sk_test_ or sk_live_.",
      });
    }
    if (publishableKey && !RE_PUBLISHABLE.test(publishableKey)) {
      return res.status(400).json({
        error: "That doesn't look like a Stripe publishable key. It should start with pk_test_ or pk_live_.",
      });
    }
    if (webhookSecret && !RE_WEBHOOK.test(webhookSecret)) {
      return res.status(400).json({
        error: "That doesn't look like a webhook signing secret. It should start with whsec_.",
      });
    }

    // The effective key pair after this save — test/live must agree. Mixing them
    // authenticates fine and then fails at checkout with an unrelated error.
    const effectiveSecret = secretKey || (cur.secretKeyEnc ? decrypt(cur.secretKeyEnc) : "");
    const effectivePublishable =
      publishableKey !== undefined ? publishableKey : cur.publishableKey || "";
    if (effectiveSecret && effectivePublishable) {
      const sm = keyMode(effectiveSecret);
      const pm = keyMode(effectivePublishable);
      if (sm && pm && sm !== pm) {
        return res.status(400).json({
          error: `Key mode mismatch: the secret key is ${sm} but the publishable key is ${pm}. Both must come from the same Stripe mode.`,
        });
      }
    }

    // A stored key that won't decrypt (PAYMENT_ENC_KEY / JWT_SECRET rotated after
    // it was saved). Without this branch every save — even just editing the
    // publishable key — failed with "add a secret key before enabling", which is
    // both untrue (one IS stored) and useless (it doesn't say how to recover).
    if (!secretKey && cur.secretKeyEnc && !effectiveSecret && b.enabled !== false) {
      // Re-resolve so the console's status line stops claiming the stored key is
      // in use, then say exactly what fixes it.
      await platformStripe.invalidate();
      return res.status(400).json({
        error:
          "The stored secret key can no longer be decrypted (PAYMENT_ENC_KEY may have changed). Enter the secret key again, or remove the configuration to fall back to STRIPE_SECRET_KEY.",
        secretKeyBroken: true,
      });
    }

    const enabling = b.enabled !== undefined ? !!b.enabled : !!cur.enabled;
    if (enabling && !effectiveSecret) {
      return res.status(400).json({ error: "Add a secret key before enabling platform Stripe." });
    }

    // Verify BEFORE storing whenever a new key arrives or we're switching on.
    // A bad platform key takes down tenant signup and every subscription renewal,
    // so "save now, discover later" isn't an acceptable trade here.
    let account = null;
    const mustVerify = !!secretKey || (enabling && !cur.enabled);
    if (mustVerify && effectiveSecret) {
      try {
        account = await verifyKey(effectiveSecret);
      } catch (err) {
        return res.status(400).json({
          error: `Stripe rejected that key: ${err.message}`,
          verifyFailed: true,
        });
      }
    }

    // ── Moving the platform to a different Stripe account ────────────────
    // Plan.stripeProductId / stripePriceIds and Coupon.stripeCouponId are ids
    // that only resolve inside one account. Point the platform somewhere else
    // and every one of them dangles — and the damage doesn't surface here, it
    // surfaces at the next tenant's checkout as "No such price". So this is a
    // confirmed action: the first request reports what is at stake and only a
    // request carrying confirmAccountSwitch proceeds.
    //
    // Two cases need catching, not one:
    //
    //  certain  — a previous account id is on record and the new key's differs.
    //  unproven — nothing is on record (the platform has been running on
    //             STRIPE_SECRET_KEY, or this is the first key ever saved here)
    //             yet the catalogue already carries Stripe ids. Those ids were
    //             minted in SOME account, and nothing here can show it is this
    //             one. Only warning on the `certain` case let precisely this
    //             situation — the common one for a platform being moved off env
    //             config — break the entire catalogue in silence.
    //
    // The repair is idempotent (it probes each id before touching it), so
    // confirming an `unproven` switch that turns out to be the same account
    // costs a few Stripe reads and changes nothing.
    const certainSwitch = !!(account && cur.accountId && account.id !== cur.accountId);
    const unprovenSwitch = !!(account && !cur.accountId);

    let switchingAccount = certainSwitch;
    if ((certainSwitch || unprovenSwitch) && !b.confirmAccountSwitch) {
      let impact = { plans: 0, coupons: 0, planNames: [], couponCodes: [] };
      try {
        impact = await stripeCatalogResync.summarize();
      } catch (e) {
        console.error("Could not summarise catalogue for account switch:", e.message);
      }
      // With an empty catalogue an unproven switch strands nothing — don't make
      // the operator confirm a decision with no consequence.
      const atStake = impact.plans + impact.coupons > 0;
      if (certainSwitch || atStake) {
        return res.status(409).json({
          error: certainSwitch
            ? `This key belongs to a different Stripe account (${account.label}). ` +
              `${impact.plans} plan(s) and ${impact.coupons} coupon(s) still reference the ` +
              `previous account and will stop working until they are re-created here.`
            : `${impact.plans} plan(s) and ${impact.coupons} coupon(s) already reference a Stripe ` +
              `account. They may not exist in ${account.label} — confirm to check each one and ` +
              `re-create whatever is missing.`,
          accountSwitch: {
            certain: certainSwitch,
            fromId: cur.accountId,
            fromLabel: cur.accountLabel || cur.accountId || "an unrecorded account",
            toId: account.id,
            toLabel: account.label,
            ...impact,
          },
        });
      }
    }
    // A confirmed unproven switch still needs the catalogue checked; only a
    // CERTAIN move invalidates the stored webhook secret, which is why the two
    // are tracked apart.
    if (b.confirmAccountSwitch && (certainSwitch || unprovenSwitch)) switchingAccount = true;

    const before = {
      enabled: !!cur.enabled,
      mode: cur.mode || "test",
      publishableKey: cur.publishableKey || "",
      hasSecretKey: !!cur.secretKeyEnc,
      hasWebhookSecret: !!cur.webhookSecretEnc,
      accountId: cur.accountId || "",
      allowTenantFallback: cur.allowTenantFallback !== false,
    };

    if (publishableKey !== undefined) s.stripe.publishableKey = publishableKey;
    if (secretKey) {
      s.stripe.secretKeyEnc = encrypt(secretKey);
      s.stripe.secretKeyMask = maskKey(secretKey); // computed once, here
    }
    if (webhookSecret) s.stripe.webhookSecretEnc = encrypt(webhookSecret);
    if (b.enabled !== undefined) s.stripe.enabled = !!b.enabled;
    if (b.allowTenantFallback !== undefined) s.stripe.allowTenantFallback = !!b.allowTenantFallback;
    // Mode is derived from the key, never taken from the client — the two can't
    // disagree that way.
    if (effectiveSecret) s.stripe.mode = keyMode(effectiveSecret) || s.stripe.mode;
    if (account) {
      s.stripe.accountId = account.id;
      s.stripe.accountLabel = account.label;
      s.stripe.lastVerifiedAt = new Date();
    }
    if (certainSwitch) {
      // The webhook endpoint (and its signing secret) lived in the OLD account.
      // Keeping either would leave the screen claiming a webhook is configured
      // while every incoming event fails signature verification. Only done for a
      // proven move: discarding a working secret on a hunch would break billing
      // to fix a problem that may not exist.
      s.stripe.webhookEndpointId = "";
      if (!webhookSecret) s.stripe.webhookSecretEnc = "";
    }
    s.markModified("stripe");
    await s.save();

    // Swap the running server onto the new credentials without a restart.
    await platformStripe.invalidate();
    broadcast();

    // Re-create the catalogue in the new account. Runs AFTER the save and the
    // resolver swap, so it provisions against the account now in force. Failures
    // are reported, never thrown: the key is already stored and correct, and
    // losing that to a catalogue hiccup would be the worse outcome.
    let catalog = null;
    if (switchingAccount) {
      try {
        catalog = await stripeCatalogResync.resync();
      } catch (e) {
        console.error("Catalogue resync after account switch failed:", e.message);
        catalog = { error: e.message };
      }
    }

    const after = {
      enabled: !!s.stripe.enabled,
      mode: s.stripe.mode,
      publishableKey: s.stripe.publishableKey || "",
      hasSecretKey: !!s.stripe.secretKeyEnc,
      hasWebhookSecret: !!s.stripe.webhookSecretEnc,
      accountId: s.stripe.accountId || "",
      allowTenantFallback: s.stripe.allowTenantFallback !== false,
    };
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    if (changed.length || secretKey || webhookSecret) {
      await writeAudit(req, "platform.stripe_updated", {
        targetType: "platform",
        targetId: "stripe",
        meta: {
          changed,
          // Booleans, modes and account ids only — no key material, not even masked.
          before,
          after,
          rotatedSecretKey: !!secretKey,
          rotatedWebhookSecret: !!webhookSecret,
          switchedAccount: switchingAccount,
          catalogRepaired: catalog
            ? {
                plans: catalog.plans?.repaired?.length || 0,
                coupons: catalog.coupons?.repaired?.length || 0,
                failed:
                  (catalog.plans?.failed?.length || 0) + (catalog.coupons?.failed?.length || 0),
              }
            : undefined,
        },
      });
    }

    res.json({
      message: "Stripe configuration saved",
      config: maskedConfig(s, req),
      account,
      switchedAccount: switchingAccount,
      catalog,
    });
  } catch (error) {
    console.error("Update platform Stripe config error:", error);
    res.status(500).json({ error: "Failed to save Stripe configuration" });
  }
};

/**
 * POST /api/platform/settings/stripe/test  (superadmin)
 * Check the stored key (or one typed into the form, before saving it).
 */
exports.testConnection = async (req, res) => {
  try {
    const s = await loadStripeDoc();
    const typed = typeof req.body?.secretKey === "string" ? req.body.secretKey.trim() : "";
    if (typed && !RE_SECRET.test(typed)) {
      return res.status(400).json({ ok: false, error: "That doesn't look like a Stripe secret key." });
    }
    const stored = s.stripe?.secretKeyEnc ? decrypt(s.stripe.secretKeyEnc) : "";
    // Fall back to whatever the platform is ACTUALLY billing with. Testing only
    // the stored key reported "no secret key" on a platform running fine on
    // STRIPE_SECRET_KEY — the button said Stripe was unconfigured while every
    // plan and coupon on the next screen was syncing to it.
    const envInUse = !typed && !stored ? platformStripe.activeSecret() : "";
    const secret = typed || stored || envInUse;
    if (!secret) {
      return res.status(400).json({ ok: false, error: "No secret key to test — enter or save one first." });
    }
    const testingStored = !typed && !!stored;

    let account;
    try {
      account = await verifyKey(secret);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message || "Could not connect to Stripe with that key" });
    }

    // Only stamp the record when we tested what's actually STORED — a pass
    // against the env key says nothing about the saved configuration.
    if (testingStored) {
      s.stripe.accountId = account.id;
      s.stripe.accountLabel = account.label;
      s.stripe.lastVerifiedAt = new Date();
      s.markModified("stripe");
      await s.save();
      await writeAudit(req, "platform.stripe_verified", {
        targetType: "platform",
        targetId: "stripe",
        meta: { accountId: account.id, mode: keyMode(secret) },
      });
    }

    res.json({
      ok: true,
      account,
      mode: keyMode(secret),
      // Name which credential answered, so the screen can say "tested the
      // environment key" rather than implying the stored config is live.
      testedSource: typed ? "entered" : stored ? "stored" : "env",
      config: maskedConfig(s, req),
    });
  } catch (error) {
    console.error("Test platform Stripe connection error:", error);
    res.status(500).json({ ok: false, error: "Failed to test Stripe connection" });
  }
};

/* ── Webhook endpoint provisioning ──────────────────────────────────────────
 * Registering the SaaS billing webhook by hand means leaving the console, going
 * to the Stripe dashboard, picking the right events, and pasting a whsec_ back —
 * with a real chance of pasting the DONATION endpoint's secret into the billing
 * slot, which fails signature verification on every event and looks like Stripe
 * simply isn't calling. Since we already hold an authenticated client, the
 * console can just create the endpoint and capture the secret itself.
 */

// Exactly the events controllers/saas/webhookController.js acts on. Subscribing
// to more would spend rate limit on events we log and drop.
const SAAS_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
];

/**
 * POST /api/platform/settings/stripe/webhook  (superadmin)
 * Create the SaaS billing webhook endpoint in the connected account and store
 * its signing secret. Pass { recreate: true } to replace an existing endpoint —
 * Stripe reveals a signing secret only at creation, so an endpoint whose secret
 * was never saved can only be recovered by making a new one.
 */
exports.createWebhook = async (req, res) => {
  try {
    const s = await loadStripeDoc();
    const runtime = platformStripe.describeSource();

    // Deliberately refuse to provision against the env key: the endpoint would
    // be created in whatever account STRIPE_SECRET_KEY points at, while the
    // secret got stored under a config the server isn't using — a webhook that
    // exists, is charged for, and silently verifies nothing.
    if (runtime.secretSource !== "database") {
      return res.status(400).json({
        error:
          "Save and enable a secret key here first. Right now the server is using STRIPE_SECRET_KEY, so an endpoint created from this screen would belong to a different account than the stored configuration.",
      });
    }

    const base = publicBaseUrl(req);
    const url = base ? `${base}/api/saas/webhooks/stripe` : "";
    if (!isPubliclyReachable(base)) {
      return res.status(400).json({
        error: `Stripe cannot deliver to ${url || "this server"} — it isn't publicly reachable. Set PUBLIC_API_URL to the deployed backend, or use \`stripe listen\` in development.`,
      });
    }

    const recreate = !!req.body?.recreate;

    // An endpoint for this exact URL may already exist — created by an earlier
    // run, or by hand in the dashboard. Creating a second one would double every
    // event, so reuse is the default and replacement must be asked for.
    let existing = null;
    try {
      const list = await stripe.webhookEndpoints.list({ limit: 100 });
      existing = list.data.find((e) => e.url === url) || null;
    } catch (err) {
      return res.status(400).json({ error: `Could not read webhook endpoints from Stripe: ${err.message}` });
    }

    if (existing && !recreate) {
      return res.status(409).json({
        error:
          "An endpoint for this URL already exists in Stripe. Its signing secret can only be read at creation, so recreating it is the only way to capture one here.",
        existing: { id: existing.id, url: existing.url, status: existing.status },
        canRecreate: true,
      });
    }

    if (existing && recreate) {
      try {
        await stripe.webhookEndpoints.del(existing.id);
      } catch (err) {
        return res.status(400).json({ error: `Could not remove the existing endpoint: ${err.message}` });
      }
    }

    let endpoint;
    try {
      endpoint = await stripe.webhookEndpoints.create({
        url,
        enabled_events: SAAS_WEBHOOK_EVENTS,
        description: "SaaS subscription billing (created from the SuperAdmin console)",
      });
    } catch (err) {
      return res.status(400).json({ error: `Stripe rejected the endpoint: ${err.message}` });
    }

    // `secret` is present only on the create response — this is the one moment
    // it can ever be captured.
    if (!endpoint.secret) {
      return res.status(500).json({
        error:
          "Stripe created the endpoint but returned no signing secret. Copy it from the Stripe dashboard and paste it above.",
      });
    }

    s.stripe.webhookSecretEnc = encrypt(endpoint.secret);
    s.stripe.webhookEndpointId = endpoint.id;
    s.markModified("stripe");
    await s.save();

    await platformStripe.invalidate();
    broadcast();

    await writeAudit(req, "platform.stripe_webhook_created", {
      targetType: "platform",
      targetId: "stripe",
      meta: { endpointId: endpoint.id, url, replaced: existing ? existing.id : null, events: SAAS_WEBHOOK_EVENTS.length },
    });

    res.json({
      message: existing ? "Webhook endpoint replaced" : "Webhook endpoint created",
      endpoint: { id: endpoint.id, url: endpoint.url, events: SAAS_WEBHOOK_EVENTS },
      config: maskedConfig(s, req),
    });
  } catch (error) {
    console.error("Create platform Stripe webhook error:", error);
    res.status(500).json({ error: "Failed to create the webhook endpoint" });
  }
};

/**
 * DELETE /api/platform/settings/stripe  (superadmin)
 * Clear the stored credentials. The server falls back to STRIPE_SECRET_KEY.
 */
exports.clearConfig = async (req, res) => {
  try {
    const s = await loadStripeDoc();
    const had = !!s.stripe?.secretKeyEnc;

    s.stripe.enabled = false;
    s.stripe.publishableKey = "";
    s.stripe.secretKeyEnc = "";
    s.stripe.secretKeyMask = "";
    s.stripe.webhookSecretEnc = "";
    s.stripe.webhookEndpointId = "";
    // Back to env credentials, where the tenant fallback is always on — storing
    // anything else here would misreport what the server actually does.
    s.stripe.allowTenantFallback = true;
    s.stripe.accountLabel = "";
    s.stripe.accountId = "";
    s.stripe.lastVerifiedAt = null;
    s.markModified("stripe");
    await s.save();

    await platformStripe.invalidate();
    broadcast();

    await writeAudit(req, "platform.stripe_cleared", {
      targetType: "platform",
      targetId: "stripe",
      meta: { hadStoredKey: had, fallsBackToEnv: !!(process.env.STRIPE_SECRET_KEY || "").trim() },
    });

    res.json({ message: "Stripe configuration cleared", config: maskedConfig(s, req) });
  } catch (error) {
    console.error("Clear platform Stripe config error:", error);
    res.status(500).json({ error: "Failed to clear Stripe configuration" });
  }
};
