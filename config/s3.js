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
    // Isolate each tenant's uploads under their slug, e.g. "calcite/products/...".
    // Falls back to a flat folder when there's no tenant context (e.g. the
    // registration logo upload, before the org exists).
    const slug = req.organisation?.slug;
    const prefix = slug ? `${slug}/${folder}` : folder;
    cb(null, `${prefix}/` + uniqueSuffix + path.extname(file.originalname));
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

// Configure multer for Branding/logo uploads
const brandingUpload = multer({
  storage: multerS3(createUploadConfig("branding")),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB for logos
  fileFilter: function (req, file, cb) {
    // Logos + favicons. Favicons are commonly .ico, so accept that too.
    const filetypes = /jpeg|jpg|png|svg|webp|ico/;
    const mimetype =
      /image\/(jpeg|jpg|png|svg\+xml|webp|x-icon|vnd\.microsoft\.icon)/.test(
        file.mimetype
      );
    const extname = filetypes.test(
      path.extname(file.originalname).toLowerCase()
    );

    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Only image files (JPEG, PNG, SVG, WebP, ICO) are allowed for logos!"));
  },
});

// Configure multer for user avatar uploads (admin/user profile photos)
const avatarUpload = multer({
  storage: multerS3(createUploadConfig("avatars")),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: function (req, file, cb) {
    const filetypes = /jpeg|jpg|png|webp/;
    const mimetype = /image\/(jpeg|jpg|png|webp)/.test(file.mimetype);
    const extname = filetypes.test(
      path.extname(file.originalname).toLowerCase()
    );
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Only image files (JPEG, PNG, WebP) are allowed for avatars!"));
  },
});

// Configure multer for Program uploads (images only)
const programUpload = multer({
  storage: multerS3(createUploadConfig("programs")),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const filetypes = /jpeg|jpg|png|gif|webp/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(
      path.extname(file.originalname).toLowerCase()
    );
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Only image files are allowed!"));
  },
});

// Configure multer for P2P campaign uploads (images only)
const campaignUpload = multer({
  storage: multerS3(createUploadConfig("campaigns")),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const filetypes = /jpeg|jpg|png|gif|webp/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(
      path.extname(file.originalname).toLowerCase()
    );
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Only image files are allowed!"));
  },
});

// Configure multer for page-content image uploads (CMS page editor)
const pageContentUpload = multer({
  storage: multerS3(createUploadConfig("page-content")),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: function (req, file, cb) {
    const filetypes = /jpeg|jpg|png|gif|webp|svg/;
    const mimetype = /image\/(jpeg|jpg|png|gif|webp|svg\+xml)/.test(file.mimetype);
    const extname = filetypes.test(
      path.extname(file.originalname).toLowerCase()
    );
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Only image files are allowed!"));
  },
});

// Configure multer for donation update uploads (images shared with donors)
const donationUpdatesUpload = multer({
  storage: multerS3(createUploadConfig("donation-updates")),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB file size limit
  fileFilter: function (req, file, cb) {
    const filetypes = /jpeg|jpg|png|gif|webp/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(
      path.extname(file.originalname).toLowerCase()
    );

    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Only image files are allowed!"));
  },
});

module.exports = {
  upload: eventsUpload, // For backward compatibility
  s3Client,
  deleteS3Object,
  eventsUpload,
  productUpload,
  brandingUpload,
  programUpload,
  campaignUpload,
  pageContentUpload,
  donationUpdatesUpload,
  avatarUpload,
};