// routes/installment.js
const express = require("express");
const router = express.Router();
const installmentController = require("../controllers/installmentController");
const auth = require("../middleware/auth");

// Get all installment orders for the authenticated user
router.get("/", auth, installmentController.getInstallmentOrders);

// Get a specific installment order by ID
router.get("/:orderId", auth, installmentController.getInstallmentOrder);

// Process the next installment payment manually
router.post(
  "/:orderId/process-payment",
  auth,
  installmentController.processNextInstallmentPayment
);

// Cancel remaining installment payments
router.post(
  "/:orderId/cancel",
  auth,
  installmentController.cancelRemainingInstallments
);

// Update installment amount for remaining payments
router.post(
  "/:orderId/update-amount",
  auth,
  installmentController.updateInstallmentAmount
);

module.exports = router;
