// controllers/partnerInquiryController.js
//
// Public "Become a partner" submissions + admin management (tenant-scoped).
const PartnerInquiry = require("../models/partnerInquiry");
const User = require("../models/user");
const { sendEmail } = require("../services/emailUtil");
const { deleteS3Object } = require("../config/s3");

const TYPE_LABELS = {
  corporate: "Corporate partnership",
  community: "Community group",
  "in-kind": "In-kind support",
  ambassador: "Ambassador",
  other: "Other",
};

const VALID_STATUS = ["new", "in_review", "contacted", "approved", "declined"];
const VALID_TYPE = Object.keys(TYPE_LABELS);

// Multipart/checkbox values arrive as strings ("true"/"on") — coerce to boolean.
const toBool = (v) => v === true || ["true", "on", "1", "yes"].includes(String(v).toLowerCase());

const emailOpts = (org) => ({ org, fromName: org?.name, replyTo: org?.contactEmail || undefined });

function shell(orgName, inner) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
      ${inner}
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
      <p style="font-size:12px;color:#888">Sent by ${orgName || "us"}.</p>
    </div>`;
}

// Tell the org's admins a new partnership enquiry arrived (best-effort).
async function notifyAdmins(org, inquiry) {
  try {
    const filter = { role: { $in: ["admin", "superadmin"] } };
    if (org?._id) filter.organisationId = org._id;
    const admins = await User.find(filter).select("email").lean();
    const emails = [...new Set(admins.map((a) => a.email).filter(Boolean))];
    if (!emails.length) return;
    const html = shell(
      org?.name,
      `<h2 style="color:#2C2418">New partnership enquiry</h2>
       <p>Someone wants to partner with you.</p>
       <div style="background:#f9f9f9;padding:15px;border-radius:6px;margin:16px 0">
         <p style="margin:4px 0"><strong>Name:</strong> ${inquiry.name}</p>
         ${inquiry.organisationName ? `<p style="margin:4px 0"><strong>Organisation:</strong> ${inquiry.organisationName}</p>` : ""}
         <p style="margin:4px 0"><strong>Type:</strong> ${TYPE_LABELS[inquiry.partnershipType] || inquiry.partnershipType}</p>
         <p style="margin:4px 0"><strong>Email:</strong> ${inquiry.email}</p>
         ${inquiry.phone ? `<p style="margin:4px 0"><strong>Phone:</strong> ${inquiry.phone}</p>` : ""}
         ${inquiry.website ? `<p style="margin:4px 0"><strong>Website:</strong> ${inquiry.website}</p>` : ""}
         ${inquiry.message ? `<p style="margin:8px 0 0"><strong>Message:</strong><br/>${String(inquiry.message).replace(/\n/g, "<br/>")}</p>` : ""}
       </div>
       <p>Review and respond from your admin portal → Partners.</p>`
    );
    await Promise.allSettled(
      emails.map((e) => sendEmail(e, html, `New partnership enquiry — ${org?.name || ""}`, [], emailOpts(org)))
    );
  } catch (err) {
    console.error("notifyAdmins (partner) error:", err.message);
  }
}

// Thank the applicant (best-effort).
async function ackApplicant(org, inquiry) {
  try {
    if (!inquiry.email) return;
    const html = shell(
      org?.name,
      `<h2 style="color:#2C2418">Thank you for reaching out 🤝</h2>
       <p>Hi ${inquiry.name || "there"}, thanks for your interest in partnering with ${org?.name || "us"}.</p>
       <p>We've received your enquiry and a member of our team will be in touch soon.</p>`
    );
    await sendEmail(inquiry.email, html, `We received your partnership enquiry — ${org?.name || ""}`, [], emailOpts(org));
  } catch (err) {
    console.error("ackApplicant (partner) error:", err.message);
  }
}

// Celebrate a partner going live on the public wall (best-effort).
async function notifyFeatured(org, inquiry) {
  try {
    if (!inquiry.email) return;
    const displayName = inquiry.publicName || inquiry.organisationName || inquiry.name || "your organisation";
    const html = shell(
      org?.name,
      `<h2 style="color:#2C2418">You're now featured on our partners page 🎉</h2>
       <p>Hi ${inquiry.name || "there"}, we're delighted to share that <strong>${displayName}</strong> is now listed on the ${org?.name || "our"} partners page.</p>
       <p>Thank you for standing with us — together we reach further.</p>`
    );
    await sendEmail(inquiry.email, html, `You're featured on our partners page — ${org?.name || ""}`, [], emailOpts(org));
  } catch (err) {
    console.error("notifyFeatured (partner) error:", err.message);
  }
}

