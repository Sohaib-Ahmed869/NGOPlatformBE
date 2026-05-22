require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");
const errorHandler = require("./middleware/errorHandler");
const tenantMiddleware = require("./middleware/tenant");

// Import routes
const userRoutes = require("./routes/userRoutes");
const orderRoutes = require("./routes/orderRoutes");
const contactRoutes = require("./routes/contactRoutes");
const eventRoutes = require("./routes/eventRoutes");
const newsletterRoutes = require("./routes/newsletterRoutes");
const subscriptionRoutes = require("./routes/subscription");
const paymentMethodRoutes = require("./routes/paymentMethodRoutes");
const profileRoutes = require("./routes/profileRoutes");
const adminOrderRoutes = require("./routes/admin/order.routes");
const donorController = require("./controllers/admin/donorController");
const subscriptionRoutesAdmin = require("./routes/admin/subscription.routes");
const eventRoutesAdmin = require("./routes/admin/event.routes");
const joinRoutes = require("./routes/joinRoutes");
const newsLetter = require("./models/newsletter");
const productRoutes = require("./routes/productRoutes");
const donationtyperoute = require("./routes/donationtyperoute");
const programRoutes = require("./routes/programRoutes");
const brandingRoutes = require("./routes/brandingRoutes");

// SaaS & Super Admin routes
const saasRoutes = require("./routes/saas");
const saasWebhookRoutes = require("./routes/saas/webhooks");
const superAdminRoutes = require("./routes/superadmin");

const fs = require('fs');
const path = require('path');
const setupInstallmentProcessingJob = require("./jobs/processInstallments");
const {
  scheduleSubscriptionChecks,
} = require("./services/subscriptionScheduler");
const app = express();

const Order = require("./models/order");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// Connect to database
connectDB();
setupInstallmentProcessingJob();
scheduleSubscriptionChecks();

// CORS — dynamic origin to support tenant subdomains
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (server-to-server, Postman, etc.)
      if (!origin) return callback(null, true);

      // Dev: match any subdomain of localhost on common ports
      if (/^https?:\/\/([a-z0-9-]+\.)?charities.ltd$/.test(origin)) {
        return callback(null, true);
      }

      // Production: match any subdomain of CORS_DOMAIN
      if (process.env.CORS_DOMAIN) {
        const escaped = process.env.CORS_DOMAIN.replace(/\./g, '\\.');
        if (new RegExp(`^https://([a-z0-9-]+\\.)?${escaped}$`).test(origin)) {
          return callback(null, true);
        }
      }

      // Also allow explicit CLIENT_URL
      if (origin === process.env.CLIENT_URL) {
        return callback(null, true);
      }

      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS' ,'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Slug']
  })
);

// SaaS webhook route — needs raw body for Stripe signature verification
// Must be registered BEFORE express.json()
app.use('/api/saas/webhooks', express.raw({ type: 'application/json' }), saasWebhookRoutes);

// JSON body parser with raw body preservation for existing donation webhooks
app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl.includes('/webhook')) {
      req.rawBody = buf;
    }
  }
}));

app.get("/", (req, res) => {
  res.send("API is running...");
});

// Ensure uploads directory exists
const uploadsBaseDir = path.join(__dirname, 'public/uploads');
const uploadsProductsDir = path.join(uploadsBaseDir, 'products');

[uploadsBaseDir, uploadsProductsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Make uploads directory publicly accessible
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads'), {
  setHeaders: (res, path) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));

// ============================================================
// NON-TENANT ROUTES (no org context needed)
// ============================================================
app.use("/api/users", userRoutes);
app.use("/api/saas", saasRoutes);
app.use("/api/superadmin", superAdminRoutes);

// Public SaaS contact form (no auth) — only for requests WITHOUT a tenant slug
const superAdminController = require("./controllers/superAdminController");
app.post("/api/contact", (req, res, next) => {
  // If the request has a tenant slug header, skip this handler and let the tenant router handle it
  if (req.headers["x-tenant-slug"]) return next();
  superAdminController.submitContactQuery(req, res, next);
});

// ============================================================
// TENANT-SCOPED ROUTES (tenant middleware resolves org from subdomain/header)
// ============================================================
const tenantRouter = express.Router();
tenantRouter.use(tenantMiddleware);

tenantRouter.use("/api/orders", orderRoutes);
tenantRouter.use("/api/contact", contactRoutes);
tenantRouter.use("/api/events", eventRoutes);
tenantRouter.use("/api/newsletter", newsletterRoutes);
tenantRouter.use("/api/subscriptions", subscriptionRoutes);
tenantRouter.use("/api/payment-methods", paymentMethodRoutes);
tenantRouter.use("/api/profile", profileRoutes);
tenantRouter.use("/api/admin/orders", adminOrderRoutes);
tenantRouter.use("/api/admin/donors", donorController);
tenantRouter.use("/api/admin/subscriptions", subscriptionRoutesAdmin);
tenantRouter.use("/api/admin/events", eventRoutesAdmin);
tenantRouter.use("/api/join", joinRoutes);
tenantRouter.use("/api/products", productRoutes);
tenantRouter.use("/api/donationtypes", donationtyperoute);
tenantRouter.use("/api/programs", programRoutes);
tenantRouter.use("/api/branding", brandingRoutes);
tenantRouter.use("/api/settings", require("./routes/settingsRoutes"));

// Inline newsletter routes (tenant-scoped)
tenantRouter.post("/api/newsletter", async (req, res) => {
  const { email } = req.body;
  const orgId = req.organisation?._id || null;
  const existingSubscriber = await newsLetter.findOne({ email, organisationId: orgId });
  if (existingSubscriber) {
    return res.status(400).json({ message: "You are already subscribed" });
  }
  const subscriber = await newsLetter.create({ email, organisationId: orgId });
  subscriber.save();
  return res
    .status(201)
    .json({ message: "You have been subscribed successfully" });
});
tenantRouter.get("/api/newsletters", async (req, res) => {
  const filter = {};
  if (req.organisation?._id) filter.organisationId = req.organisation._id;
  const subscribers = await newsLetter.find(filter);
  res.json(subscribers);
});

app.use(tenantRouter);

// Error handling
app.use(errorHandler);

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
