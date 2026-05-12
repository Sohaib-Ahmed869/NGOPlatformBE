const cron = require("node-cron");
const Order = require("../models/order");
const orderController = require("../controllers/orderContrller");

/**
 * Job to process pending installment payments
 * Runs daily at midnight
 */
const setupInstallmentProcessingJob = () => {
  // Schedule the job to run daily at midnight
  cron.schedule("* * * * *", async () => {
    console.log("Running installment processing job");
    try {
      // Find all active installment orders with pending next payments
      const now = new Date();
      const orders = await Order.find({
        paymentType: "installments",
        "paymentStatus": "active", // Instead of "processing"
        "installmentDetails.nextInstallmentDate": { $lte: now },
      });

      console.log(`Found ${orders.length} installment orders to process`);

      // Process each order
      for (const order of orders) {
        try {
          await orderController.processNextInstallment(order._id);
        } catch (error) {
          console.error(
            `Error processing installment for order ${order._id}:`,
            error
          );
        }
      }

      console.log("Completed installment processing job");
    } catch (error) {
      console.error("Error in installment processing job:", error);
    }
  });

  console.log("Installment processing job scheduled");
};

module.exports = setupInstallmentProcessingJob;
