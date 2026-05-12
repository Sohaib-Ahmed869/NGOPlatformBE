// config/s3.js
const path = require("path");
const multer = require("multer");
const { S3Client, DeleteObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const multerS3 = require("multer-s3-v3");

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Helper function to create upload configuration
const createUploadConfig = (folder) => ({
  s3: s3Client,
  bucket: process.env.S3_BUCKET_NAME,
  contentDisposition: function (req, file, cb) {
    cb(null, "inline");
  },
  contentType: multerS3.AUTO_CONTENT_TYPE,
  metadata: function (req, file, cb) {
    cb(null, { fieldName: file.fieldname });
  },
  key: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `${folder}/` + uniqueSuffix + path.extname(file.originalname));
  },
});

// Configure multer for Events uploads
const eventsUpload = multer({
  storage: multerS3(createUploadConfig("events")),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB file size limit
  fileFilter: function (req, file, cb) {
    const filetypes = /jpeg|jpg|png|gif|pdf/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(
      path.extname(file.originalname).toLowerCase()
    );

    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Only image files and PDFs are allowed!"));
  },
});   

// Configure multer for Product uploads
const productUpload = multer({
  storage: multerS3(createUploadConfig("products")),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB file size limit
  fileFilter: function (req, file, cb) {
    const filetypes = /jpeg|jpg|png|gif|pdf/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(
      path.extname(file.originalname).toLowerCase()
    );

    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Only image files and PDFs are allowed!"));
  },
});

// Helper function to delete objects from S3
const deleteS3Object = async (key) => {
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
  };

  try {
    await s3Client.send(new DeleteObjectCommand(params));
    return true;
  } catch (error) {
    console.error("Error deleting S3 object:", error);
    return false;
  }
};

module.exports = { 
  upload: eventsUpload, // For backward compatibility
  s3Client, 
  deleteS3Object,
  eventsUpload,
  productUpload
};