// Per-tenant Mailchimp Marketing API client. Each organisation connects its OWN
// Mailchimp account (API key + audience), stored AES-256-GCM encrypted on the
// org. We sync subscribers into the tenant's audience and create + send regular
// campaigns through Mailchimp so delivery, unsubscribe handling and reputation
// are managed by Mailchimp.
const axios = require("axios");
const crypto = require("crypto");
const { decrypt } = require("../utils/crypto");

// API keys look like "xxxxxxxxxxxx-us21" — the datacenter is the suffix.
function prefixFromKey(apiKey) {
  const i = String(apiKey || "").lastIndexOf("-");
  return i >= 0 ? String(apiKey).slice(i + 1) : "";
}

function client(apiKey, serverPrefix) {
  const dc = serverPrefix || prefixFromKey(apiKey);
  if (!dc) throw new Error("Invalid Mailchimp API key (missing datacenter suffix)");
  return axios.create({
    baseURL: `https://${dc}.api.mailchimp.com/3.0`,
    auth: { username: "anystring", password: apiKey },
    headers: { "Content-Type": "application/json" },
    timeout: 20000,
  });
}

function orgClient(org) {
  const apiKey = decrypt(org?.mailchimp?.apiKeyEnc);
  if (!apiKey) throw new Error("Mailchimp is not connected");
  return client(apiKey, org.mailchimp?.serverPrefix);
}

// Validate a key and return the account label.
async function verify(apiKey, serverPrefix) {
  const c = client(apiKey, serverPrefix);
  const res = await c.get("/", { params: { fields: "account_name,email" } });
  return { accountLabel: res.data.account_name || res.data.email || "Mailchimp", email: res.data.email || "" };
}

async function listAudiences(apiKey, serverPrefix) {
  const c = client(apiKey, serverPrefix);
  const res = await c.get("/lists", {
    params: { count: 100, fields: "lists.id,lists.name,lists.stats.member_count" },
  });
  return (res.data.lists || []).map((l) => ({
    id: l.id,
    name: l.name,
    memberCount: l.stats?.member_count ?? 0,
  }));
}

// Upsert our active subscribers into the tenant's audience. We only ever set
// status_if_new=subscribed, so existing members keep whatever status they have
// in Mailchimp (we never force-resubscribe anyone).
async function syncSubscribers(org, subscribers) {
  const c = orgClient(org);
  const listId = org.mailchimp?.audienceId;
  if (!listId) throw new Error("No Mailchimp audience selected");

  let created = 0;
  let updated = 0;
  let errors = 0;
  const CHUNK = 500;
  for (let i = 0; i < subscribers.length; i += CHUNK) {
    const members = subscribers
      .slice(i, i + CHUNK)
      .map((s) => ({ email_address: s.email, status_if_new: "subscribed" }));
    const res = await c.post(`/lists/${listId}`, { members, update_existing: true });
    created += res.data.total_created || 0;
    updated += res.data.total_updated || 0;
    errors += res.data.error_count || 0;
  }
  return { created, updated, errors, total: subscribers.length };
}

// Mailchimp requires an unsubscribe link + the audience's physical address in
// campaign content; *|UNSUB|* and *|LIST:ADDRESS|* are replaced at send time.
function buildHtml(bodyHtml, orgName) {
  return `
  <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6;max-width:640px;margin:0 auto">
    ${bodyHtml}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
    <p style="color:#999;font-size:12px">
      You're receiving this because you subscribed to ${orgName}'s newsletter.<br/>
      <a href="*|UNSUB|*" style="color:#999;text-decoration:underline">Unsubscribe</a> &middot; *|LIST:ADDRESS|*
    </p>
  </div>`;
}

// Create a regular campaign to the whole audience, set its content, and send.
async function sendCampaign(org, { subject, fromName, replyTo, html }) {
  const c = orgClient(org);
  const listId = org.mailchimp?.audienceId;
  if (!listId) throw new Error("No Mailchimp audience selected");
  if (!replyTo) throw new Error("A from/reply-to email is required (set it in Delivery settings)");

  const create = await c.post("/campaigns", {
    type: "regular",
    recipients: { list_id: listId },
    settings: {
      subject_line: subject,
      title: subject,
      from_name: fromName,
      reply_to: replyTo,
      auto_footer: false,
    },
  });
  const campaignId = create.data.id;
  const recipients = create.data.recipients?.recipient_count ?? 0;

  await c.put(`/campaigns/${campaignId}/content`, { html });
  await c.post(`/campaigns/${campaignId}/actions/send`);

  return { mailchimpCampaignId: campaignId, recipients };
}

const subHash = (email) => crypto.createHash("md5").update(String(email || "").toLowerCase()).digest("hex");

// Push a single member's state into the audience (real-time, our → Mailchimp).
async function pushMember(org, email, status) {
  const c = orgClient(org);
  const listId = org.mailchimp?.audienceId;
  if (!listId || !email) return;
  const hash = subHash(email);
  if (status === "unsubscribed") {
    await c.put(`/lists/${listId}/members/${hash}`, {
      email_address: email,
      status: "unsubscribed",
      status_if_new: "unsubscribed",
    });
  } else {
    // Create-as-subscribed only; never force-resubscribe an existing member
    // (Mailchimp forbids that via the API for compliance).
    await c.put(`/lists/${listId}/members/${hash}`, { email_address: email, status_if_new: "subscribed" });
  }
}

async function archiveMember(org, email) {
  const c = orgClient(org);
  const listId = org.mailchimp?.audienceId;
  if (!listId || !email) return;
  await c.delete(`/lists/${listId}/members/${subHash(email)}`);
}

// Fire-and-forget wrapper: no-ops unless connected, and never throws — used in
// subscriber lifecycle endpoints so a Mailchimp hiccup can't break our flow.
async function syncMemberSafe(org, email, status) {
  try {
    if (!org?.mailchimp?.connected || !org.mailchimp.audienceId || !org.mailchimp.apiKeyEnc) return;
    if (status === "deleted") await archiveMember(org, email);
    else await pushMember(org, email, status);
  } catch (e) {
    console.error("Mailchimp member sync failed:", e?.response?.data?.detail || e.message);
  }
}

function webhookUrl(orgId, secret) {
  const base = (process.env.PUBLIC_API_URL || "").replace(/\/$/, "");
  if (!base || !secret) return "";
  return `${base}/api/newsletter/mailchimp-webhook?org=${orgId}&secret=${encodeURIComponent(secret)}`;
}

// Create the audience webhook if one for this URL doesn't already exist. Events
// come only from user/admin actions (NOT api), so our own API pushes don't echo
// back as webhooks → no infinite sync loop.
async function ensureWebhook(org, url) {
  const c = orgClient(org);
  const listId = org.mailchimp?.audienceId;
  if (!listId || !url) return "";
  try {
    const existing = await c.get(`/lists/${listId}/webhooks`);
    const base = url.split("?")[0];
    const match = (existing.data.webhooks || []).find((w) => (w.url || "").split("?")[0] === base);
    if (match) return match.id;
  } catch (_) {
    /* fall through to create */
  }
  const res = await c.post(`/lists/${listId}/webhooks`, {
    url,
    events: { subscribe: true, unsubscribe: true, cleaned: true, upemail: true, profile: false, campaign: false },
    sources: { user: true, admin: true, api: false },
  });
  return res.data.id;
}

module.exports = {
  verify,
  listAudiences,
  syncSubscribers,
  sendCampaign,
  buildHtml,
  prefixFromKey,
  pushMember,
  archiveMember,
  syncMemberSafe,
  webhookUrl,
  ensureWebhook,
};
