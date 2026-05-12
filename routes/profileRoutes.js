// routes/profile.routes.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const auth = require("../middleware/auth");
const {
  getProfile,
  updateProfile,
  updateNotifications,
  updatePassword,
  uploadProfileImage,
  updateTwoFactor,
  signOutAllDevices,
} = require("../controllers/profileController");

// Configure multer for file uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: "uploads/profile",
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    },
  }),
});

router.get("/", auth, getProfile);
router.put("/", auth, updateProfile);
router.put("/notifications", auth, updateNotifications);
router.put("/password", auth, updatePassword);
router.post("/image", auth, upload.single("profileImage"), uploadProfileImage);
router.put("/2fa", auth, updateTwoFactor);
router.post("/signout-all", auth, signOutAllDevices);

module.exports = router;
