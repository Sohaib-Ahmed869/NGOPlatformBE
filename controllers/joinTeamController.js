const Join = require("../models/join");

exports.createJoin = async (req, res) => {
  try {
    console.log(req.body);
    const join = await Join.create({ ...req.body, organisationId: req.organisation?._id || null });
    res.status(201).json(join);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

exports.getAllJoin = async (req, res) => {
  try {
    const filter = {};
    if (req.organisation?._id) filter.organisationId = req.organisation._id;
    const joins = await Join.find(filter);
    res.status(200).json(joins);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};
