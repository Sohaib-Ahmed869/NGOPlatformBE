const crypto = require("crypto");
const Lead = require("../../models/lead");
const Organisation = require("../../models/organisation");
const PlatformSettings = require("../../models/platformSettings");
const { sendTemplateEmail } = require("../../services/emailUtil");
const { platformAppUrl } = require("../../utils/tenantUrls");
const { emitToSuperAdmins } = require("../../services/socket");
const { stripe } = require("../../services/platformStripe");

// A visitor doesn't fill this in; a bot filling every field usually does.
// Kept out of the visible layout (see GetStarted.jsx) rather than display:none,
// since some bots skip display:none fields but still tab through everything.
const HONEYPOT_FIELD = "companyWebsite2";
// A human takes longer than this to read and fill step 1. Non-blocking signal —
// stored for an operator to eyeball, not used to reject the submission.
const MIN_FILL_MS = 2500;

/** A short list of trimmed, non-empty strings — never trust client arrays raw. */
function toStringList(v, { max = 20, maxLength = 100 } = {}) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (out.length >= max) break;
    if (item === null || item === undefined || typeof item === "object") continue;
    const s = String(item).trim();
    if (s) out.push(s.slice(0, maxLength));
  }
  return out;
}

function toText(v, maxLength = 2000) {
  if (v === null || v === undefined || typeof v === "object") return "";
  return String(v).trim().slice(0, maxLength);
}

function toUtm(v) {
  if (!v || typeof v !== "object") return {};
  const out = {};
  for (const key of ["source", "medium", "campaign", "term", "content"]) {
    out[key] = toText(v[key], 200);
  }
  return out;
}

/**
 * POST /api/saas/lead — public, no auth.
 * Rich sales-qualified lead capture from the "Talk to Sales" wizard.
 */
