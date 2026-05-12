// routes/admin/order.routes.js
const express = require("express");
const router = express.Router();
const isAdmin = require("../../middleware/isAdmin");
const {
  getDashboardStats,
  getTopDonors,
  getDonations,
  getDonationsExport,
  getDonationForUser,
  getAllDonations,
  getDonationById, // Added this
  updateDonationStatus, // Added this
} = require("../../controllers/admin/orderController");

router.get("/dashboard/stats", isAdmin, getDashboardStats);
router.get("/dashboard/top-donors", isAdmin, getTopDonors);
router.get("/donations", isAdmin, getDonations);
router.get("/donations/all", isAdmin, getAllDonations);

// Important: Order matters for routes with parameters
// More specific routes should come before general ones to avoid conflicts
router.get("/donations/user/:userId", isAdmin, getDonationForUser); // User-specific route first
router.get("/donations/:id", isAdmin, getDonationById); // Then the general ID route
router.put("/donations/:id/status", isAdmin, updateDonationStatus); // Status update route
router.get("/export", isAdmin, getDonationsExport);

module.exports = router;
