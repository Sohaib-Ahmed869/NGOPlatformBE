const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const admin = require('../middleware/admin');
const { productUpload } = require('../config/s3');
const {
    createProduct,
    getProducts,
    getProductsAdmin,
    getProductById,
    updateProduct,
    deleteProduct,
    getCategories
} = require('../controllers/productController');

// Admin — all products incl. inactive (declared before the public `/:id` route)
router.get('/admin/all', protect, admin, getProductsAdmin);

// Public routes
router.get('/', getProducts);
router.get('/categories', getCategories);
router.get('/:id', getProductById);

// Protected Admin routes
router.post('/', protect, admin, productUpload.single('image'), createProduct);
router.put('/:id', protect, admin, productUpload.single('image'), updateProduct);
router.delete('/:id', protect, admin, deleteProduct);

module.exports = router;
