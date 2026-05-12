// routes/paymentMethodRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const {
  addPaymentMethod,
  getPaymentMethods,
  deletePaymentMethod,
  setDefaultPaymentMethod,
} = require("../controllers/paymentMethodController");

router.post("/", auth, addPaymentMethod);
router.get("/", auth, getPaymentMethods);
router.delete("/:id", auth, deletePaymentMethod);
router.patch("/:id/default", auth, setDefaultPaymentMethod);

module.exports = router;
