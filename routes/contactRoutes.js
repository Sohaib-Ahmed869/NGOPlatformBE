// routes/contactRoutes.js
const express = require("express");
const router = express.Router();
const contactController = require("../controllers/contactController");

router.post("/", contactController.createContact);
router.get("/", contactController.getAlContact);

module.exports = router;
