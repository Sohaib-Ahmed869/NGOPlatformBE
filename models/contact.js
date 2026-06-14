// Contact Request Model
const mongoose = require("mongoose");
const contactRequestSchema = new mongoose.Schema(
  {
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      default: null,
    },
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
    // Internal communication: the team member responsible for this request.
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Timestamp of the latest activity (submission or thread message) — drives
    // inbox ordering and per-user unread detection.
    lastMessageAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

const ContactRequest = mongoose.model("ContactRequest", contactRequestSchema);

module.exports = ContactRequest;
