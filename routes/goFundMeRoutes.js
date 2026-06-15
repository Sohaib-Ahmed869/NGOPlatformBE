const express = require("express");
const router = express.Router();
const goFundMe = require("../controllers/goFundMeController");
const { protect, admin } = require("../middleware/authMiddleware");
const optionalAuth = require("../middleware/optionalAuth");
const { campaignUpload } = require("../config/s3");

// ── Public ──
router.get("/public", goFundMe.getPublicGoFundMes);
router.get("/categories", goFundMe.getAvailableCategories);
router.get("/campaign/:slug", goFundMe.getGoFundMeBySlug);

// ── User (signed-in supporter) ──
router.post("/", protect, campaignUpload.single("image"), goFundMe.createGoFundMe);
router.get("/my-requests", protect, goFundMe.getMyGoFundMeRequests);
router.get("/my-donations", protect, goFundMe.getMyP2PDonations);

// ── Payments (guests allowed; optionalAuth links a logged-in donor) ──
router.post("/create-payment-intent/:id", optionalAuth, goFundMe.createDonationPaymentIntent);
router.post("/process-donation", optionalAuth, goFundMe.processDonation);
router.post("/:id/paypal/create-order", optionalAuth, goFundMe.createPayPalOrder);
router.post("/:id/paypal/capture", optionalAuth, goFundMe.capturePayPalDonation);

// ── Admin ──
router.get("/admin/requests", protect, admin, goFundMe.getAdminGoFundMeRequests);
router.get("/admin/stats", protect, admin, goFundMe.getGoFundMeStats);
router.get("/admin/payments", protect, admin, goFundMe.getAdminPayments);
router.get("/admin/donors/:id", protect, admin, goFundMe.getCampaignDonors);
router.get("/admin/analytics/:id", protect, admin, goFundMe.getCampaignAnalytics);
router.put("/admin/review/:id", protect, admin, goFundMe.reviewGoFundMeRequest);
router.delete("/:id", protect, admin, goFundMe.deleteGoFundMe);

module.exports = router;
