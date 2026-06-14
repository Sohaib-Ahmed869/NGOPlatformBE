const express = require('express');
const router = express.Router();
const {
  createDonationType,
  getDonationTypes,
  getDonationTypeById,
  updateDonationType,
  deleteDonationType,
  reorderDonationTypes
} = require('../controllers/donationtypecontroller');
const isAdmin = require('../middleware/isAdmin');

// @route   GET /api/donationtypes
// @desc    Get all donation types
// @access  Public (the donation form reads these)
router.get('/', getDonationTypes);

// @route   GET /api/donationtypes/:id
// @desc    Get single donation type by ID
// @access  Public
router.get('/:id', getDonationTypeById);

// ── Admin only (write operations) ──

// @route   POST /api/donationtypes
// @desc    Create a new donation type
// @access  Admin
router.post('/', isAdmin, createDonationType);

// @route   PUT /api/donationtypes/reorder
// @desc    Persist a new display order (must precede /:id)
// @access  Admin
router.put('/reorder', isAdmin, reorderDonationTypes);

// @route   PUT /api/donationtypes/:id
// @desc    Update donation type
// @access  Admin
router.put('/:id', isAdmin, updateDonationType);

// @route   DELETE /api/donationtypes/:id
// @desc    Delete donation type
// @access  Admin
router.delete('/:id', isAdmin, deleteDonationType);

module.exports = router;
