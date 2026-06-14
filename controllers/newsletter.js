// controllers/newsletterController.js
const NewsletterSubscription = require("../models/newsletter");
const mc = require("../services/mailchimp");

exports.subscribe = async (req, res) => {
  try {
    const { email } = req.body;
    const subscription = await NewsletterSubscription.create({
      email,
      organisationId: req.organisation?._id || null,
    });
    mc.syncMemberSafe(req.organisation, email, "active"); // → Mailchimp
    res.status(201).json(subscription);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
