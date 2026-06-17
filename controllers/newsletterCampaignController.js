// controllers/newsletterCampaignController.js
const NewsletterCampaign = require("../models/newsletterCampaign");
const NewsletterSubscription = require("../models/newsletter");
const CampaignRecipient = require("../models/CampaignRecipient");
const { sendCampaign, countAudience } = require("../services/newsletterSender");
const { sendEmail } = require("../services/emailUtil");

const plain = (html) =>
  String(html || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();

const orgOf = (req) => req.organisation?._id || null;

/* ── list / read ─────────────────────────────────────────────────────── */

exports.list = async (req, res) => {
  try {
    const filter = {};
    const orgId = orgOf(req);
    if (orgId) filter.organisationId = orgId;
    const campaigns = await NewsletterCampaign.find(filter)
      .sort({ createdAt: -1 })
      .populate("createdBy", "name email")
      .lean();
    res.json(campaigns);
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: e.message });
  }
};

exports.get = async (req, res) => {
  try {
    const orgId = orgOf(req);
    const filter = { _id: req.params.id };
    if (orgId) filter.organisationId = orgId;
    const campaign = await NewsletterCampaign.findOne(filter).populate("createdBy", "name email").lean();
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    res.json(campaign);
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: e.message });
  }
};

// Live recipient count for an audience (so the composer can preview reach).
exports.recipientCount = async (req, res) => {
  try {
    const audience = {
      type: req.query.type || "all_active",
      days: req.query.days ? Number(req.query.days) : 30,
      source: req.query.source || "",
    };
    const count = await countAudience(orgOf(req), audience);
    res.json({ count });
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: e.message });
  }
};

/* ── create / update / delete ────────────────────────────────────────── */

exports.create = async (req, res) => {
  try {
    const { subject, body, audience } = req.body;
    const campaign = await NewsletterCampaign.create({
      organisationId: orgOf(req),
      subject: subject || "",
      body: body || "",
      audience: audience || { type: "all_active" },
      createdBy: req.user._id,
    });
    res.status(201).json(campaign);
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: e.message });
  }
};

async function loadEditable(req, res) {
  const orgId = orgOf(req);
  const filter = { _id: req.params.id };
  if (orgId) filter.organisationId = orgId;
  const campaign = await NewsletterCampaign.findOne(filter);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return null;
  }
  return campaign;
}

exports.update = async (req, res) => {
  try {
    const campaign = await loadEditable(req, res);
    if (!campaign) return;
    if (["sending", "sent"].includes(campaign.status)) {
      return res.status(400).json({ error: "A sent campaign can't be edited" });
    }
    const { subject, body, audience } = req.body;
    if (subject !== undefined) campaign.subject = subject;
    if (body !== undefined) campaign.body = body;
    if (audience !== undefined) campaign.audience = audience;
    await campaign.save();
    res.json(campaign);
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: e.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const orgId = orgOf(req);
    const filter = { _id: req.params.id };
    if (orgId) filter.organisationId = orgId;
    const campaign = await NewsletterCampaign.findOneAndDelete(filter);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    await CampaignRecipient.deleteMany({ campaignId: campaign._id }); // cleanup per-recipient rows
    res.json({ message: "Campaign deleted", id: req.params.id });
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: e.message });
  }
};

// GET /:id/failures — the recipients that didn't get the campaign (failed,
// bounced or skipped), so the admin can see why and clean the list.
exports.failures = async (req, res) => {
  try {
    const orgId = orgOf(req);
    const filter = { _id: req.params.id };
    if (orgId) filter.organisationId = orgId;
    const campaign = await NewsletterCampaign.findOne(filter).select("_id");
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const rows = await CampaignRecipient.find({
      campaignId: campaign._id,
      status: { $in: ["failed", "bounced", "skipped"] },
    })
      .select("email status failureCode failureReason attempts")
      .sort({ status: 1, email: 1 })
      .limit(1000)
      .lean();
    res.json(rows);
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: e.message });
  }
};

