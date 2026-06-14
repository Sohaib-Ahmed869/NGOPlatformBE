// Newsletter sending: resolve an audience to subscribers and deliver a campaign
// over the shared SMTP transport, throttled in batches so we don't trip Outlook
// rate limits. Each email carries a per-subscriber one-click unsubscribe link.
const crypto = require("crypto");
const NewsletterSubscription = require("../models/newsletter");
const { sendEmail } = require("./emailUtil");
const mailchimp = require("./mailchimp");

const BATCH_SIZE = 20; // emails per batch
const BATCH_DELAY_MS = 1500; // pause between batches

// Build the Mongo filter for a campaign's audience (active subscribers only).
function audienceFilter(orgId, audience) {
  const f = { status: "active" };
  if (orgId) f.organisationId = orgId;
  const type = audience?.type || "all_active";
  if (type === "recent") {
    const days = Number(audience?.days) || 30;
    f.createdAt = { $gte: new Date(Date.now() - days * 86400000) };
  } else if (type === "source" && audience?.source) {
    f.source = audience.source;
  }
  return f;
}

function countAudience(orgId, audience) {
  return NewsletterSubscription.countDocuments(audienceFilter(orgId, audience));
}

function buildHtml(bodyHtml, { orgName, originUrl, token }) {
  const unsubUrl = `${originUrl || ""}/unsubscribe?token=${encodeURIComponent(token)}`;
  return `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6;max-width:640px;margin:0 auto">
      ${bodyHtml}
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
      <p style="color:#999;font-size:12px">
        You're receiving this because you subscribed to ${orgName}'s newsletter.<br/>
        <a href="${unsubUrl}" style="color:#999;text-decoration:underline">Unsubscribe</a>
      </p>
    </div>`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dispatcher: route through the tenant's Mailchimp when connected, else SMTP.
async function sendCampaign(campaign, organisation) {
  const m = organisation?.mailchimp;
  if (m?.connected && m?.audienceId && m?.apiKeyEnc) {
    return sendViaMailchimp(campaign, organisation);
  }
  return sendViaSmtp(campaign, organisation);
}

// Deliver via the tenant's Mailchimp: sync active subscribers, then create and
// send a regular campaign to the audience. Mailchimp owns delivery + unsubscribe.
// Note: targets the whole audience (segment mapping not implemented yet).
async function sendViaMailchimp(campaign, organisation) {
  const orgId = organisation?._id || campaign.organisationId || null;
  const orgName = organisation?.mailchimp?.fromName || organisation?.name || "our team";
  const replyTo = organisation?.mailchimp?.fromEmail || organisation?.contactEmail;

  campaign.provider = "mailchimp";
  campaign.status = "sending";
  await campaign.save();

  // Keep the audience fresh with our current active subscribers.
  const recipients = await NewsletterSubscription.find(audienceFilter(orgId, { type: "all_active" }));
  try {
    await mailchimp.syncSubscribers(organisation, recipients);
  } catch (e) {
    console.error("Mailchimp pre-send sync failed:", e?.response?.data?.detail || e.message);
  }

  const html = mailchimp.buildHtml(campaign.body, orgName);
  const result = await mailchimp.sendCampaign(organisation, {
    subject: campaign.subject,
    fromName: orgName,
    replyTo,
    html,
  });

  const count = result.recipients || recipients.length;
  campaign.mailchimpCampaignId = result.mailchimpCampaignId;
  campaign.status = "sent";
  campaign.sentAt = new Date();
  campaign.error = "";
  campaign.stats = { recipients: count, sent: count, failed: 0 };
  await campaign.save();
  return campaign;
}

// Send a campaign over SMTP. Mutates + saves the campaign doc as it progresses
// so the admin can watch the counters move and see the final status.
async function sendViaSmtp(campaign, organisation) {
  const orgId = organisation?._id || campaign.organisationId || null;
  const orgName = organisation?.name || "our team";
  const replyTo = organisation?.contactEmail || undefined;

  const recipients = await NewsletterSubscription.find(audienceFilter(orgId, campaign.audience));

  campaign.status = "sending";
  campaign.stats = { recipients: recipients.length, sent: 0, failed: 0 };
  await campaign.save();

  let sent = 0;
  let failed = 0;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (sub) => {
        try {
          // Ensure an unsubscribe token exists (older rows may predate it).
          if (!sub.unsubscribeToken) {
            sub.unsubscribeToken = crypto.randomBytes(24).toString("hex");
            await sub.save();
          }
          const html = buildHtml(campaign.body, {
            orgName,
            originUrl: campaign.originUrl,
            token: sub.unsubscribeToken,
          });
          const res = await sendEmail(sub.email, html, campaign.subject, [], { fromName: orgName, replyTo });
          if (res?.success) sent += 1;
          else failed += 1;
        } catch (err) {
          failed += 1;
        }
      }),
    );
    campaign.stats.sent = sent;
    campaign.stats.failed = failed;
    await campaign.save();
    if (i + BATCH_SIZE < recipients.length) await sleep(BATCH_DELAY_MS);
  }

  campaign.status = "sent";
  campaign.sentAt = new Date();
  campaign.stats = { recipients: recipients.length, sent, failed };
  await campaign.save();
  return campaign;
}

module.exports = { sendCampaign, countAudience, audienceFilter, buildHtml };
