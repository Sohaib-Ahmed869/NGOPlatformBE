// Contact Request Model
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const contactRequestSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
    },
    phoneNumber: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
    purpose: {
      type: String,
      required: true,
    },
    hostCity: {
      type: String,
      
    },
    wouldLikeToHostShahidAfridi: {
      type: Boolean,
 
    },
    description: {
      type: String,
      required: true,
    },
    numberOfGuests: {
      type: Number,
   
    },
    minimumDonation: {
      type: Number,
  
    },
    status: {
      type: String,
      enum: ["pending", "reviewed", "responded"],
      default: "pending",
    },
  },
  {
    timestamps: true,
  }
);

const ContactRequest = mongoose.model("ContactRequest", contactRequestSchema);

module.exports = ContactRequest;
