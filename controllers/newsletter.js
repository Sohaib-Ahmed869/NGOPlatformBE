// controllers/newsletterController.js
const NewsletterSubscription = require("../models/newsletter");

exports.subscribe = async (req, res) => {
  try {
    const { email } = req.body;
    const subscription = await NewsletterSubscription.create({ email });
    res.status(201).json(subscription);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