/* ── public: submit the "Become a partner" form ──────────────────────────── */
exports.submit = async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const email = (req.body.email || "").toLowerCase().trim();
    if (!name || !email) {
      return res.status(400).json({ error: "Name and email are required" });
    }
    if (!/\S+@\S+\.\S+/.test(email)) {
      return res.status(400).json({ error: "Please provide a valid email" });
    }

    const partnershipType = VALID_TYPE.includes(req.body.partnershipType)
      ? req.body.partnershipType
      : "other";

    const inquiry = await PartnerInquiry.create({
      organisationId: req.organisation?._id || null,
      name,
      organisationName: (req.body.organisationName || "").trim(),
      email,
      phone: (req.body.phone || "").trim(),
      website: (req.body.website || "").trim(),
      partnershipType,
      message: (req.body.message || "").trim(),
      consentToList: toBool(req.body.consentToList),
      logoUrl: req.file?.location || "",
      logoKey: req.file?.key || "",
      source: "website",
    });

    // Fire-and-forget notifications (don't block the response).
    notifyAdmins(req.organisation, inquiry);
    ackApplicant(req.organisation, inquiry);

    res.status(201).json({ status: "Success", message: "Thanks — we'll be in touch soon." });
  } catch (error) {
    console.error("Partner submit error:", error);
    res.status(400).json({ error: error.message });
  }
};

/* ── public: approved + published partners for the website logo wall ──────── */
// Returns ONLY safe, public-facing fields — never email/phone/message/notes.
exports.publicList = async (req, res) => {
  try {
    const filter = { status: "approved", showOnWebsite: true };
    if (req.organisation?._id) filter.organisationId = req.organisation._id;

    const docs = await PartnerInquiry.find(filter)
      .sort({ displayOrder: 1, createdAt: 1 })
      .select("organisationName name publicName logoUrl publicLogoUrl website partnershipType displayOrder")
      .lean();

    const items = docs.map((d) => ({
      id: String(d._id),
      name: d.publicName || d.organisationName || d.name || "",
      logo: d.publicLogoUrl || d.logoUrl || "",
      website: d.website || "",
      partnershipType: d.partnershipType || "other",
      displayOrder: d.displayOrder || 0,
    }));

    res.json({ items });
  } catch (error) {
    console.error("Partner publicList error:", error);
    res.status(400).json({ error: error.message });
  }
};

/* ── admin: list (with optional status/type/search filters) ──────────────── */
exports.list = async (req, res) => {
  try {
    const filter = {};
    if (req.organisation?._id) filter.organisationId = req.organisation._id;

    const { status, type, search } = req.query;
    if (status && status !== "all" && VALID_STATUS.includes(status)) filter.status = status;
    if (type && type !== "all" && VALID_TYPE.includes(type)) filter.partnershipType = type;
    if (search && search.trim()) {
      const rx = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: rx }, { organisationName: rx }, { email: rx }];
    }

    const items = await PartnerInquiry.find(filter).sort({ createdAt: -1 }).lean();

    // Status counts for the filter chips (scoped to the org, ignoring filters).
    const base = req.organisation?._id ? { organisationId: req.organisation._id } : {};
    const agg = await PartnerInquiry.aggregate([
      { $match: base },
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]);
    const counts = { all: 0 };
    VALID_STATUS.forEach((s) => (counts[s] = 0));
    agg.forEach((g) => {
      counts[g._id] = g.n;
      counts.all += g.n;
    });

    res.json({ items, counts });
  } catch (error) {
    console.error("Partner list error:", error);
    res.status(400).json({ error: error.message });
  }
};

exports.getOne = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (req.organisation?._id) filter.organisationId = req.organisation._id;
    const item = await PartnerInquiry.findOne(filter).lean();
    if (!item) return res.status(404).json({ error: "Enquiry not found" });
    res.json(item);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

