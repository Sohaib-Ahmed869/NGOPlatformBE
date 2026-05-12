const express = require("express");
const router = express.Router();
const orderController = require("../controllers/orderContrller");
const auth = require("../middleware/auth");
const optionalAuth = require("../middleware/optionalAuth");

// Public routes (no authentication required)
router.post("/create", optionalAuth, orderController.createOrder); // Allow anonymous donations

// Receipt upload route
router.post("/upload-receipt", optionalAuth, orderController.uploadReceipt);

// Get order by donation ID
router.get("/donation/:donationId", orderController.getOrderByDonationId);
router.get("/donation/:donationId/view-receipt", orderController.proxyReceiptForViewing);

// Delete receipt route
router.delete("/donation/:donationId/receipt", orderController.deleteReceipt);

// Protected routes (authentication required)
router.get("/my-orders", auth, orderController.getOrders);
router.get("/stats", auth, orderController.getOrderStats);
router.get("/:id", auth, orderController.getOrderById);
router.patch("/:id/status", auth, orderController.updateOrderStatus);

module.exports = router;
