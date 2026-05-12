const Join = require("../models/join");

exports.createJoin = async (req, res) => {
  try {
    console.log(req.body);
    const join = await Join.create(req.body);
    res.status(201).json(join);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

exports.getAllJoin = async (req, res) => {
  try {
    const joins = await Join.find();
    res.status(200).json(joins);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};
