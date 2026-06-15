// routes/paymentMethodRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const {
  createSetupIntent,
  addPaymentMethod,
  getPaymentMethods,
  deletePaymentMethod,
  setDefaultPaymentMethod,
} = require("../controllers/paymentMethodController");

router.post("/setup-intent", auth, createSetupIntent);
router.post("/", auth, addPaymentMethod);
router.get("/", auth, getPaymentMethods);
router.delete("/:id", auth, deletePaymentMethod);
router.patch("/:id/default", auth, setDefaultPaymentMethod);

module.exports = router;
