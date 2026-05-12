// middleware/errorHandler.js
const errorHandler = (err, req, res, next) => {
  console.error(err.stack);

  if (err.name === "ValidationError") {
    return res.status(400).json({
      error: "Validation Error",
      details: Object.values(err.errors).map((error) => error.message),
    });
  }

  if (err.code === 11000) {
    return res.status(400).json({
      error: "Duplicate Error",
      message: "This record already exists.",
    });
  }

  res.status(500).json({
    error: "Server Error",
    message: "Something went wrong on our end.",
  });
};

module.exports = errorHandler;
