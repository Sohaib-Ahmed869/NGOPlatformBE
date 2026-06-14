const express = require("express");
const router = express.Router();
const pageController = require("../controllers/pageController");

// Public — full content for a single page (tenant resolved by tenant middleware)
router.get("/:key", pageController.getPageContent);

module.exports = router;
