// Dispatches scheduled newsletter campaigns once their send time arrives.
const cron = require("node-cron");
const NewsletterCampaign = require("../models/newsletterCampaign");
const Organisation = require("../models/organisation");
const { sendCampaign } = require("../services/newsletterSender");

function setupCampaignScheduler() {
  // Every minute, pick up any campaign whose scheduled time has passed.
  cron.schedule("* * * * *", async () => {
    try {
      const due = await NewsletterCampaign.find({
        status: "scheduled",
        scheduledAt: { $ne: null, $lte: new Date() },
      });
      if (!due.length) return;
      console.log(`[campaigns] dispatching ${due.length} scheduled campaign(s)`);
      for (const campaign of due) {
        // Claim it first so an overlapping tick can't double-send.
        campaign.status = "sending";
        await campaign.save();
        try {
          const org = campaign.organisationId ? await Organisation.findById(campaign.organisationId) : null;
          await sendCampaign(campaign, org);
        } catch (err) {
          console.error(`[campaigns] failed to send ${campaign._id}:`, err);
          try {
            campaign.status = "failed";
            campaign.error = err?.response?.data?.detail || err?.message || "Send failed";
            await campaign.save();
          } catch (_) {
            /* ignore */
          }
        }
      }
    } catch (err) {
      console.error("[campaigns] scheduler error:", err);
    }
  });

  console.log(`[${new Date().toISOString()}] Newsletter campaign scheduler initialized`);
}

module.exports = { setupCampaignScheduler };
