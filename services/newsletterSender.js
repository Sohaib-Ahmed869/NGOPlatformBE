// Newsletter sending — recipient-driven (Phase 2).
//
// On send we MATERIALISE one CampaignRecipient row per subscriber (idempotent on
// campaign+email), then work the queue: each email reserves a quota slot,
// ROTATING across the tenant's healthy mailboxes. Transient failures are retried
// (up to MAX_ATTEMPTS); a provider rate-limit cools that mailbox down and the
// recipient is retried elsewhere; hard 5xx bounces are terminal. Per-recipient
// status is persisted (so the admin gets a real failure list) and aggregate
// progress is pushed live over Socket.IO after every batch.
//
// When the tenant has no mailbox connected yet we fall back to the shared
// transactional transport (org.email / platform) — still recipient-driven, just
// without rotation/quota.
//
// Every email carries a one-click unsubscribe (link + List-Unsubscribe headers)
// and a plain-text part for better inbox placement.
const crypto = require("crypto");
const NewsletterSubscription = require("../models/newsletter");
const CampaignRecipient = require("../models/CampaignRecipient");
const Mailbox = require("../models/Mailbox");
const mailboxSvc = require("./mailbox.service");
const { sendEmail } = require("./emailUtil");
const { emitToOrg } = require("./socket");

const BATCH_SIZE = 20; // emails per batch
const BATCH_DELAY_MS = 1500; // pause between batches
const MAX_ATTEMPTS = 3; // per-recipient retry cap (transient failures)

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

