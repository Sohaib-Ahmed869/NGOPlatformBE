// Event Model
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const eventSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    startTime: {
      type: String,
      required: true,
    },
    endTime: {
      type: String,
      required: true,
    },
    timezone: {
      type: String,
      required: true,
    },
    location: {
      city: String,
      venue: String,
      address: String,
    },
    description: String,
    imageUrl: String,
    registrationLink: String,
    status: {
      type: String,
      enum: ["upcoming", "ongoing", "completed", "cancelled"],
      default: "upcoming",
    },
  },
  {
    timestamps: true,
  }
);

const Event = mongoose.model("Event", eventSchema);

module.exports = Event;
