const mongoose = require('mongoose');
const slugify = require('slugify');

const productSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true
    },
    slug: {
        type: String,
        unique: true,
        trim: true
    },
    description: {
        type: String,
        required: true
    },
    price: {
        type: Number,
        required: true,
        min: 0
    },
    category: {
        type: String,
        required: true,
        enum: ['education', 'food', 'emergencies', 'water'],
        default: 'general'
    },
    image: {
        type: String,
        required: true
    },
    imagePath: {
        type: String,
        required: false
    },
    isActive: {
        type: Boolean,
        default: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Create text index for search functionality
productSchema.index({ title: 'text', description: 'text' });

// Generate slug from title before saving
productSchema.pre('save', function(next) {
    if (this.isModified('title') || !this.slug) {
        const slug = slugify(this.title, { lower: true, strict: true });
        this.slug = `${slug}-${Date.now()}`;
    }
    next();
});

// Generate slug before update if title is modified
productSchema.pre('findOneAndUpdate', function(next) {
    const update = this.getUpdate();
    if (update.title) {
        const slug = slugify(update.title, { lower: true, strict: true });
        this.set({ slug: `${slug}-${Date.now()}` });
    }
    next();
});

const Product = mongoose.model('Product', productSchema);

module.exports = Product;
