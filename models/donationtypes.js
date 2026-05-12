const mongoose = require('mongoose');

const donationTypeSchema = new mongoose.Schema({
  donationType: {
    type: String,
    required: [true, 'Donation type is required'],
    trim: true,
    maxLength: [100, 'Donation type cannot exceed 100 characters'],
    unique: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('DonationType', donationTypeSchema);