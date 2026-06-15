const GoFundMe = require("../models/goFundMe");
const GoFundMeDonation = require("../models/goFundMeDonations");
const User = require("../models/user");
const mongoose = require("mongoose");
const { deleteS3Object } = require("../config/s3");
const { sendEmail } = require("../services/emailUtil");
const { getTenantStripe } = require("../services/tenantStripe");
const { getPaypalClient } = require("../services/tenantPaypal");

/* ── helpers ─────────────────────────────────────────────────────────── */

const orgId = (req) => req.organisation?._id || null;
const displayCategory = (category, custom) => (category === "other" && custom ? custom : category);

// The fixed set of categories. Anything outside this list is a free-text
// "custom" category, which is stored as category "other" + customCategory.
const PREDEFINED_CATEGORIES = ["education", "water", "food", "emergency relief", "medical", "community", "personal", "other"];

// Escape user/category input before using it in a RegExp.
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Anchored, case-insensitive exact match — so a filter value like "education"
// matches stored values regardless of case ("Education", "EDUCATION", …).
const ciExact = (s) => new RegExp(`^${escapeRegExp(s)}$`, "i");

// Some categories are stored under different wordings across seed/older data.
// Filtering by the canonical value also matches its synonyms (e.g. seed data
// uses "Emergency" while the filter value is "emergency relief").
const CATEGORY_SYNONYMS = {
  "emergency relief": ["emergency relief", "emergency", "emergencies"],
};

const money = (n) => `$${Number(n || 0).toFixed(2)} AUD`;

