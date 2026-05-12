const express = require('express');
const router = express.Router();
const {
  createDonationType,
  getDonationTypes,
  getDonationTypeById,
  updateDonationType,
  deleteDonationType
} = require('../controllers/donationtypecontroller');

// @route   POST /api/donation-types
// @desc    Create a new donation type
// @access  Public
router.post('/', createDonationType);

// @route   GET /api/donation-types
// @desc    Get all donation types
// @access  Public
router.get('/', getDonationTypes);

// @route   GET /api/donation-types/:id
// @desc    Get single donation type by ID
// @access  Public
router.get('/:id', getDonationTypeById);

// @route   PUT /api/donation-types/:id
// @desc    Update donation type
// @access  Public
router.put('/:id', updateDonationType);

// @route   DELETE /api/donation-types/:id
// @desc    Delete donation type
// @access  Public
router.delete('/:id', deleteDonationType);

module.exports = router;