/* ── admin: update status / notes / website listing ──────────────────────── */
exports.update = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (req.organisation?._id) filter.organisationId = req.organisation._id;

    const current = await PartnerInquiry.findOne(filter);
    if (!current) return res.status(404).json({ error: "Enquiry not found" });

    const set = {};

    if (req.body.status !== undefined) {
      if (!VALID_STATUS.includes(req.body.status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      set.status = req.body.status;
      // Declining an enquiry pulls it off the public wall.
      if (req.body.status === "declined") set.showOnWebsite = false;
    }

    if (req.body.adminNotes !== undefined) set.adminNotes = String(req.body.adminNotes);
    if (req.body.publicName !== undefined) set.publicName = String(req.body.publicName).trim();
    if (req.body.consentToList !== undefined) set.consentToList = toBool(req.body.consentToList);
    if (req.body.displayOrder !== undefined) {
      const n = Number(req.body.displayOrder);
      if (!Number.isNaN(n)) set.displayOrder = n;
    }

    // Publish toggle is gated: needs consent + a logo, and can't be a declined enquiry.
    if (req.body.showOnWebsite !== undefined) {
      const wantPublish = toBool(req.body.showOnWebsite);
      if (wantPublish) {
        const effectiveConsent = set.consentToList !== undefined ? set.consentToList : current.consentToList;
        const effectiveLogo = current.publicLogoUrl || current.logoUrl;
        const effectiveStatus = set.status !== undefined ? set.status : current.status;
        if (!effectiveConsent) {
          return res.status(400).json({ error: "Consent to be listed is required before showing a partner on the website." });
        }
        if (!effectiveLogo) {
          return res.status(400).json({ error: "Add a logo before showing this partner on the website." });
        }
        if (effectiveStatus === "declined") {
          return res.status(400).json({ error: "A declined enquiry can't be shown on the website." });
        }
        // First publish with no explicit order → drop it at the end of the wall.
        if (!current.showOnWebsite && set.displayOrder === undefined && !current.displayOrder) {
          const last = await PartnerInquiry.findOne({
            ...(req.organisation?._id ? { organisationId: req.organisation._id } : {}),
            showOnWebsite: true,
          })
            .sort({ displayOrder: -1 })
            .select("displayOrder")
            .lean();
          set.displayOrder = (last?.displayOrder || 0) + 1;
        }
      }
      set.showOnWebsite = wantPublish;
    }

    const item = await PartnerInquiry.findOneAndUpdate(filter, { $set: set }, { new: true }).lean();
    if (!item) return res.status(404).json({ error: "Enquiry not found" });

    // Email the partner only on the false→true publish edge.
    if (set.showOnWebsite === true && !current.showOnWebsite) {
      notifyFeatured(req.organisation, item);
    }

    res.json(item);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

/* ── admin: replace the public-facing logo (separate from the submitted one) ─ */
exports.replacePublicLogo = async (req, res) => {
  try {
    if (!req.file?.location) return res.status(400).json({ error: "No logo uploaded" });
    const filter = { _id: req.params.id };
    if (req.organisation?._id) filter.organisationId = req.organisation._id;

    const current = await PartnerInquiry.findOne(filter).select("publicLogoKey");
    if (!current) {
      deleteS3Object(req.file.key).catch(() => {}); // don't orphan the just-uploaded file
      return res.status(404).json({ error: "Enquiry not found" });
    }

    const oldKey = current.publicLogoKey;
    const item = await PartnerInquiry.findOneAndUpdate(
      filter,
      { $set: { publicLogoUrl: req.file.location, publicLogoKey: req.file.key } },
      { new: true }
    ).lean();
    if (oldKey) deleteS3Object(oldKey).catch(() => {});
    res.json(item);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (req.organisation?._id) filter.organisationId = req.organisation._id;
    const item = await PartnerInquiry.findOneAndDelete(filter);
    if (!item) return res.status(404).json({ error: "Enquiry not found" });
    // Best-effort cleanup of both the submitted and the public-override logos.
    if (item.logoKey) deleteS3Object(item.logoKey).catch(() => {});
    if (item.publicLogoKey) deleteS3Object(item.publicLogoKey).catch(() => {});
    res.json({ status: "Success", message: "Enquiry deleted" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
