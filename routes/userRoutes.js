// routes/userRoutes.js
const express = require("express");
const router = express.Router();
const userController = require("../controllers/userController");
const auth = require("../middleware/auth");

router.post("/register", userController.register);
router.post("/login", userController.login);
router.post("/registerAdmin", userController.registerAdmin);
router.post("/loginAdmin", userController.loginAdmin);
router.post("/forgot-password", userController.forgotPassword);
router.post("/reset-password/:token", userController.resetPassword);
router.post("/auth/google", userController.googleAuth);

router.get("/me", auth, userController.getMe);
router.get("/check-password-status", auth, userController.checkPasswordStatus);
router.put("/update", auth, userController.updateUser);
router.put("/update-password", auth, userController.updatePassword);

router.get("/instagram-feed",userController.instagramFeed)
module.exports = router;
 