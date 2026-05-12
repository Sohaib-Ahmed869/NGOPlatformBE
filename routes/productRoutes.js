const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const admin = require('../middleware/admin');
const { productUpload } = require('../config/s3');
const {
    createProduct,
    getProducts,
    getProductById,
    updateProduct,
    deleteProduct,
    getCategories
} = require('../controllers/productController');

// Public routes
router.get('/', getProducts);
router.get('/categories', getCategories);
router.get('/:id', getProductById);

// Protected Admin routes
router.post('/', protect, admin, productUpload.single('image'), createProduct);
router.put('/:id', protect, admin, productUpload.single('image'), updateProduct);
router.delete('/:id', protect, admin, deleteProduct);

module.exports = router;
