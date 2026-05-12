// conrollers/contactController.js
const ContactRequest = require("../models/contact");

exports.createContact = async (req, res) => {
  try {
    console.log(req.body); 
    const contact = await ContactRequest.create(req.body);
    res.status(201).json(contact);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

exports.getAlContact = async (req, res) => {
  try {
    const contacts = await ContactRequest.find();
    res.status(200).json(contacts);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
}

