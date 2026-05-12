const DonationType = require('../models/donationtypes');

// Create a new donation type
const createDonationType = async (req, res) => {
  try {
    const { donationType } = req.body;
    
    const newDonationType = new DonationType({
      donationType
    });
    
    const savedDonationType = await newDonationType.save();
    
    res.status(201).json({
      success: true,
      message: 'Donation type created successfully',
      data: savedDonationType
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Donation type already exists'
      });
    }
    
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// Get all donation types
const getDonationTypes = async (req, res) => {
  try {
    const donationTypes = await DonationType.find().sort({ createdAt: -1 });
    
    res.status(200).json({
      success: true,
      count: donationTypes.length,
      data: donationTypes
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Get single donation type by ID
const getDonationTypeById = async (req, res) => {
  try {
    const donationType = await DonationType.findById(req.params.id);
    
    if (!donationType) {
      return res.status(404).json({
        success: false,
        message: 'Donation type not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: donationType
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Update donation type
const updateDonationType = async (req, res) => {
  try {
    const { donationType } = req.body;
    
    const updatedDonationType = await DonationType.findByIdAndUpdate(
      req.params.id,
      { donationType },
      { new: true, runValidators: true }
    );
    
    if (!updatedDonationType) {
      return res.status(404).json({
        success: false,
        message: 'Donation type not found'
      });
    }
    
    res.status(200).json({
      success: true,
      message: 'Donation type updated successfully',
      data: updatedDonationType
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Donation type already exists'
      });
    }
    
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// Delete donation type
const deleteDonationType = async (req, res) => {
  try {
    const donationType = await DonationType.findByIdAndDelete(req.params.id);
    
    if (!donationType) {
      return res.status(404).json({
        success: false,
        message: 'Donation type not found'
      });
    }
    
    res.status(200).json({
      success: true,
      message: 'Donation type deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

module.exports = {
  createDonationType,
  getDonationTypes,
  getDonationTypeById,
  updateDonationType,
  deleteDonationType
};