// Drop obviously undeliverable addresses (placeholder/seed data, bad domains)
// before sending — a high bounce rate is one of the strongest spam signals.
const BAD_DOMAINS = new Set([
  "example.com", "example.org", "example.net", "example.invalid",
  "invalid.local", "test.local", "localhost", "none.com", "noemail.com", "email.com",
]);
function isNonDeliverable(email) {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return true;
  const domain = email.split("@")[1].toLowerCase();
  if (BAD_DOMAINS.has(domain)) return true;
  return /\.(invalid|local|test|example)$/.test(domain);
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

// Plain-text alternative (multipart text+HTML scores slightly better with filters).
function buildText(bodyHtml, { orgName, originUrl, token }) {
  const unsubUrl = `${originUrl || ""}/unsubscribe?token=${encodeURIComponent(token)}`;
  const body = String(bodyHtml || "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return `${body}\n\n—\nYou're receiving this because you subscribed to ${orgName}'s newsletter.\nUnsubscribe: ${unsubUrl}`;
}

// List-Unsubscribe (+ one-click POST) headers. The machine endpoint points at
// the backend API (PUBLIC_API_URL), falling back to the campaign origin.
function buildHeaders({ apiBase, fromEmail, token, campaignId }) {
  const oneClick = `${apiBase || ""}/api/newsletter/unsubscribe?token=${encodeURIComponent(token)}`;
  const mailto = `mailto:${fromEmail || "unsubscribe@localhost"}?subject=unsubscribe`;
  return {
    "List-Unsubscribe": `<${oneClick}>, <${mailto}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    "X-Campaign-Id": String(campaignId || ""),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortMsg = (err) => String(err?.response || err?.message || "").slice(0, 300);

/**
 * Create a CampaignRecipient per subscriber (idempotent). Non-deliverable
 * addresses are recorded as `skipped` so they show up in the failure list but
 * are never sent. Returns the count of newly materialised rows.
 */
async function materialiseRecipients(campaign, orgId) {
  const subs = await NewsletterSubscription.find(audienceFilter(orgId, campaign.audience));
  const ops = [];
  for (const sub of subs) {
    // Guarantee the subscriber carries the token used in the unsubscribe link —
    // the public unsubscribe endpoint looks the subscriber up BY this token, so a
    // recipient-only token (legacy rows) would make the link 404.
    if (!sub.unsubscribeToken) {
      sub.unsubscribeToken = crypto.randomBytes(24).toString("hex");
      try {
        await sub.save();
      } catch (_) {
        /* non-fatal */
      }
    }
    const bad = isNonDeliverable(sub.email);
    ops.push({
      updateOne: {
        filter: { campaignId: campaign._id, email: sub.email },
        update: {
          $setOnInsert: {
            campaignId: campaign._id,
            organisationId: orgId,
            subscriptionId: sub._id,
            email: sub.email,
            unsubscribeToken: sub.unsubscribeToken,
            status: bad ? "skipped" : "queued",
            failureCode: bad ? "invalid_address" : "",
            failureReason: bad ? "Address looks undeliverable" : "",
          },
        },
        upsert: true,
      },
    });
  }
  for (let i = 0; i < ops.length; i += 1000) {
    const chunk = ops.slice(i, i + 1000);
    if (chunk.length) await CampaignRecipient.bulkWrite(chunk, { ordered: false });
  }
}

/**
 * Send a campaign. Mutates + saves the campaign doc as it progresses and pushes
 * live progress over Socket.IO so the admin watches the counters move.
 */
async function sendCampaign(campaign, organisation) {
  const orgId = organisation?._id || campaign.organisationId || null;
  const orgName = organisation?.name || "our team";
  const apiBase = process.env.PUBLIC_API_URL || campaign.originUrl || "";

  await materialiseRecipients(campaign, orgId);

  const total = await CampaignRecipient.countDocuments({ campaignId: campaign._id });
  // Seed running counters from any already-terminal rows (skipped, or a prior run).
  let sent = await CampaignRecipient.countDocuments({ campaignId: campaign._id, status: "sent" });
  let failed = await CampaignRecipient.countDocuments({
    campaignId: campaign._id,
    status: { $in: ["failed", "bounced", "skipped"] },
  });

  campaign.provider = "smtp";
  campaign.status = "sending";
  campaign.error = "";
  campaign.stats = { recipients: total, sent, failed };
  await campaign.save();

  const emit = () =>
    emitToOrg(orgId, "campaign:progress", {
      campaignId: String(campaign._id),
      status: campaign.status,
      stats: campaign.stats,
    });
  emit();

  const messageFor = (r) => ({
    subject: campaign.subject,
    html: buildHtml(campaign.body, { orgName, originUrl: campaign.originUrl, token: r.unsubscribeToken }),
    text: buildText(campaign.body, { orgName, originUrl: campaign.originUrl, token: r.unsubscribeToken }),
  });

  // ── per-recipient outcome writers (keep the running counters in sync) ──
  const markSent = async (r, mailbox) => {
    r.status = "sent";
    r.sentAt = new Date();
    r.mailboxId = mailbox?._id || null;
    r.attempts += 1;
    r.failureCode = "";
    r.failureReason = "";
    await r.save();
    sent += 1;
  };
  const markBounced = async (r, err) => {
    r.status = "bounced";
    r.failureCode = "hard_bounce";
    r.failureReason = shortMsg(err);
    r.attempts += 1;
    await r.save();
    failed += 1;
  };
  // Transient failure: retry next pass, or mark failed once attempts run out.
  const markRetryOrFail = async (r, code, err) => {
    r.attempts += 1;
    if (r.attempts >= MAX_ATTEMPTS) {
      r.status = "failed";
      r.failureCode = code;
      r.failureReason = shortMsg(err);
      failed += 1;
    }
    await r.save();
  };

  const persistAndEmit = async () => {
    campaign.stats = { recipients: total, sent, failed };
    await campaign.save();
    emit();
  };

  // ── Mailbox path: rotate across healthy mailboxes with quota + cooldown ──
  async function sendViaMailboxes() {
    let quotaExhausted = false;
    // Keep working the queue until it's drained or quota runs out.
    while (true) {
      const batch = await CampaignRecipient.find({ campaignId: campaign._id, status: "queued", attempts: { $lt: MAX_ATTEMPTS } })
        .sort({ attempts: 1, createdAt: 1 })
        .limit(BATCH_SIZE);
      if (!batch.length) break;

      const jobs = [];
      for (const r of batch) {
        const mailbox = await mailboxSvc.reserveQuota(orgId);
        if (!mailbox) break; // every mailbox is exhausted/cooling down right now
        jobs.push({ r, mailbox });
      }
      if (!jobs.length) {
        quotaExhausted = true;
        break;
      }

      await Promise.all(
        jobs.map(async ({ r, mailbox }) => {
          const msg = messageFor(r);
          const send = (mb) =>
            mailboxSvc.sendViaMailbox(mb, {
              to: r.email,
              subject: msg.subject,
              html: msg.html,
              text: msg.text,
              headers: buildHeaders({ apiBase, fromEmail: mailboxSvc.fromIdentity(mb).fromEmail, token: r.unsubscribeToken, campaignId: campaign._id }),
            });
          try {
            await send(mailbox);
            await markSent(r, mailbox);
          } catch (err) {
            const kind = mailboxSvc.classifySmtpError(err);
            if (kind === "rate_limit") {
              await mailboxSvc.releaseQuota(mailbox._id);
              await mailboxSvc.setCooldown(mailbox, err.message);
              const alt = await mailboxSvc.reserveQuota(orgId);
              if (alt) {
                try {
                  await send(alt);
                  await markSent(r, alt);
                } catch (err2) {
                  if (mailboxSvc.classifySmtpError(err2) === "rate_limit") {
                    await mailboxSvc.releaseQuota(alt._id);
                    await mailboxSvc.setCooldown(alt, err2.message);
                  }
                  await markRetryOrFail(r, mailboxSvc.classifySmtpError(err2), err2);
                }
              } else {
                await markRetryOrFail(r, "rate_limit", err); // retry later / fail at cap
              }
            } else if (kind === "auth") {
              await mailboxSvc.markUnhealthy(mailbox, err.message);
              await markRetryOrFail(r, "auth", err);
            } else if (kind === "hard_bounce") {
              await markBounced(r, err);
            } else {
              await markRetryOrFail(r, kind, err);
            }
          }
        })
      );

      await persistAndEmit();
      await sleep(BATCH_DELAY_MS);
    }

    // Anything still queued = the whole fleet was out of quota → terminal for now.
    if (quotaExhausted) {
      const leftover = await CampaignRecipient.find({ campaignId: campaign._id, status: "queued" });
      for (const r of leftover) {
        r.status = "failed";
        r.failureCode = "quota_exhausted";
        r.failureReason = "All mailboxes hit their sending quota";
        await r.save();
        failed += 1;
      }
      if (leftover.length) {
        campaign.error = `Sending stopped: all mailboxes hit their daily/hourly quota (${leftover.length} not sent). Connect more mailboxes or raise their limits.`;
      }
    }
  }

  // ── Fallback path: shared transactional transport (no quota/rotation) ──
  async function sendViaFallback() {
    const replyTo = organisation?.contactEmail || undefined;
    const fromEmail = organisation?.email?.fromEmail || organisation?.contactEmail || "";
    while (true) {
      const batch = await CampaignRecipient.find({ campaignId: campaign._id, status: "queued", attempts: { $lt: MAX_ATTEMPTS } })
        .sort({ attempts: 1, createdAt: 1 })
        .limit(BATCH_SIZE);
      if (!batch.length) break;

      await Promise.all(
        batch.map(async (r) => {
          const msg = messageFor(r);
          try {
            const res = await sendEmail(r.email, msg.html, msg.subject, [], {
              org: organisation,
              fromName: orgName,
              replyTo,
              text: msg.text,
              headers: buildHeaders({ apiBase, fromEmail, token: r.unsubscribeToken, campaignId: campaign._id }),
            });
            if (res?.success) await markSent(r, null);
            else await markRetryOrFail(r, "unknown", new Error(res?.message || "Send failed"));
          } catch (err) {
            await markRetryOrFail(r, "unknown", err);
          }
        })
      );

      await persistAndEmit();
      await sleep(BATCH_DELAY_MS);
    }
  }

  const hasMailboxes = orgId ? (await Mailbox.countDocuments({ organisationId: orgId, isActive: true })) > 0 : false;
  if (hasMailboxes) await sendViaMailboxes();
  else await sendViaFallback();

  // "failed" only when nothing went out at all; a partial send still counts as
  // "sent" with the shortfall explained in `error`.
  campaign.status = sent > 0 || total === 0 ? "sent" : "failed";
  campaign.sentAt = new Date();
  campaign.stats = { recipients: total, sent, failed };
  await campaign.save();
  emit();
  return campaign;
}

module.exports = { sendCampaign, countAudience, audienceFilter, buildHtml, isNonDeliverable, materialiseRecipients };
