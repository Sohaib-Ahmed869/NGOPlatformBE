const mongoose = require("mongoose");

const newsletterSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

const Newsletter = mongoose.model("Newsletter", newsletterSchema);
