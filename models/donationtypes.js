const mongoose = require('mongoose');

const donationTypeSchema = new mongoose.Schema({
  organisationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organisation",
    default: null,
  },
  donationType: {
    type: String,
    required: [true, 'Donation type is required'],
    trim: true,
    maxLength: [100, 'Donation type cannot exceed 100 characters']
  },
  // Display order — lower shows first. Set on create (append) and via reorder.
  order: {
    type: Number,
    default: 0,
  }
}, {
  timestamps: true
});

donationTypeSchema.index({ organisationId: 1, donationType: 1 }, { unique: true });

module.exports = mongoose.model('DonationType', donationTypeSchema);