exports.submitLead = async (req, res) => {
  try {
    const b = req.body || {};

    const orgName = toText(b.orgName, 200);
    const contactName = toText(b.contactName, 150);
    const contactEmail = toText(b.contactEmail, 250).toLowerCase();
    const consentToContact = b.consentToContact === true || b.consentToContact === "true";

    if (!orgName || !contactName || !contactEmail) {
      return res.status(400).json({ error: "Organisation name, your name and email are required" });
    }
    if (!/\S+@\S+\.\S+/.test(contactEmail)) {
      return res.status(400).json({ error: "Invalid email address" });
    }
    if (!consentToContact) {
      return res.status(400).json({ error: "Please confirm we can contact you" });
    }

    const honeypotTriggered = !!toText(b[HONEYPOT_FIELD], 500);
    const loadedAt = Number(b.formLoadedAt);
    const fastSubmit = Number.isFinite(loadedAt) && loadedAt > 0 && Date.now() - loadedAt < MIN_FILL_MS;
    const submitIp = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "";

    const lead = await Lead.create({
      orgName,
      orgWebsite: toText(b.orgWebsite, 300),
      verticalType: b.verticalType === "muslim" ? "muslim" : "general",
      causeAreas: toStringList(b.causeAreas),
      country: toText(b.country, 100),

      contactName,
      contactEmail,
      contactPhone: toText(b.contactPhone, 50),
      contactRole: toText(b.contactRole, 100),

      staffSize: ["1-5", "6-20", "21-50", "51-200", "200+"].includes(b.staffSize) ? b.staffSize : "",
      annualBudgetRange: ["under_50k", "50k_250k", "250k_1m", "1m_5m", "5m_plus"].includes(b.annualBudgetRange)
        ? b.annualBudgetRange
        : "",
      donorDatabaseSize: ["under_500", "500_2500", "2500_10000", "10000_plus", "unsure"].includes(b.donorDatabaseSize)
        ? b.donorDatabaseSize
        : "",

      currentTools: toStringList(b.currentTools),
      currentToolsOther: toText(b.currentToolsOther, 300),
      challenges: toStringList(b.challenges),
      challengesOther: toText(b.challengesOther, 300),

      interestedPlan: toText(b.interestedPlan, 60),
      interestedBillingCycle: ["monthly", "annual"].includes(b.interestedBillingCycle) ? b.interestedBillingCycle : "",
      timeline: ["immediately", "this_month", "this_quarter", "this_year", "just_researching"].includes(b.timeline)
        ? b.timeline
        : "",
      decisionRole: ["decision_maker", "influencer", "researching_for_others"].includes(b.decisionRole)
        ? b.decisionRole
        : "",
      message: toText(b.message, 3000),

      source: ["get_started_form", "contact_page", "referral", "other"].includes(b.source) ? b.source : "get_started_form",
      utm: toUtm(b.utm),
      referrerUrl: toText(b.referrerUrl, 500),
      landingPage: toText(b.landingPage, 500),

      consentToContact: true,
      consentAt: new Date(),

      honeypotTriggered,
      fastSubmit,
      flaggedSpam: honeypotTriggered,
      submitIp,

      stage: honeypotTriggered ? "lost" : "new",
      lostReason: honeypotTriggered ? "spam" : "",
      lostAt: honeypotTriggered ? new Date() : null,
      lastMessageAt: new Date(),
    });

    // A honeypot hit still keeps the record (visible to an operator instead of
    // vanishing) but never wakes anyone up or counts toward the badge.
    if (!honeypotTriggered) {
      emitToSuperAdmins("lead:new", { id: String(lead._id) });

      // Best-effort alert — never let a mail failure fail the submission.
      (async () => {
        try {
          const platform = await PlatformSettings.getSingleton();
          const to = platform?.contactEmail || "support@ngoplatform.com";
          const mail = await sendTemplateEmail("lead.newLeadAlert", {
            to,
            data: {
              lead: {
                orgName,
                contactName,
                contactEmail,
                contactPhone: lead.contactPhone || "",
                plan: lead.interestedPlan || "",
                message: [
                  lead.timeline ? `Timeline: ${lead.timeline}` : "",
                  lead.message || "",
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                url: platformAppUrl(`/leads/${lead._id}`),
              },
            },
            meta: { leadId: String(lead._id) },
          });
          if (!mail?.success) console.error("New-lead alert email failed:", mail?.error?.message || mail?.message);
        } catch (e) {
          console.error("New-lead alert email failed:", e.message);
        }
      })();
    }

    res.status(201).json({ message: "Thanks — we'll be in touch soon.", leadId: lead._id });
  } catch (error) {
    console.error("Submit lead error:", error);
    res.status(500).json({ error: "Failed to submit. Please try again." });
  }
};

/**
 * GET /api/saas/lead/prefill/:token — public.
 * Resolves an activation-link token to the safe subset of a lead's data,
 * for RegistrationFlow.jsx to prefill. Never exposes the full lead record.
 */
exports.getPrefill = async (req, res) => {
  try {
    const token = String(req.params.token || "");
    if (!token) return res.status(404).json({ error: "Link not found" });
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const lead = await Lead.findOne({
      "activation.tokenHash": tokenHash,
      "activation.tokenExpiresAt": { $gt: new Date() },
    });
    if (!lead || ["won", "lost"].includes(lead.stage)) {
      return res.status(404).json({ error: "This link has expired or is no longer valid" });
    }

    if (!lead.activation.openedAt) {
      // Best-effort — never block the prefill response over this write.
      Lead.updateOne({ _id: lead._id }, { $set: { "activation.openedAt": new Date() } }).catch(() => {});
    }

    const payload = {
      orgName: lead.orgName,
      adminName: lead.contactName,
      adminEmail: lead.contactEmail,
      plan: lead.interestedPlan || "",
      billingCycle: lead.interestedBillingCycle || "",
      isMuslimCharity: lead.verticalType === "muslim",
    };

    // The operator may have already created this org + Stripe subscription
    // (Convert → "send a payment link") — if so, skip straight to the Payment
    // step instead of re-collecting org details the operator already entered.
    const pendingOrg = await Organisation.findOne({ sourceLeadId: lead._id, isActive: false })
      .sort({ createdAt: -1 })
      .select("slug stripeSubscriptionId plan billingCycle");
    if (pendingOrg?.stripeSubscriptionId) {
      try {
        const subscription = await stripe.subscriptions.retrieve(pendingOrg.stripeSubscriptionId, {
          expand: ["latest_invoice.payment_intent"],
        });
        const clientSecret = subscription.latest_invoice?.payment_intent?.client_secret;
        if (clientSecret && ["active", "trialing", "incomplete"].includes(subscription.status)) {
          payload.resume = { slug: pendingOrg.slug, orgId: String(pendingOrg._id), clientSecret, plan: pendingOrg.plan, billingCycle: pendingOrg.billingCycle };
        }
      } catch (e) {
        console.error("Failed to resolve resume payment for lead prefill:", e.message);
      }
    }

    res.json(payload);
  } catch (error) {
    console.error("Get lead prefill error:", error);
    res.status(500).json({ error: "Failed to load your details" });
  }
};