// Tenant-branded email shell (no hardcoded foundation branding).
function shell(orgName, inner) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
      ${inner}
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
      <p style="font-size:12px;color:#888">Sent by ${orgName}.</p>
    </div>`;
}
function emailOpts(org) {
  return { org, fromName: org?.name, replyTo: org?.contactEmail || undefined };
}

// Notify the tenant's admins that a new request needs review.
async function notifyAdmins(campaign, org) {
  try {
    const admins = await User.find({
      organisationId: org?._id,
      role: { $in: ["admin", "superadmin"] },
    }).select("email");
    const emails = [...new Set(admins.map((a) => a.email).filter(Boolean))];
    if (!emails.length) return;

    const requester = await User.findById(campaign.userId).select("name email");
    const html = shell(
      org?.name || "your organisation",
      `<h2 style="color:#4a7c59">New fundraiser request</h2>
       <p>A supporter submitted a fundraiser that needs review.</p>
       <div style="background:#f9f9f9;padding:15px;border-radius:6px;margin:16px 0">
         <p><strong>Title:</strong> ${campaign.title}</p>
         <p><strong>Category:</strong> ${displayCategory(campaign.category, campaign.customCategory)}</p>
         <p><strong>Target:</strong> ${money(campaign.targetAmount)}</p>
         <p><strong>Urgency:</strong> ${campaign.urgencyLevel}</p>
         <p><strong>By:</strong> ${requester?.name || "Unknown"} (${requester?.email || "—"})</p>
       </div>
       <p>Review it in the admin panel to approve or reject.</p>`
    );
    await Promise.allSettled(
      emails.map((e) => sendEmail(e, html, `New fundraiser request — ${org?.name || ""}`, [], emailOpts(org)))
    );
  } catch (err) {
    console.error("notifyAdmins error:", err.message);
  }
}

// Notify the requester of an approve/reject decision.
async function notifyRequester(campaign, org, status, adminNotes) {
  try {
    const user = await User.findById(campaign.userId).select("name email");
    if (!user?.email) return;
    const approved = status === "approved";
    const base = req_origin_fallback(org);
    const html = shell(
      org?.name || "your organisation",
      `<h2 style="color:${approved ? "#4a7c59" : "#d32f2f"}">Fundraiser ${approved ? "approved" : "rejected"}</h2>
       <p>Dear ${user.name || "supporter"},</p>
       <p>Your fundraiser "<strong>${campaign.title}</strong>" has been <strong>${status}</strong>.</p>
       ${adminNotes ? `<div style="background:#f9f9f9;padding:15px;border-radius:6px;margin:16px 0"><strong>Notes:</strong><p>${adminNotes}</p></div>` : ""}
       ${approved
         ? `<p>It's now live and can receive donations:</p><p><a href="${base}/p2p-campaigns/${campaign.slug}" style="background:#4a7c59;color:#fff;padding:10px 18px;text-decoration:none;border-radius:6px">View your fundraiser</a></p>`
         : `<p>If you have questions about this decision, please get in touch.</p>`}`
    );
    await sendEmail(user.email, html, `Fundraiser ${status} — ${org?.name || ""}`, [], emailOpts(org));
  } catch (err) {
    console.error("notifyRequester error:", err.message);
  }
}

// Best-effort public site base for links in emails.
function req_origin_fallback(org) {
  return org?.website || process.env.FRONTEND_URL || "http://localhost:5173";
}

/* ── public: list / detail / categories ──────────────────────────────── */

exports.getPublicGoFundMes = async (req, res) => {
  try {
    const oid = orgId(req);
    if (!oid) return res.status(400).json({ success: false, message: "Organisation context required" });

    const { category, urgency, sort = "recent", page = 1, limit = 12 } = req.query;
    const query = { organisationId: oid, status: "approved", isActive: true };
    if (category && category !== "all") {
      // Match case-insensitively so the lowercase filter values line up with
      // stored categories regardless of case (e.g. seeded "Education"), and
      // accept known synonyms (e.g. "Emergency" ↔ "Emergency Relief").
      const cat = category.toLowerCase();
      if (PREDEFINED_CATEGORIES.includes(cat)) {
        const variants = CATEGORY_SYNONYMS[cat] || [category];
        query.category = { $in: variants.map(ciExact) };
      } else {
        // A custom-category pill sends its free-text label — those campaigns are
        // stored as category "other" with that customCategory, so match there.
        query.category = ciExact("other");
        query.customCategory = ciExact(category);
      }
    }
    if (urgency && urgency !== "all") query.urgencyLevel = urgency;

    let sortOption = { approvedAt: -1 };
    if (sort === "urgent") sortOption = { urgencyLevel: -1, approvedAt: -1 };
    else if (sort === "amount") sortOption = { targetAmount: -1 };
    else if (sort === "progress") sortOption = { currentAmount: -1 };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const goFundMes = await GoFundMe.find(query)
      .populate("userId", "name")
      .sort(sortOption)
      .skip(skip)
      .limit(parseInt(limit));
    const total = await GoFundMe.countDocuments(query);

    res.json({
      success: true,
      goFundMes,
      pagination: { current: parseInt(page), pages: Math.ceil(total / parseInt(limit)), total },
    });
  } catch (error) {
    console.error("getPublicGoFundMes error:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

exports.getGoFundMeBySlug = async (req, res) => {
  try {
    const oid = orgId(req);
    if (!oid) return res.status(400).json({ success: false, message: "Organisation context required" });

    const goFundMe = await GoFundMe.findOne({
      organisationId: oid,
      slug: req.params.slug,
      status: "approved",
      isActive: true,
    }).populate("userId", "name");
    if (!goFundMe) return res.status(404).json({ success: false, message: "Campaign not found" });

    const recentDonations = await GoFundMeDonation.find({
      organisationId: oid,
      goFundMeId: goFundMe._id,
      paymentStatus: "completed",
      isAnonymous: false,
    })
      .sort({ createdAt: -1 })
      .limit(10)
      .select("donorName amount message createdAt");

    res.json({ success: true, goFundMe, recentDonations });
  } catch (error) {
    console.error("getGoFundMeBySlug error:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

exports.getAvailableCategories = async (req, res) => {
  try {
    const oid = orgId(req);
    const predefined = PREDEFINED_CATEGORIES;
    const custom = await GoFundMe.distinct("customCategory", {
      organisationId: oid,
      category: ciExact("other"),
      customCategory: { $exists: true, $ne: "" },
    });
    res.json({ success: true, categories: { predefined, custom } });
  } catch (error) {
    console.error("getAvailableCategories error:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

/* ── user: create / my requests / my donations ───────────────────────── */

exports.createGoFundMe = async (req, res) => {
  try {
    const oid = orgId(req);
    if (!oid) return res.status(400).json({ success: false, message: "Organisation context required" });

    const {
      title, description, personalStory, financialSituation, reasonForFunding,
      targetAmount, category, customCategory, otherCategory, urgencyLevel,
    } = req.body;
    const normalizedCustom = (customCategory || otherCategory || "").trim();

    if (!title || !description || !personalStory || !financialSituation || !reasonForFunding || !targetAmount || !category) {
      return res.status(400).json({ success: false, message: "Please provide all required fields" });
    }
    if (category === "other" && !normalizedCustom) {
      return res.status(400).json({ success: false, message: "Custom category is required when 'other' is selected" });
    }

    // One active request per user per org (checked before the upload).
    const existing = await GoFundMe.findOne({
      organisationId: oid,
      userId: req.user.id,
      status: { $in: ["pending", "approved"] },
    });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: "You already have an active fundraiser. Please wait for approval or completion.",
      });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: "Image is required" });
    }

    const goFundMe = new GoFundMe({
      organisationId: oid,
      userId: req.user.id,
      title, description, personalStory, financialSituation, reasonForFunding,
      targetAmount: parseFloat(targetAmount),
      category,
      customCategory: category === "other" ? normalizedCustom : undefined,
      urgencyLevel: urgencyLevel || "medium",
      image: req.file.location,
      imagePath: req.file.key,
    });

    const saved = await goFundMe.save();
    await saved.populate("userId", "name email");
    notifyAdmins(saved, req.organisation);

    res.status(201).json({
      success: true,
      message: "Fundraiser submitted successfully. It will be reviewed by our team.",
      goFundMe: saved,
    });
  } catch (error) {
    console.error("createGoFundMe error:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

exports.getMyGoFundMeRequests = async (req, res) => {
  try {
    const goFundMes = await GoFundMe.find({ organisationId: orgId(req), userId: req.user.id })
      .populate("userId", "name email")
      .populate("approvedBy", "name")
      .sort({ createdAt: -1 });
    res.json({ success: true, goFundMes });
  } catch (error) {
    console.error("getMyGoFundMeRequests error:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

exports.getMyP2PDonations = async (req, res) => {
  try {
    const oid = orgId(req);
    const { page = 1, limit = 10, status = "all" } = req.query;
    const query = { organisationId: oid, donorEmail: req.user.email };
    if (status !== "all") query.paymentStatus = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const donations = await GoFundMeDonation.find(query)
      .populate({ path: "goFundMeId", select: "title slug category status currentAmount targetAmount image" })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select("donorName amount message isAnonymous paymentStatus paymentMethod transactionFee netAmount stripePaymentIntentId stripeReceiptUrl createdAt");
    const total = await GoFundMeDonation.countDocuments(query);

    const summary = await GoFundMeDonation.aggregate([
      { $match: { organisationId: new mongoose.Types.ObjectId(oid), donorEmail: req.user.email, paymentStatus: "completed" } },
      { $group: { _id: null, totalDonations: { $sum: 1 }, totalAmount: { $sum: "$amount" }, totalNetAmount: { $sum: "$netAmount" }, totalFees: { $sum: "$transactionFee" } } },
    ]);

    res.json({
      success: true,
      donations,
      summary: summary[0] || { totalDonations: 0, totalAmount: 0, totalNetAmount: 0, totalFees: 0 },
      pagination: { current: parseInt(page), pages: Math.ceil(total / parseInt(limit)), total },
    });
  } catch (error) {
    console.error("getMyP2PDonations error:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

/* ── payments: Stripe ─────────────────────────────────────────────────── */

exports.createDonationPaymentIntent = async (req, res) => {
  try {
    const oid = orgId(req);
    const { amount, donorName, donorEmail, message, isAnonymous } = req.body;
    if (!amount || !donorName || !donorEmail) {
      return res.status(400).json({ success: false, message: "Amount, donor name and email are required" });
    }

    const goFundMe = await GoFundMe.findOne({ _id: req.params.id, organisationId: oid });
    if (!goFundMe || goFundMe.status !== "approved" || !goFundMe.isActive) {
      return res.status(404).json({ success: false, message: "Campaign not found or not active" });
    }
    if (goFundMe.currentAmount >= goFundMe.targetAmount) {
      return res.status(400).json({ success: false, message: "This campaign has already reached its target" });
    }

    const donationAmount = parseFloat(amount);
    if (donationAmount < 1) return res.status(400).json({ success: false, message: "Minimum donation is $1" });

    const stripeAmount = Math.round(donationAmount * 100);
    const stripeFee = Math.round(stripeAmount * 0.029 + 30);
    const netAmount = donationAmount - stripeFee / 100;

    const stripe = getTenantStripe(req.organisation);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: stripeAmount,
      currency: "aud",
      automatic_payment_methods: { enabled: true },
      metadata: {
        goFundMeId: String(goFundMe._id),
        organisationId: String(oid),
        donorName, donorEmail, message: message || "",
        isAnonymous: isAnonymous ? "true" : "false",
        netAmount: netAmount.toString(),
        userId: req.user?._id ? String(req.user._id) : "",
        paymentType: "gofundme_donation",
      },
    });

    res.json({ success: true, clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
  } catch (error) {
    console.error("createDonationPaymentIntent error:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

exports.processDonation = async (req, res) => {
  try {
    const oid = orgId(req);
    const { paymentIntentId } = req.body;
    if (!paymentIntentId) return res.status(400).json({ success: false, message: "Payment intent ID is required" });

    const stripe = getTenantStripe(req.organisation);
    // Expand the charge so we can capture Stripe's hosted receipt URL.
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
    if (paymentIntent.status !== "succeeded") {
      return res.status(400).json({ success: false, message: "Payment not completed" });
    }
    // Guard against cross-tenant replay.
    if (paymentIntent.metadata?.organisationId && String(paymentIntent.metadata.organisationId) !== String(oid)) {
      return res.status(400).json({ success: false, message: "Payment does not belong to this organisation" });
    }

    const receiptUrl =
      (paymentIntent.latest_charge && typeof paymentIntent.latest_charge === "object"
        ? paymentIntent.latest_charge.receipt_url
        : null) || "";

    const existing = await GoFundMeDonation.findOne({ stripePaymentIntentId: paymentIntentId });
    if (existing) {
      // Backfill the receipt URL if an earlier process didn't capture it.
      if (receiptUrl && !existing.stripeReceiptUrl) {
        existing.stripeReceiptUrl = receiptUrl;
        await existing.save();
      }
      return res.json({ success: true, message: "Donation already processed", donation: existing, alreadyProcessed: true });
    }

    const { goFundMeId, donorName, donorEmail, message, isAnonymous, netAmount, userId } = paymentIntent.metadata;

    let cardType = "stripe";
    if (paymentIntent.payment_method) {
      try {
        const pm = await stripe.paymentMethods.retrieve(paymentIntent.payment_method);
        if (pm.card?.brand) cardType = pm.card.brand.toLowerCase();
      } catch (e) { /* non-fatal */ }
    }

    const gross = paymentIntent.amount / 100;
    const net = parseFloat(netAmount);
    const donation = await GoFundMeDonation.create({
      organisationId: oid,
      goFundMeId,
      userId: userId || null,
      donorName, donorEmail,
      amount: gross,
      message,
      isAnonymous: isAnonymous === "true",
      stripePaymentIntentId: paymentIntentId,
      paymentStatus: "completed",
      transactionFee: gross - net,
      netAmount: net,
      paymentMethod: cardType,
      stripeReceiptUrl: receiptUrl,
    });

    const campaign = await applyDonationToCampaign(goFundMeId, oid, net);
    sendDonorReceipt(req.organisation, donorEmail, donorName, campaign, gross, cardType);

    res.json({ success: true, message: "Donation completed successfully", donation, campaign: campaignSummary(campaign) });
  } catch (error) {
    console.error("processDonation error:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

/* ── payments: PayPal (create order + capture & record, server-side) ──── */

exports.createPayPalOrder = async (req, res) => {
  try {
    const oid = orgId(req);
    const { amount } = req.body;
    const goFundMe = await GoFundMe.findOne({ _id: req.params.id, organisationId: oid });
    if (!goFundMe || goFundMe.status !== "approved" || !goFundMe.isActive) {
      return res.status(404).json({ success: false, message: "Campaign not found or not active" });
    }
    if (!amount || parseFloat(amount) < 1) return res.status(400).json({ success: false, message: "Invalid amount" });

    const { client } = await getPaypalClient(req.organisation);
    const response = await client.post("/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "AUD", value: parseFloat(amount).toFixed(2) }, custom_id: String(goFundMe._id) }],
    });
    res.json({ success: true, id: response.data.id });
  } catch (error) {
    console.error("createPayPalOrder error:", error.response?.data || error.message);
    res.status(500).json({ success: false, message: "Failed to create PayPal order" });
  }
};

exports.capturePayPalDonation = async (req, res) => {
  try {
    const oid = orgId(req);
    const { orderID, donorName, donorEmail, message, isAnonymous } = req.body;
    if (!orderID || !donorName || !donorEmail) {
      return res.status(400).json({ success: false, message: "Order ID, donor name and email are required" });
    }

    const goFundMe = await GoFundMe.findOne({ _id: req.params.id, organisationId: oid });
    if (!goFundMe) return res.status(404).json({ success: false, message: "Campaign not found" });

    // Idempotency — the PayPal order id is stored in stripePaymentIntentId.
    const existing = await GoFundMeDonation.findOne({ stripePaymentIntentId: orderID });
    if (existing) {
      return res.json({ success: true, message: "Donation already processed", donation: existing, alreadyProcessed: true, campaign: campaignSummary(goFundMe) });
    }

    const { client } = await getPaypalClient(req.organisation);
    const capture = await client.post(`/v2/checkout/orders/${orderID}/capture`, {});
    const status = capture.data?.status;
    const cap = capture.data?.purchase_units?.[0]?.payments?.captures?.[0];
    if (status !== "COMPLETED" || !cap) {
      return res.status(400).json({ success: false, message: "PayPal payment not completed" });
    }

    const gross = parseFloat(cap.amount?.value || "0");
    const paypalFee = Math.round((gross * 0.029 + 0.3) * 100) / 100;
    const net = gross - paypalFee;

    const donation = await GoFundMeDonation.create({
      organisationId: oid,
      goFundMeId: goFundMe._id,
      userId: req.user?._id || null,
      donorName, donorEmail,
      amount: gross,
      message: message || "",
      isAnonymous: !!isAnonymous,
      stripePaymentIntentId: orderID, // PayPal order id
      paymentStatus: "completed",
      transactionFee: paypalFee,
      netAmount: net,
      paymentMethod: "paypal",
    });

    const campaign = await applyDonationToCampaign(goFundMe._id, oid, net);
    sendDonorReceipt(req.organisation, donorEmail, donorName, campaign, gross, "paypal");

    res.json({ success: true, message: "PayPal donation completed", donation, campaign: campaignSummary(campaign) });
  } catch (error) {
    console.error("capturePayPalDonation error:", error.response?.data || error.message);
    res.status(500).json({ success: false, message: "Failed to capture PayPal payment" });
  }
};

/* ── shared donation side-effects ────────────────────────────────────── */

async function applyDonationToCampaign(goFundMeId, oid, net) {
  const campaign = await GoFundMe.findOne({ _id: goFundMeId, organisationId: oid });
  if (!campaign) return null;
  campaign.currentAmount += net;
  campaign.donationCount += 1;
  if (campaign.currentAmount >= campaign.targetAmount) {
    campaign.status = "completed";
    campaign.completedAt = new Date();
    campaign.isActive = false;
  }
  await campaign.save();
  return campaign;
}

function campaignSummary(c) {
  if (!c) return null;
  return {
    title: c.title, slug: c.slug,
    currentAmount: c.currentAmount, targetAmount: c.targetAmount,
    donationCount: c.donationCount, isCompleted: c.status === "completed",
  };
}

function sendDonorReceipt(org, donorEmail, donorName, campaign, gross, method) {
  try {
    const html = shell(
      org?.name || "your organisation",
      `<h2 style="color:#4a7c59">Thank you for your donation!</h2>
       <p>Dear ${donorName || "Donor"},</p>
       <p>We've received your donation to <strong>${campaign?.title || "a fundraiser"}</strong>.</p>
       <div style="background:#f9f9f9;padding:15px;border-radius:6px;margin:16px 0">
         <p><strong>Amount:</strong> ${money(gross)}</p>
         <p><strong>Method:</strong> ${method}</p>
         <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
       </div>
       <p>Your support makes a real difference. Thank you!</p>`
    );
    return sendEmail(donorEmail, html, `Thank you for your donation — ${org?.name || ""}`, [], emailOpts(org));
  } catch (e) {
    console.error("sendDonorReceipt error:", e.message);
  }
}

/* ── admin: requests / donors / analytics / review / stats ───────────── */

exports.getAdminGoFundMeRequests = async (req, res) => {
  try {
    const oid = orgId(req);
    const { status = "all", page = 1, limit = 10, search = "" } = req.query;
    const query = { organisationId: oid };
    if (status !== "all") query.status = status;
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
        { customCategory: { $regex: search, $options: "i" } },
      ];
    }
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const goFundMes = await GoFundMe.find(query)
      .populate("userId", "name email")
      .populate("approvedBy", "name")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    const total = await GoFundMe.countDocuments(query);
    res.json({ success: true, goFundMes, pagination: { current: parseInt(page), pages: Math.ceil(total / parseInt(limit)), total } });
  } catch (error) {
    console.error("getAdminGoFundMeRequests error:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

exports.getCampaignDonors = async (req, res) => {
  try {
    const oid = orgId(req);
    const { page = 1, limit = 10 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const filter = { organisationId: oid, goFundMeId: req.params.id, paymentStatus: "completed" };
    const donations = await GoFundMeDonation.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select("donorName donorEmail amount message isAnonymous paymentMethod createdAt transactionFee netAmount");
    const total = await GoFundMeDonation.countDocuments(filter);
    const campaign = await GoFundMe.findOne({ _id: req.params.id, organisationId: oid }).select("title");
    res.json({ success: true, donors: donations, campaign, pagination: { current: parseInt(page), pages: Math.ceil(total / parseInt(limit)), total } });
  } catch (error) {
    console.error("getCampaignDonors error:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

// GET /gofundme/admin/payments — cross-campaign donations list (the admin
// "Campaign Payments" dashboard). Org-scoped; supports search by donor,
// status/campaign/date filters, sorting, pagination + summary stats.
exports.getAdminPayments = async (req, res) => {
  try {
    const oid = orgId(req);
    if (!oid) return res.status(400).json({ success: false, message: "Organisation context required" });

    const {
      page = 1,
      limit = 10,
      search = "",
      paymentStatus,
      campaignId,
      startDate,
      endDate,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const filter = { organisationId: oid };
    if (paymentStatus && paymentStatus !== "all") filter.paymentStatus = paymentStatus;
    if (campaignId && campaignId !== "all" && mongoose.Types.ObjectId.isValid(campaignId)) {
      filter.goFundMeId = new mongoose.Types.ObjectId(campaignId);
    }
    if (search) {
      filter.$or = [
        { donorName: { $regex: search, $options: "i" } },
        { donorEmail: { $regex: search, $options: "i" } },
      ];
    }
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const perPage = Math.max(1, Math.min(1000, parseInt(limit, 10) || 10));
    const sortDir = sortOrder === "asc" ? 1 : -1;
    const allowedSort = ["createdAt", "amount", "donorName", "paymentStatus"];
    const sortField = allowedSort.includes(sortBy) ? sortBy : "createdAt";

    const [rows, total, statsAgg] = await Promise.all([
      GoFundMeDonation.find(filter)
        .populate("goFundMeId", "title slug")
        .sort({ [sortField]: sortDir })
        .skip((pageNum - 1) * perPage)
        .limit(perPage)
        .lean(),
      GoFundMeDonation.countDocuments(filter),
      GoFundMeDonation.aggregate([
        { $match: filter },
        { $group: { _id: "$paymentStatus", count: { $sum: 1 }, amount: { $sum: "$amount" }, net: { $sum: "$netAmount" } } },
      ]),
    ]);

    const stats = { completedCount: 0, pendingCount: 0, failedCount: 0, refundedCount: 0, totalCollected: 0, totalNet: 0, currency: "AUD" };
    statsAgg.forEach((g) => {
      if (g._id === "completed") {
        stats.completedCount = g.count;
        stats.totalCollected = g.amount || 0;
        stats.totalNet = g.net || 0;
      } else if (g._id === "pending") stats.pendingCount = g.count;
      else if (g._id === "failed") stats.failedCount = g.count;
      else if (g._id === "refunded") stats.refundedCount = g.count;
    });

    const payments = rows.map((p) => ({
      _id: p._id,
      donorName: p.donorName,
      donorEmail: p.donorEmail,
      isAnonymous: p.isAnonymous,
      amount: p.amount,
      netAmount: p.netAmount,
      transactionFee: p.transactionFee,
      message: p.message,
      paymentStatus: p.paymentStatus,
      paymentMethod: p.paymentMethod,
      stripePaymentIntentId: p.stripePaymentIntentId,
      stripeReceiptUrl: p.stripeReceiptUrl,
      createdAt: p.createdAt,
      campaign: p.goFundMeId ? { _id: p.goFundMeId._id, title: p.goFundMeId.title, slug: p.goFundMeId.slug } : null,
    }));

    res.json({
      success: true,
      data: {
        payments,
        pagination: { total, pages: Math.ceil(total / perPage), currentPage: pageNum, perPage },
        stats,
      },
    });
  } catch (error) {
    console.error("getAdminPayments error:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

exports.getCampaignAnalytics = async (req, res) => {
  try {
    const oid = orgId(req);
    const campaign = await GoFundMe.findOne({ _id: req.params.id, organisationId: oid })
      .populate("userId", "name email")
      .select("title targetAmount currentAmount donationCount status createdAt approvedAt completedAt");
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found" });

    const matchBase = { goFundMeId: new mongoose.Types.ObjectId(req.params.id), organisationId: new mongoose.Types.ObjectId(oid), paymentStatus: "completed" };

    const [overview] = await GoFundMeDonation.aggregate([
      { $match: matchBase },
      { $group: { _id: null, totalDonations: { $sum: 1 }, totalAmount: { $sum: "$amount" }, totalNetAmount: { $sum: "$netAmount" }, totalFees: { $sum: "$transactionFee" }, averageDonation: { $avg: "$amount" }, maxDonation: { $max: "$amount" }, minDonation: { $min: "$amount" } } },
    ]);
    const paymentMethods = await GoFundMeDonation.aggregate([
      { $match: matchBase },
      { $group: { _id: "$paymentMethod", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
    ]);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const donationsOverTime = await GoFundMeDonation.aggregate([
      { $match: { ...matchBase, createdAt: { $gte: thirtyDaysAgo } } },
      { $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" }, day: { $dayOfMonth: "$createdAt" } }, count: { $sum: 1 }, amount: { $sum: "$amount" } } },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]);
    const anonymityStats = await GoFundMeDonation.aggregate([
      { $match: matchBase },
      { $group: { _id: "$isAnonymous", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
    ]);

    res.json({
      success: true,
      campaign,
      analytics: {
        overview: overview || { totalDonations: 0, totalAmount: 0, totalNetAmount: 0, totalFees: 0, averageDonation: 0, maxDonation: 0, minDonation: 0 },
        paymentMethods,
        donationsOverTime,
        anonymityStats,
        progressPercentage: campaign.targetAmount > 0 ? (campaign.currentAmount / campaign.targetAmount) * 100 : 0,
      },
    });
  } catch (error) {
    console.error("getCampaignAnalytics error:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

exports.reviewGoFundMeRequest = async (req, res) => {
  try {
    const oid = orgId(req);
    const { status, adminNotes } = req.body;
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status. Must be approved or rejected" });
    }
    const goFundMe = await GoFundMe.findOne({ _id: req.params.id, organisationId: oid });
    if (!goFundMe) return res.status(404).json({ success: false, message: "Fundraiser not found" });
    if (goFundMe.status !== "pending") {
      return res.status(400).json({ success: false, message: "This request has already been reviewed" });
    }
    goFundMe.status = status;
    goFundMe.adminNotes = adminNotes;
    goFundMe.approvedBy = req.user.id;
    goFundMe.approvedAt = new Date();
    await goFundMe.save();
    await goFundMe.populate("userId", "name email");

    notifyRequester(goFundMe, req.organisation, status, adminNotes);
    res.json({ success: true, message: `Fundraiser ${status} successfully`, goFundMe });
  } catch (error) {
    console.error("reviewGoFundMeRequest error:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

exports.getGoFundMeStats = async (req, res) => {
  try {
    const oid = orgId(req);
    const base = { organisationId: oid };
    const [totalRequests, pendingRequests, approvedCampaigns, completedCampaigns] = await Promise.all([
      GoFundMe.countDocuments(base),
      GoFundMe.countDocuments({ ...base, status: "pending" }),
      GoFundMe.countDocuments({ ...base, status: "approved" }),
      GoFundMe.countDocuments({ ...base, status: "completed" }),
    ]);
    const totalDonations = await GoFundMeDonation.countDocuments({ ...base, paymentStatus: "completed" });
    const raised = await GoFundMeDonation.aggregate([
      { $match: { organisationId: new mongoose.Types.ObjectId(oid), paymentStatus: "completed" } },
      { $group: { _id: null, total: { $sum: "$netAmount" } } },
    ]);
    res.json({
      success: true,
      stats: {
        totalRequests, pendingRequests, approvedCampaigns, completedCampaigns,
        totalDonations, totalAmountRaised: raised[0]?.total || 0,
      },
    });
  } catch (error) {
    console.error("getGoFundMeStats error:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

/* ── admin: delete (cleanup image) ───────────────────────────────────── */

exports.deleteGoFundMe = async (req, res) => {
  try {
    const oid = orgId(req);
    const goFundMe = await GoFundMe.findOne({ _id: req.params.id, organisationId: oid });
    if (!goFundMe) return res.status(404).json({ success: false, message: "Fundraiser not found" });
    if (goFundMe.imagePath) await deleteS3Object(goFundMe.imagePath).catch((e) => console.error("S3 delete:", e));
    await GoFundMe.deleteOne({ _id: goFundMe._id, organisationId: oid });
    res.json({ success: true, message: "Fundraiser deleted" });
  } catch (error) {
    console.error("deleteGoFundMe error:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};
