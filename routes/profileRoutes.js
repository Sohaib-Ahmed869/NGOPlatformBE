// routes/profile.routes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const { avatarUpload } = require("../config/s3");
const {
  getProfile,
  updateProfile,
  updateNotifications,
  updatePassword,
  uploadProfileImage,
  updateTwoFactor,
  signOutAllDevices,
} = require("../controllers/profileController");

router.get("/", auth, getProfile);
router.put("/", auth, updateProfile);
router.put("/notifications", auth, updateNotifications);
router.put("/password", auth, updatePassword);
router.post("/image", auth, avatarUpload.single("profileImage"), uploadProfileImage);
router.put("/2fa", auth, updateTwoFactor);
router.post("/signout-all", auth, signOutAllDevices);

module.exports = router;
