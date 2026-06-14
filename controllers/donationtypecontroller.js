const DonationType = require('../models/donationtypes');

// Create a new donation type
const createDonationType = async (req, res) => {
  try {
    const { donationType } = req.body;
    const orgId = req.organisation?._id || null;
    // Append new types to the end of the list.
    const order = await DonationType.countDocuments(orgId ? { organisationId: orgId } : {});

    const newDonationType = new DonationType({
      organisationId: orgId,
      donationType,
      order,
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
    const filter = {};
    if (req.organisation?._id) filter.organisationId = req.organisation._id;
    const donationTypes = await DonationType.find(filter).sort({ order: 1, createdAt: 1 });
    
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
    const dtQuery = { _id: req.params.id };
    if (req.organisation?._id) dtQuery.organisationId = req.organisation._id;
    const donationType = await DonationType.findOne(dtQuery);
    
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
    
    const dtUpdateQuery = { _id: req.params.id };
    if (req.organisation?._id) dtUpdateQuery.organisationId = req.organisation._id;
    const updatedDonationType = await DonationType.findOneAndUpdate(
      dtUpdateQuery,
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
    const dtDelQuery = { _id: req.params.id };
    if (req.organisation?._id) dtDelQuery.organisationId = req.organisation._id;
    const donationType = await DonationType.findOneAndDelete(dtDelQuery);
    
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

// Reorder donation types — body { ids: [...] } in the desired display order.
const reorderDonationTypes = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) {
      return res.status(400).json({ success: false, message: "ids array is required" });
    }
    const orgId = req.organisation?._id || null;
    const ops = ids.map((id, index) => ({
      updateOne: {
        filter: orgId ? { _id: id, organisationId: orgId } : { _id: id },
        update: { $set: { order: index } },
      },
    }));
    if (ops.length) await DonationType.bulkWrite(ops);

    res.status(200).json({ success: true, message: "Order updated" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  createDonationType,
  getDonationTypes,
  getDonationTypeById,
  updateDonationType,
  deleteDonationType,
  reorderDonationTypes
};