/* ── send / schedule ─────────────────────────────────────────────────── */

exports.sendNow = async (req, res) => {
  try {
    const campaign = await loadEditable(req, res);
    if (!campaign) return;
    if (["sending", "sent"].includes(campaign.status)) {
      return res.status(400).json({ error: "This campaign has already been sent" });
    }
    if (!campaign.subject?.trim() || !plain(campaign.body)) {
      return res.status(400).json({ error: "A subject and message are required" });
    }
    campaign.originUrl = req.headers.origin || campaign.originUrl || "";
    campaign.status = "sending";
    campaign.scheduledAt = null;
    await campaign.save();

    // Fire-and-forget: don't hold the HTTP request open for the whole send.
    sendCampaign(campaign, req.organisation).catch(async (err) => {
      console.error("sendCampaign failed:", err);
      try {
        campaign.status = "failed";
        campaign.error = err?.response?.data?.detail || err?.message || "Send failed";
        await campaign.save();
      } catch (_) {
        /* ignore */
      }
    });

    res.status(202).json(campaign);
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: e.message });
  }
};

exports.schedule = async (req, res) => {
  try {
    const campaign = await loadEditable(req, res);
    if (!campaign) return;
    if (["sending", "sent"].includes(campaign.status)) {
      return res.status(400).json({ error: "This campaign has already been sent" });
    }
    if (!campaign.subject?.trim() || !plain(campaign.body)) {
      return res.status(400).json({ error: "A subject and message are required" });
    }
    const when = new Date(req.body.scheduledAt);
    if (isNaN(when.getTime()) || when.getTime() <= Date.now()) {
      return res.status(400).json({ error: "Pick a date and time in the future" });
    }
    campaign.originUrl = req.headers.origin || campaign.originUrl || "";
    campaign.status = "scheduled";
    campaign.scheduledAt = when;
    await campaign.save();
    res.json(campaign);
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: e.message });
  }
};

exports.cancelSchedule = async (req, res) => {
  try {
    const campaign = await loadEditable(req, res);
    if (!campaign) return;
    if (campaign.status !== "scheduled") {
      return res.status(400).json({ error: "Campaign is not scheduled" });
    }
    campaign.status = "draft";
    campaign.scheduledAt = null;
    await campaign.save();
    res.json(campaign);
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: e.message });
  }
};

// Send a one-off preview of the content to the signed-in admin.
exports.testSend = async (req, res) => {
  try {
    const { subject, body } = req.body;
    if (!subject?.trim() || !plain(body)) {
      return res.status(400).json({ error: "A subject and message are required" });
    }
    const orgName = req.organisation?.name || "our team";
    const html = `
      <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6;max-width:640px;margin:0 auto">
        ${body}
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
        <p style="color:#999;font-size:12px">This is a test send of your newsletter — the live version includes an unsubscribe link.</p>
      </div>`;
    const result = await sendEmail(req.user.email, html, `[TEST] ${subject}`, [], {
      org: req.organisation,
      fromName: orgName,
      replyTo: req.organisation?.contactEmail || undefined,
    });
    res.json({ ok: !!result?.success, to: req.user.email });
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: e.message });
  }
};

/* ── public: one-click unsubscribe (token self-identifies, no auth/tenant) ── */

exports.unsubscribe = async (req, res) => {
  try {
    const token = req.body?.token || req.query?.token;
    if (!token) return res.status(400).json({ error: "Missing unsubscribe token" });
    const sub = await NewsletterSubscription.findOne({ unsubscribeToken: token });
    if (!sub) return res.status(404).json({ error: "This unsubscribe link is invalid or expired" });
    if (sub.status !== "unsubscribed") {
      sub.status = "unsubscribed";
      await sub.save();
    }
    res.json({ ok: true, email: sub.email });
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: e.message });
  }
};
