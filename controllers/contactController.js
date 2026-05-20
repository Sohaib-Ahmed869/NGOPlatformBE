// conrollers/contactController.js
const ContactRequest = require("../models/contact");

exports.createContact = async (req, res) => {
  try {
    console.log(req.body); 
    const contact = await ContactRequest.create({ ...req.body, organisationId: req.organisation?._id || null });
    res.status(201).json(contact);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

exports.getAlContact = async (req, res) => {
  try {
    const filter = {};
    if (req.organisation?._id) filter.organisationId = req.organisation._id;
    const contacts = await ContactRequest.find(filter);
    res.status(200).json(contacts);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
}

