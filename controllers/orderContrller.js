// controllers/orderController.js
const Order = require("../models/order");
const User = require("../models/user");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { sendReceiptEmail } = require("../services/recieptUtils");
const { sendEmail } = require("../services/emailUtil");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { upload } = require("../config/s3");
const path = require("path");
const axios = require("axios");

/**
 * Creates a user account for anonymous donors and sends credentials email
 * @param {Object} donorDetails - Donor information from the order
 * @param {String} donationId - The donation ID to include in the email
 * @returns {Object} The created user or null if creation failed
 */
const createUserForDonor = async (donorDetails, donationId) => {
  try {
    // Check if user with this email already exists
    const existingUser = await User.findOne({ email: donorDetails.email });

    if (existingUser) {
      console.log(
        `User with email ${donorDetails.email} already exists, skipping creation`
      );
      return existingUser;
    }

    // Generate a random password
    const password = crypto.randomBytes(8).toString("hex");

    const hashedPassword = await bcrypt.hash(password, 10);
    // Create new user
    const newUser = new User({
      email: donorDetails.email,
      password: hashedPassword,
      name: donorDetails.name,
      phone: donorDetails.phone,
      role: "user",
      isTemporaryPassword: true, // Mark as temporary password that needs to be changed on first login
    });

    // Save the user
    await newUser.save();
    console.log(`Created new user account for donor: ${donorDetails.email}`);

    // Send welcome email with credentials
    const loginUrl = "https://shahidafridifoundation.org.au/login";

    const emailSubject =
      "Welcome to Shahid Afridi Foundation - Your Account Details";
    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px;">
      
        
        <h2 style="color: #4CAF50; text-align: center;">Thank You for Your Donation!</h2>
        
        <p>Dear ${donorDetails.name},</p>
        
        <p>Thank you for your generous donation (ID: <strong>${donationId}</strong>) to the Shahid Afridi Foundation. Your contribution will help us make a meaningful difference in the lives of those in need.</p>
        
        <p>We've created an account for you so you can easily track your donations and manage your giving in the future.</p>
        
        <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p><strong>Your Account Details:</strong></p>
          <p>Email: ${donorDetails.email}</p>
          <p>Password: ${password}</p>
          <p style="font-size: 12px; color: #666;">Please keep this information secure. We recommend changing your password after your first login.</p>
        </div>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${loginUrl}" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 4px; font-weight: bold;">Login to Your Account</a>
        </div>
        
        <p>If you have any questions or need assistance, please don't hesitate to contact our team.</p>
        
        <p>Warm regards,<br>The Shahid Afridi Foundation Team</p>
        
        <div style="font-size: 12px; color: #666; border-top: 1px solid #e0e0e0; margin-top: 20px; padding-top: 20px;">
          <p>This is an automated email. Please do not reply to this message.</p>
        </div>
      </div>
    `;

    await sendEmail(donorDetails.email, emailBody, emailSubject);
    console.log(`Sent welcome email to: ${donorDetails.email}`);

    return newUser;
  } catch (error) {
    console.error("Error creating user for donor:", error);
    return null;
  }
};
/**
 * Generates a unique donation ID with optional user donor prefix
 * @param {Object} user - The user object (optional)
 * @returns {string} - Unique donation ID in format: UUUUNNNN where U=User ID digits, N=Random number
 */
const generateDonationId = (user = null) => {
  const date = new Date();

  // Generate the user/donor prefix (4 characters)
  let userPrefix = "";

  if (user && user._id) {
    // If user exists, use the last 4 characters of their ID
    const userId = user._id.toString();
    userPrefix = userId.substring(Math.max(0, userId.length - 4));
  } else {
    // Otherwise, generate 4 random characters
    userPrefix = Math.floor(1000 + Math.random() * 9000).toString();
  }

  // Generate 4 random digits for the donation part
  const randomNum = Math.floor(1000 + Math.random() * 9000).toString();

  // Combine to create full donation ID
  return `${userPrefix}${randomNum}`;
};

/**
 * Generates a donation ID with a retry mechanism in case of collision
 * @param {Function} checkExistsFn - Function that checks if ID exists, returns Promise<boolean>
 * @param {Object} user - The user object (optional)
 * @param {number} maxRetries - Maximum number of retry attempts
 * @returns {Promise<string>} - A unique donation ID
 */
const generateUniqueDonationId = async (
  checkExistsFn,
  user = null,
  maxRetries = 3
) => {
  let retries = 0;

  while (retries < maxRetries) {
    const donationId = generateDonationId(user);

    // Check if this ID already exists
    const exists = await checkExistsFn(donationId);

    if (!exists) {
      return donationId;
    }

    retries++;
  }

  throw new Error(
    "Failed to generate unique donation ID after multiple attempts"
  );
};

// const calculateBillingAnchor = (billingDay) => {
//   const today = new Date();
//   // Normalize billing day to valid range for month
//   const currentMonth = today.getMonth();
//   const currentYear = today.getFullYear();
//   const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
//   const normalizedBillingDay = Math.min(billingDay, daysInMonth);

//   // Create date for this month's billing day
//   let billingDate = new Date(currentYear, currentMonth, normalizedBillingDay);

//   // If the billing day has already passed this month, move to next month
//   if (today > billingDate) {
//     billingDate.setMonth(billingDate.getMonth() + 1);
//     // Adjust for different month lengths
//     const nextMonthDays = new Date(
//       billingDate.getFullYear(),
//       billingDate.getMonth() + 1,
//       0
//     ).getDate();
//     billingDate.setDate(Math.min(normalizedBillingDay, nextMonthDays));
//   }

//   return Math.floor(billingDate.getTime() / 1000);
// };
const calculateBillingAnchor = (billingDay) => {
  const today = new Date();
  const currentMonth = today.getMonth();
  const currentYear = today.getFullYear();
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  const normalizedBillingDay = Math.min(billingDay, daysInMonth);

  // Create date for this month's billing day
  let billingDate = new Date(currentYear, currentMonth, normalizedBillingDay);

  // If the billing day has already passed this month, move to next month
  if (today.getDate() >= normalizedBillingDay) {
    billingDate.setMonth(billingDate.getMonth() + 1);
    // Adjust for different month lengths
    const nextMonthDays = new Date(
      billingDate.getFullYear(),
      billingDate.getMonth() + 1,
      0
    ).getDate();
    billingDate.setDate(Math.min(normalizedBillingDay, nextMonthDays));
  }

  // FIXED: Ensure the billing date is not more than 1 month from now
  const maxAllowedDate = new Date(today);
  maxAllowedDate.setMonth(maxAllowedDate.getMonth() + 1);
  maxAllowedDate.setDate(today.getDate()); // Keep the same day of month

  if (billingDate > maxAllowedDate) {
    // If calculated date is too far, use next month on the same day as today
    billingDate = new Date(today);
    billingDate.setMonth(billingDate.getMonth() + 1);
  }

  // Additional safety check: ensure billing date is not more than 31 days from now
  const maxDaysFromNow = 31;
  const maxTimestamp = today.getTime() + maxDaysFromNow * 24 * 60 * 60 * 1000;

  if (billingDate.getTime() > maxTimestamp) {
    // Fallback: use exactly 30 days from now
    billingDate = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
  }

  console.log(`Billing anchor calculation:
    Today: ${today.toISOString()}
    Requested billing day: ${billingDay}
    Calculated billing date: ${billingDate.toISOString()}
    Unix timestamp: ${Math.floor(billingDate.getTime() / 1000)}
  `);

  return Math.floor(billingDate.getTime() / 1000);
};
const sendBankTransferPendingEmail = async (order) => {
  try {
    // Get user from the order
    const user = await User.findById(order.user);
    if (!user || !user.email) {
      console.error("Missing user or user email for order:", order.donationId);
      return;
    }

    console.log(
      "Attempting to send bank transfer pending email to:",
      user.email
    );

    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="text-align: center; padding: 20px 0;">
          <img src="https://safimages.s3.ap-southeast-2.amazonaws.com/events/Screenshot+2025-02-27+014744.png" alt="Shahid Afridi Foundation" style="max-width: 150px;">
        </div>
        
        <h2 style="color: #4a7c59;">Bank Transfer Donation Pending</h2>
        
        <p>Dear ${user.name},</p>
        
        <p>Thank you for your generous donation to the Shahid Afridi Foundation. Your donation is currently pending approval.</p>
        
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Donation Details:</h3>
          <p><strong>Donation ID:</strong> ${order.donationId}</p>
          <p><strong>Date:</strong> ${new Date(
            order.createdAt
          ).toLocaleDateString()}</p>
          <p><strong>Amount:</strong> $${order.totalAmount.toFixed(2)} AUD</p>
        </div>

        <div style="background-color: #fffaed; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #ffc107;">
          <h3 style="margin-top: 0; color: #856404;">Next Steps:</h3>
          <p>To complete your donation, please either:</p>
          <ol style="padding-left: 20px;">
            <li>Upload proof of payment through our website using your donation ID: ${
              order.donationId
            }</li>
            <li>Email your payment proof to: info@ShahidAfridiFoundation.org.au</li>
          </ol>
          <p>Your donation will be processed once we receive and verify your payment proof.</p>
        </div>
        
        <p>Thank you for your support!</p>
      </div>
    `;

    const result = await sendEmail(
      user.email,
      emailBody,
      "Bank Transfer Donation Pending - Shahid Afridi Foundation"
    );

    if (!result.success) {
      console.error(
        "Failed to send bank transfer pending email:",
        result.error
      );
      console.error("Email details:", {
        to: user.email,
        subject: "Bank Transfer Donation Pending - Shahid Afridi Foundation",
        donationId: order.donationId,
      });
    } else {
      console.log(
        "Bank transfer pending email sent successfully to:",
        user.email
      );
    }
  } catch (error) {
    console.error("Error sending bank transfer pending email:", error);
    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
      donationId: order.donationId,
    });
  }
};

const sendCancellationRequestEmail = async (order) => {
  try {
    // Get user from the order
    const user = await User.findById(order.user);
    if (!user || !user.email) {
      console.error("Missing user or user email for order:", order.donationId);
      return;
    }

    // Send email to admin
    const adminEmailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #4a7c59;">Subscription Cancellation Request</h2>
        
        <p>A donor has requested to cancel their recurring donation.</p>
        
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Donation Details:</h3>
          <p><strong>Donation ID:</strong> ${order.donationId}</p>
          <p><strong>Donor Name:</strong> ${user.name}</p>
          <p><strong>Donor Email:</strong> ${user.email}</p>
          <p><strong>Amount:</strong> $${order.totalAmount.toFixed(2)} AUD</p>
          <p><strong>Frequency:</strong> ${order.recurringDetails.frequency}</p>
          <p><strong>Start Date:</strong> ${new Date(
            order.recurringDetails.startDate
          ).toLocaleDateString()}</p>
        </div>

        <p>Please review this request and take appropriate action through the admin panel.</p>
      </div>
    `;

    await sendEmail(
      "info@shahidafridifoundation.org.au",
      //THIS IS MARYAM'S EMAIL FOR TESTING
      // Use the actual admin email here

      //info@shahidafridifoundation.org.au is the actual admin email
      adminEmailBody,
      "Subscription Cancellation Request - Shahid Afridi Foundation"
    );

    // Send confirmation email to donor
    const donorEmailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #4a7c59;">Cancellation Request Received</h2>
        
        <p>Dear ${user.name},</p>
        
        <p>We have received your request to cancel your recurring donation.</p>
        
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Donation Details:</h3>
          <p><strong>Donation ID:</strong> ${order.donationId}</p>
          <p><strong>Amount:</strong> $${order.totalAmount.toFixed(2)} AUD</p>
          <p><strong>Frequency:</strong> ${order.recurringDetails.frequency}</p>
        </div>

        <p>Our admin team will review your request and process it accordingly. You will receive another email once the cancellation is confirmed.</p>
        
        <p>Thank you for your support!</p>
      </div>
    `;

    await sendEmail(
      user.email,
      donorEmailBody,
      "Cancellation Request Received - Shahid Afridi Foundation"
    );

    console.log(
      `Cancellation request emails sent for order: ${order.donationId}`
    );
  } catch (error) {
    console.error("Error sending cancellation request emails:", error);
  }
};

exports.requestCancellation = async (req, res) => {
  try {
    const { donationId } = req.params;
    const order = await Order.findOne({ donationId });

    if (!order) {
      return res.status(404).json({
        status: "Error",
        message: "Donation not found",
      });
    }

    // Check if this is a recurring donation
    if (order.paymentType !== "recurring") {
      return res.status(400).json({
        status: "Error",
        message: "Only recurring donations can be cancelled",
      });
    }

    // Check if already pending cancellation
    if (order.paymentStatus === "pending_cancellation") {
      return res.status(400).json({
        status: "Error",
        message: "Cancellation request already pending",
      });
    }

    // Update order status to pending cancellation
    order.paymentStatus = "pending_cancellation";
    await order.save();

    // Send cancellation request emails
    await sendCancellationRequestEmail(order);

    res.json({
      status: "Success",
      message: "Cancellation request submitted successfully",
      order: {
        donationId: order.donationId,
        paymentStatus: order.paymentStatus,
      },
    });
  } catch (error) {
    console.error("Error processing cancellation request:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to process cancellation request",
      error: error.message,
    });
  }
};

exports.createOrder = async (req, res) => {
  try {
    const {
      items,
      paymentType,
      adminCostContribution,
      donorDetails,
      paymentMethod,
      totalAmount,
      recurringDetails,
      installmentDetails,
      stripePaymentMethodId,
      updateUserDetails,
      donationType,
    } = req.body;

    console.log("Received order data:", req.body);

    // Validate required fields
    if (!items || !paymentType || !donorDetails) {
      return res.status(400).json({
        status: "Error",
        message: "Missing required fields",
      });
    }

    // Get user from request (populated by auth middleware)
    const user = req.user;

    // Update user details if needed
    if (user && (updateUserDetails || donorDetails.rememberDetails)) {
      try {
        const userUpdates = {
          name: donorDetails.name,
          phone: donorDetails.phone,
        };
        await User.findByIdAndUpdate(user._id, userUpdates);
        console.log(`Updated user details for user ${user._id}`);
      } catch (userUpdateError) {
        console.error("Error updating user details:", userUpdateError);
        // Don't fail the order if user update fails
      }
    }

    // Generate unique donation ID with user info
    const donationId = await generateUniqueDonationId(async (id) => {
      const existingOrder = await Order.findOne({ donationId: id });
      return !!existingOrder;
    }, user);

    // Validate recurring payment details if applicable
    if (paymentType === "recurring") {
      if (!recurringDetails || !recurringDetails.frequency) {
        return res.status(400).json({
          status: "Error",
          message: "Recurring payment requires frequency",
        });
      }
      const validFrequencies = ["daily", "weekly", "monthly", "yearly"];
      if (!validFrequencies.includes(recurringDetails.frequency)) {
        return res.status(400).json({
          status: "Error",
          message: "Invalid frequency for recurring payment",
        });
      }
    }

    // Validate installment payment details if applicable
    if (paymentType === "installments") {
      if (
        !installmentDetails ||
        !installmentDetails.numberOfInstallments ||
        !installmentDetails.installmentAmount
      ) {
        return res.status(400).json({
          status: "Error",
          message:
            "Installment payment requires numberOfInstallments and installmentAmount",
        });
      }
      if (
        installmentDetails.numberOfInstallments < 1 ||
        installmentDetails.numberOfInstallments > 12
      ) {
        return res.status(400).json({
          status: "Error",
          message: "Number of installments must be between 1 and 12",
        });
      }
    }

    console.log("Donor Details", donorDetails);

    // Update donor details if needed
    if (donorDetails.rememberDetails && user) {
      await User.findByIdAndUpdate(user._id, {
        name: donorDetails.name,
        phone: donorDetails.phone,
        email: donorDetails.email,
      });
    }
    console.log("Donor Details2", donorDetails);

    // Process items array
    const processedItems = items.map((item) => ({
      title: item.title,
      price: item.price,
      quantity: item.quantity || 1,
      onBehalfOf: item.onBehalfOf || null,
    }));

    // Capture the current day for recurring billing
    const today = new Date();
    const billingDay = today.getDate();

    // Build recurring details only if paymentType is "recurring"
    let orderRecurringDetails;
    if (paymentType === "recurring") {
      orderRecurringDetails = {
        frequency: recurringDetails.frequency,
        amount: totalAmount, // Use the full donation amount instead of partial
        startDate: new Date(),
        endDate: recurringDetails.endDate
          ? new Date(recurringDetails.endDate)
          : null,
        status: "active",
        nextPaymentDate: calculateNextPaymentDate(
          new Date(),
          recurringDetails.frequency,
          billingDay // Pass billing day to function
        ),
        billingDay: billingDay, // Store the billing day
        totalPayments: 0,
        paymentHistory: [],
      };
    }

    // Build installment details only if paymentType is "installments"
    let orderInstallmentDetails;
    if (paymentType === "installments") {
      const paymentIntervalDays = 30;
      orderInstallmentDetails = {
        numberOfInstallments: installmentDetails.numberOfInstallments,
        installmentAmount: installmentDetails.installmentAmount,
        startDate: new Date(),
        status: "active",
        installmentsPaid: 0,
        nextInstallmentDate: new Date(),
        installmentHistory: [],
        paymentIntervalDays: paymentIntervalDays,
      };
    }

    // Build the order object conditionally.
    // Note: If paymentType is not "recurring" or "installments", we explicitly set those keys to undefined.
    const orderObj = {
      user: user ? user._id : null,
      donationId,
      items: processedItems,
      paymentType,
      adminCostContribution: {
        included: !!adminCostContribution,
        amount: adminCostContribution || 0,
      },
      donorDetails: {
        name: donorDetails.name,
        phone: donorDetails.phone,
        email: donorDetails.email,
        address: {
          street: donorDetails.streetAddress,
          city: donorDetails.townCity,
          state: donorDetails.state,
          postcode: donorDetails.postcode,
        },
        agreeToMessages: donorDetails.agreeToMessages,
      },
      donationType: req.body.donationType,
      paymentMethod,
      paymentStatus: paymentMethod === "bank" ? "pending" : "processing",
      totalAmount,
      transactionDetails: {},
      recurringDetails:
        paymentType === "recurring" ? orderRecurringDetails : undefined,
      installmentDetails:
        paymentType === "installments" ? orderInstallmentDetails : undefined,
    };

    // Create the order using the conditionally built object
    const order = new Order(orderObj);

    // Save order with a retry mechanism in case of donationId collision
    let savedOrder = null;
    let retries = 3;
    while (retries > 0) {
      try {
        savedOrder = await order.save();
        break;
      } catch (error) {
        if (
          error.code === 11000 &&
          error.keyPattern &&
          error.keyPattern.donationId
        ) {
          order.donationId = `D${Date.now()}${Math.floor(Math.random() * 10000)
            .toString()
            .padStart(4, "0")}`;
          retries--;
        } else {
          throw error;
        }
      }
    }

    if (!savedOrder) {
      throw new Error(
        "Failed to generate unique donation ID after multiple attempts"
      );
    }

    console.log("Order saved:", savedOrder);

    // If no user exists and donor email is provided, create a new user for the donor
    if (!user && donorDetails.email) {
      try {
        const newUser = await createUserForDonor(
          donorDetails,
          savedOrder.donationId
        );
        if (newUser) {
          savedOrder.user = newUser._id;
          await savedOrder.save();
          console.log(
            `Linked order ${savedOrder._id} to new user ${newUser._id}`
          );
        }
      } catch (userCreateError) {
        console.error(
          "Failed to create user account for donor:",
          userCreateError
        );
      }
    }

    // Process payment with Stripe if a card is selected (visa or mastercard)
    if (
      (paymentMethod === "visa" || paymentMethod === "mastercard") &&
      stripePaymentMethodId
    ) {
      try {
        if (paymentType === "single") {
          // Process one-time payment
          const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(totalAmount * 100),
            currency: "aud",
            payment_method: stripePaymentMethodId,
            confirm: true,
            off_session: true,
            description: `Donation ${savedOrder.donationId}`,
            metadata: {
              donationId: savedOrder.donationId,
              orderId: savedOrder._id.toString(),
            },
          });

          savedOrder.transactionDetails = {
            stripePaymentMethodId,
            stripePaymentIntentId: paymentIntent.id,
            stripeStatus: paymentIntent.status,
            clientSecret: paymentIntent.client_secret,
          };

          if (paymentIntent.status === "succeeded") {
            try {
              await sendReceiptEmail(savedOrder);
            } catch (emailError) {
              console.error("Failed to send receipt email:", emailError);
            }
            savedOrder.paymentStatus = "completed";
          } else if (paymentIntent.status === "failed") {
            savedOrder.paymentStatus = "failed";
          }

          await savedOrder.save();
        } else if (paymentType === "recurring") {
          // Recurring payment processing
          let customer;
          try {
            const paymentMethodObj = await stripe.paymentMethods.retrieve(
              stripePaymentMethodId
            );
            if (paymentMethodObj.customer) {
              console.log(
                `Payment method ${stripePaymentMethodId} is already attached to customer ${paymentMethodObj.customer}`
              );
              customer = await stripe.customers.retrieve(
                paymentMethodObj.customer
              );
              console.log(`Using existing customer ${customer.id}`);
            } else {
              customer = await stripe.customers.create({
                email: donorDetails.email,
                name: donorDetails.name,
                phone: donorDetails.phone,
              });
              console.log(`Created new customer ${customer.id}`);
              await stripe.paymentMethods.attach(stripePaymentMethodId, {
                customer: customer.id,
              });
              console.log(
                `Attached payment method ${stripePaymentMethodId} to customer ${customer.id}`
              );
            }

            await stripe.customers.update(customer.id, {
              invoice_settings: {
                default_payment_method: stripePaymentMethodId,
              },
            });
            console.log(
              `Set payment method ${stripePaymentMethodId} as default for customer ${customer.id}`
            );
          } catch (stripeError) {
            console.error("Error handling payment method:", stripeError);
            if (
              stripeError.code === "payment_method_in_use" ||
              stripeError.message.includes("already been attached")
            ) {
              try {
                console.log("Handling 'already attached' error");
                const paymentMethodObj = await stripe.paymentMethods.retrieve(
                  stripePaymentMethodId
                );
                if (paymentMethodObj.customer) {
                  customer = await stripe.customers.retrieve(
                    paymentMethodObj.customer
                  );
                  console.log(
                    `Using existing customer ${customer.id} that payment method is attached to`
                  );
                } else {
                  throw new Error(
                    "Payment method is reported as already attached but no customer found"
                  );
                }
              } catch (secondError) {
                console.error("Error in special handling:", secondError);
                throw secondError;
              }
            } else {
              throw stripeError;
            }
          }

          let interval;
          switch (recurringDetails.frequency) {
            case "daily":
              interval = "day";
              break;
            case "weekly":
              interval = "week";
              break;
            case "monthly":
              interval = "month";
              break;
            case "yearly":
              interval = "year";
              break;
            default:
              interval = "month";
          }

          const product = await stripe.products.create({
            name: "Recurring Donation",
            metadata: { donationId: savedOrder.donationId },
          });
          console.log(`Created product for recurring donation: ${product.id}`);

          // Create subscription with billing cycle anchor for consistent monthly charging
          let subscriptionData = {
            customer: customer.id,
            items: [
              {
                price_data: {
                  currency: "aud",
                  product: product.id,
                  unit_amount: Math.round(totalAmount * 100), // Use the FULL totalAmount
                  recurring: {
                    interval: interval,
                    interval_count: 1,
                  },
                },
              },
            ],
            payment_settings: {
              save_default_payment_method: "on_subscription",
              payment_method_types: ["card"],
            },
            default_payment_method: stripePaymentMethodId,
            expand: ["latest_invoice.payment_intent"],
            proration_behavior: "none",
          };

          if (recurringDetails.endDate) {
            const cancelAtTimestamp = Math.floor(
              new Date(recurringDetails.endDate).getTime() / 1000
            );
            subscriptionData.cancel_at = cancelAtTimestamp;
            console.log(
              `Subscription will cancel at ${recurringDetails.endDate}`
            );
          }

          const subscription = await stripe.subscriptions.create({
            customer: customer.id,
            items: [
              {
                price_data: {
                  currency: "aud",
                  product: product.id,
                  unit_amount: Math.round(totalAmount * 100),
                  recurring: {
                    interval: interval,
                    interval_count: 1,
                    // Remove the usage_type that's causing the error
                  },
                },
              },
            ],
            payment_settings: {
              save_default_payment_method: "on_subscription",
              payment_method_types: ["card"],
            },
            default_payment_method: stripePaymentMethodId,
            expand: ["latest_invoice.payment_intent"],
            // Removed billing_cycle_anchor to allow immediate first payment
            proration_behavior: "none",
            // Add metadata to track billing day
            ...(recurringDetails.endDate
              ? {
                  cancel_at: Math.floor(
                    new Date(recurringDetails.endDate).getTime() / 1000
                  ),
                }
              : {}),
            metadata: {
              billingDay: billingDay.toString(),
              donationId: savedOrder.donationId,
            },
          });
          console.log(
            `Created subscription: ${subscription.id} for customer ${customer.id}, status: ${subscription.status}`
          );

          savedOrder.transactionDetails = {
            stripeCustomerId: customer.id,
            stripeSubscriptionId: subscription.id,
            stripeStatus: subscription.status,
            clientSecret:
              subscription.latest_invoice?.payment_intent?.client_secret ||
              null,
          };

          if (subscription.status === "active") {
            savedOrder.paymentStatus = "active";

            // Check if the first invoice was paid
            let firstInvoicePaid = false;
            let paymentIntent = subscription.latest_invoice?.payment_intent;

            if (paymentIntent && paymentIntent.status === "succeeded") {
              firstInvoicePaid = true;
            } else if (
              subscription.latest_invoice &&
              paymentIntent &&
              paymentIntent.status !== "succeeded"
            ) {
              // Attempt to pay the invoice immediately if not already paid
              try {
                const paidInvoice = await stripe.invoices.pay(
                  subscription.latest_invoice.id
                );
                if (
                  paidInvoice.payment_intent &&
                  paidInvoice.payment_intent.status === "succeeded"
                ) {
                  paymentIntent = paidInvoice.payment_intent;
                  firstInvoicePaid = true;
                }
              } catch (payErr) {
                console.error(
                  "Failed to pay first recurring invoice immediately:",
                  payErr
                );
              }
            }

            if (firstInvoicePaid) {
              savedOrder.recurringDetails.totalPayments = 1;
              savedOrder.recurringDetails.lastPaymentDate = new Date();
              savedOrder.recurringDetails.paymentHistory = [
                {
                  date: new Date(),
                  amount: totalAmount,
                  invoiceId: subscription.latest_invoice.id,
                  status: "succeeded",
                },
              ];

              // Set next payment date using billing anchor for monthly
              if (interval === "month") {
                savedOrder.recurringDetails.nextPaymentDate = new Date(
                  calculateBillingAnchor(billingDay) * 1000
                );
              }

              try {
                await sendReceiptEmail(savedOrder);
              } catch (emailError) {
                console.error("Failed to send receipt email:", emailError);
              }
            }
          } else if (subscription.status === "incomplete") {
            savedOrder.paymentStatus = "pending";

            if (subscription.latest_invoice?.payment_intent) {
              try {
                const confirmedPI = await stripe.paymentIntents.confirm(
                  subscription.latest_invoice.payment_intent.id,
                  { payment_method: stripePaymentMethodId }
                );

                if (confirmedPI.status === "succeeded") {
                  const updatedSubscription =
                    await stripe.subscriptions.retrieve(subscription.id);
                  if (updatedSubscription.status === "active") {
                    savedOrder.paymentStatus = "active";
                    savedOrder.recurringDetails.totalPayments = 1;
                    savedOrder.recurringDetails.lastPaymentDate = new Date();
                    savedOrder.recurringDetails.paymentHistory = [
                      {
                        date: new Date(),
                        amount: totalAmount,
                        invoiceId: subscription.latest_invoice.id,
                        status: "succeeded",
                      },
                    ];

                    if (interval === "month") {
                      savedOrder.recurringDetails.nextPaymentDate = new Date(
                        calculateBillingAnchor(billingDay) * 1000
                      );
                    }

                    try {
                      await sendReceiptEmail(savedOrder);
                    } catch (emailError) {
                      console.error(
                        "Failed to send receipt email:",
                        emailError
                      );
                    }
                  }
                }
              } catch (confirmError) {
                console.error(
                  "Failed to confirm payment intent:",
                  confirmError
                );
              }
            }
          } else {
            savedOrder.paymentStatus = "pending";
          }

          await savedOrder.save();
        } else if (paymentType === "installments") {
          // Installment processing
          let customer;
          try {
            const paymentMethodObj = await stripe.paymentMethods.retrieve(
              stripePaymentMethodId
            );
            if (paymentMethodObj.customer) {
              console.log(
                `Payment method ${stripePaymentMethodId} is already attached to customer ${paymentMethodObj.customer}`
              );
              customer = await stripe.customers.retrieve(
                paymentMethodObj.customer
              );
              console.log(`Using existing customer ${customer.id}`);
            } else {
              customer = await stripe.customers.create({
                email: donorDetails.email,
                name: donorDetails.name,
                phone: donorDetails.phone,
              });
              console.log(`Created new customer ${customer.id}`);
              await stripe.paymentMethods.attach(stripePaymentMethodId, {
                customer: customer.id,
              });
              console.log(
                `Attached payment method ${stripePaymentMethodId} to customer ${customer.id}`
              );
            }

            await stripe.customers.update(customer.id, {
              invoice_settings: {
                default_payment_method: stripePaymentMethodId,
              },
            });
            console.log(
              `Set payment method ${stripePaymentMethodId} as default for customer ${customer.id}`
            );
          } catch (stripeError) {
            console.error("Error handling payment method:", stripeError);
            if (
              stripeError.code === "payment_method_in_use" ||
              stripeError.message.includes("already been attached")
            ) {
              try {
                console.log("Handling 'already attached' error");
                const paymentMethodObj = await stripe.paymentMethods.retrieve(
                  stripePaymentMethodId
                );
                if (paymentMethodObj.customer) {
                  customer = await stripe.customers.retrieve(
                    paymentMethodObj.customer
                  );
                  console.log(
                    `Using existing customer ${customer.id} that payment method is attached to`
                  );
                } else {
                  throw new Error(
                    "Payment method is reported as already attached but no customer found"
                  );
                }
              } catch (secondError) {
                console.error("Error in special handling:", secondError);
                throw secondError;
              }
            } else {
              throw stripeError;
            }
          }

          const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(installmentDetails.installmentAmount * 100),
            currency: "aud",
            customer: customer.id,
            payment_method: stripePaymentMethodId,
            automatic_payment_methods: {
              enabled: true,
              allow_redirects: "never",
            },
            confirm: true,
            off_session: true,
            description: `Installment 1/${installmentDetails.numberOfInstallments} for Donation ${savedOrder.donationId}`,
            metadata: {
              donationId: savedOrder.donationId,
              orderId: savedOrder._id.toString(),
              installment: 1,
              totalInstallments: installmentDetails.numberOfInstallments,
            },
          });

          console.log(`Created first installment payment: ${paymentIntent.id}`);

          savedOrder.transactionDetails = {
            stripeCustomerId: customer.id,
            stripePaymentIntentId: paymentIntent.id,
            stripeStatus: paymentIntent.status,
            clientSecret: paymentIntent.client_secret,
          };

          if (savedOrder.installmentDetails) {
            savedOrder.installmentDetails.installmentsPaid = 1;
            const paymentIntervalDays = 30;
            savedOrder.installmentDetails.nextInstallmentDate = new Date(
              Date.now() + paymentIntervalDays * 24 * 60 * 60 * 1000
            );
            savedOrder.installmentDetails.installmentHistory.push({
              installmentNumber: 1,
              amount: installmentDetails.installmentAmount,
              date: new Date(),
              status:
                paymentIntent.status === "succeeded"
                  ? "completed"
                  : "processing",
              transactionId: paymentIntent.id,
            });
          }

          if (paymentIntent.status === "succeeded") {
            try {
              await sendReceiptEmail(savedOrder);
            } catch (emailError) {
              console.error("Failed to send receipt email:", emailError);
            }
            savedOrder.paymentStatus = "active";
          } else if (paymentIntent.status === "requires_action") {
            savedOrder.paymentStatus = "failed";
          }

          await savedOrder.save();
        }
      } catch (stripeError) {
        console.error("Stripe payment error:", stripeError);
        savedOrder.paymentStatus = "failed";
        savedOrder.transactionDetails = { error: stripeError.message };
        await savedOrder.save();

        return res.status(400).json({
          status: "Error",
          message: `Payment processing failed: ${stripeError.message}`,
          order: { _id: savedOrder._id, donationId: savedOrder.donationId },
        });
      }
    }

    if (paymentMethod === "bank") {
      try {
        await sendBankTransferPendingEmail(savedOrder);
        console.log(
          `Bank transfer pending email sent for order: ${savedOrder.donationId}`
        );
      } catch (emailError) {
        console.error(
          "Failed to send bank transfer pending email:",
          emailError
        );
      }
    }

    res.status(201).json({
      status: "Success",
      message: "Order created successfully",
      order: {
        _id: savedOrder._id,
        donationId: savedOrder.donationId,
        totalAmount: savedOrder.totalAmount,
        paymentStatus: savedOrder.paymentStatus,
        recurringDetails:
          paymentType === "recurring" ? orderRecurringDetails : undefined,
        installmentDetails:
          paymentType === "installments" ? orderInstallmentDetails : undefined,
        transactionDetails: savedOrder.transactionDetails,
        paymentInstructions:
          paymentMethod === "bank"
            ? {
                bankName: "Westpac",
                bsb: "032075",
                accountNumber: "841783",
                reference: savedOrder.donationId,
              }
            : null,
      },
    });
  } catch (error) {
    console.error("Order creation error:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to create order",
      error: error.message,
    });
  }
};

exports.getOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .select("-__v");

    res.json({
      status: "Success",
      orders,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch orders",
      error: error.message,
    });
  }
};

exports.getOrderById = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).select("-__v");

    if (!order) {
      return res.status(404).json({
        status: "Error",
        message: "Order not found",
      });
    }

    // Check if user has access to this order
    if (order.user && order.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        status: "Error",
        message: "Not authorized to view this order",
      });
    }

    res.json({
      status: "Success",
      order,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch order",
      error: error.message,
    });
  }
};

exports.updateOrderStatus = async (req, res) => {
  try {
    const { paymentStatus, transactionDetails, recurringStatus } = req.body;
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        status: "Error",
        message: "Order not found",
      });
    }

    // Update payment status if provided
    if (paymentStatus) {
      order.paymentStatus = paymentStatus;
    }

    // Update transaction details if provided
    if (transactionDetails) {
      order.transactionDetails = transactionDetails;
    }

    // Handle recurring donations
    if (order.paymentType === "recurring") {
      // Initialize recurringDetails if it doesn't exist
      if (!order.recurringDetails) {
        order.recurringDetails = {
          status: "active", // Default status for new recurring donations
          startDate: new Date(),
          nextPaymentDate: calculateNextPaymentDate(new Date(), order.recurringDetails?.frequency || 'monthly')
        };
      }

      // Update recurring status if provided
      if (recurringStatus) {
        order.recurringDetails.status = recurringStatus;
      }

      // If this is a new approval, ensure the status is set to active
      if (paymentStatus === "completed" && !recurringStatus) {
        order.recurringDetails.status = "active";
      }
    }

    await order.save();

    // Create log entry
    await createLog("UPDATE", "ORDER", order._id, req.user, req, {
      paymentStatus,
      ...(recurringStatus && { recurringStatus }),
    });

    res.json({
      status: "Success",
      message: "Order status updated",
      order,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to update order status",
      error: error.message,
    });
  }
};

exports.getOrderStats = async (req, res) => {
  try {
    const userId = req.user._id;
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

    console.log("Getting order stats for user:", req.user);

    // Get all orders for the user
    const orders = await Order.find({ user: userId });

    // Filter out failed orders for all KPIs and calculations
    const validOrders = orders.filter(order => order.paymentStatus !== "failed");

    // Calculate total donated amount (including all installments and recurring payments)
    let totalDonated = 0;
    let paidDonated = 0; // Amount actually paid/received

    await Promise.all(
      validOrders.map(async (order) => {
        // For one-time payments, use the total amount
        if (order.paymentType === "single") {
          totalDonated += order.totalAmount;
          if (order.paymentStatus === "completed" || order.paymentStatus === "succeeded") {
            paidDonated += order.totalAmount;
          }
        }
        // For installments
        else if (order.paymentType === "installments" && order.installmentDetails) {
          // If cancelled, only count paid installments
          if (order.paymentStatus === "cancelled") {
            const paidInstallments = order.installmentDetails.installmentsPaid || 0;
            totalDonated += paidInstallments * order.installmentDetails.installmentAmount;
            paidDonated += paidInstallments * order.installmentDetails.installmentAmount;
          } else {
            // Total expected amount for installments
            const totalExpectedAmount = 
              order.installmentDetails.numberOfInstallments * 
              order.installmentDetails.installmentAmount;
            totalDonated += totalExpectedAmount;
            // Actually paid installments
            const paidInstallments = order.installmentDetails.installmentsPaid || 0;
            paidDonated += paidInstallments * order.installmentDetails.installmentAmount;
          }
        }
        // For recurring donations
        else if (order.paymentType === "recurring" && order.recurringDetails) {
          try {
            // If cancelled, only count what was actually paid
            if (order.paymentStatus === "cancelled") {
              let actuallyPaid = 0;
              if (
                order.transactionDetails?.stripeSubscriptionId &&
                (order.paymentMethod === "visa" || order.paymentMethod === "mastercard")
              ) {
                const invoices = await stripe.invoices.list({
                  subscription: order.transactionDetails.stripeSubscriptionId,
                  status: "paid",
                  limit: 100,
                });
                actuallyPaid = invoices.data.reduce(
                  (sum, invoice) => sum + invoice.amount_paid / 100,
                  0
                );
              } else if (
                order.recurringDetails.paymentHistory &&
                order.recurringDetails.paymentHistory.length > 0
              ) {
                actuallyPaid = order.recurringDetails.paymentHistory
                  .filter((payment) => payment.status === "succeeded")
                  .reduce((sum, payment) => sum + (payment.amount || 0), 0);
              } else {
                const totalPaymentsMade = order.recurringDetails.totalPayments || 0;
                actuallyPaid = totalPaymentsMade * order.recurringDetails.amount;
              }
              totalDonated += actuallyPaid;
              paidDonated += actuallyPaid;
            } else {
              // Calculate total expected amount based on frequency and duration
              const totalExpectedAmount = calculateRecurringTotalAmount(order);
              totalDonated += totalExpectedAmount;
              // Get actually paid amount
              let actuallyPaid = 0;
              if (
                order.transactionDetails?.stripeSubscriptionId &&
                (order.paymentMethod === "visa" || order.paymentMethod === "mastercard")
              ) {
                const invoices = await stripe.invoices.list({
                  subscription: order.transactionDetails.stripeSubscriptionId,
                  status: "paid",
                  limit: 100,
                });
                actuallyPaid = invoices.data.reduce(
                  (sum, invoice) => sum + invoice.amount_paid / 100,
                  0
                );
              } else if (
                order.recurringDetails.paymentHistory &&
                order.recurringDetails.paymentHistory.length > 0
              ) {
                actuallyPaid = order.recurringDetails.paymentHistory
                  .filter((payment) => payment.status === "succeeded")
                  .reduce((sum, payment) => sum + (payment.amount || 0), 0);
              } else if (
                order.paymentStatus === "active" ||
                order.paymentStatus === "completed" ||
                order.paymentStatus === "cancelled"
              ) {
                const totalPaymentsMade = order.recurringDetails.totalPayments || 0;
                actuallyPaid = totalPaymentsMade * order.recurringDetails.amount;
              }
              paidDonated += actuallyPaid;
            }
          } catch (stripeError) {
            console.error("Error fetching Stripe payment data:", stripeError);
            // Fallback for cancelled
            if (order.paymentStatus === "cancelled") {
              let actuallyPaid = 0;
              if (
                order.recurringDetails &&
                order.recurringDetails.paymentHistory
              ) {
                actuallyPaid = order.recurringDetails.paymentHistory
                  .filter((payment) => payment.status === "succeeded")
                  .reduce((sum, payment) => sum + (payment.amount || 0), 0);
              } else {
                const totalPaymentsMade = order.recurringDetails?.totalPayments || 0;
                actuallyPaid = totalPaymentsMade * (order.recurringDetails?.amount || 0);
              }
              totalDonated += actuallyPaid;
              paidDonated += actuallyPaid;
            } else {
              const totalExpectedAmount = calculateRecurringTotalAmount(order);
              totalDonated += totalExpectedAmount;
              let actuallyPaid = 0;
              if (
                order.recurringDetails &&
                order.recurringDetails.paymentHistory
              ) {
                actuallyPaid = order.recurringDetails.paymentHistory
                  .filter((payment) => payment.status === "succeeded")
                  .reduce((sum, payment) => sum + (payment.amount || 0), 0);
              } else if (order.paymentStatus !== "failed") {
                const totalPaymentsMade = order.recurringDetails?.totalPayments || 0;
                actuallyPaid = totalPaymentsMade * (order.recurringDetails?.amount || 0);
              }
              paidDonated += actuallyPaid;
            }
          }
        }
      })
    );

    // Use validOrders for all KPIs and stats
    const recurringOrders = validOrders.filter(
      (order) =>
        order.paymentType === "recurring" ||
        order.paymentType === "installments"
    );

    // Calculate active recurring (not failed or completed or cancelled)
    const activeRecurring = recurringOrders.filter(
      (order) =>
        order.paymentStatus === "active" || order.paymentStatus === "pending"
    ).length;

    // Count one-time donations
    const oneTimeOrders = validOrders.filter(
      (order) => order.paymentType === "single"
    );

    const stats = {
      totalDonated, // Total expected amount (including future recurring payments, but not for cancelled)
      paidDonated, // Amount actually received/paid
      activeRecurring,
      recurringCount: recurringOrders.length,
      oneTimeCount: oneTimeOrders.length,
      totalOrders: validOrders.length,
      // Additional stats
      completedOrders: validOrders.filter(
        (order) => order.paymentStatus === "completed"
      ).length,
      pendingOrders: validOrders.filter((order) => order.paymentStatus === "pending")
        .length,
      pendingAmount: validOrders.reduce((sum, order) => {
        // Exclude cancelled orders from pending calculation
        if (order.paymentStatus === "cancelled") {
          return sum;
        }
        // Add amount for pending orders
        if (order.paymentStatus === "pending") {
          return sum + order.totalAmount;
        }
        // Add remaining installment amounts for active installment orders
        if (
          order.paymentType === "installments" &&
          order.installmentDetails &&
          order.paymentStatus === "active" &&
          order.installmentDetails.status === "active"
        ) {
          const totalInstallments =
            order.installmentDetails.numberOfInstallments;
          const paidInstallments =
            order.installmentDetails.installmentsPaid || 0;
          const remainingInstallments = totalInstallments - paidInstallments;
          const installmentAmount = order.installmentDetails.installmentAmount;

          // Calculate remaining amount
          const remainingAmount = remainingInstallments * installmentAmount;
          return sum + remainingAmount;
        }
        // Add remaining recurring payments for active recurring orders
        if (
          order.paymentType === "recurring" &&
          order.recurringDetails &&
          order.paymentStatus === "active"
        ) {
          const totalExpectedAmount = calculateRecurringTotalAmount(order);
          const totalPaymentsMade = order.recurringDetails.totalPayments || 0;
          const paidAmount = totalPaymentsMade * order.recurringDetails.amount;
          const remainingAmount = Math.max(0, totalExpectedAmount - paidAmount);
          return sum + remainingAmount;
        }
        // Do NOT include cancelled subscriptions' future amounts
        return sum;
      }, 0),
      failedOrders: orders.filter((order) => order.paymentStatus === "failed")
        .length,
      cancelledOrders: validOrders.filter(
        (order) => order.paymentStatus === "cancelled"
      ).length,
      // Monthly stats
      monthlyStats: await getMonthlyStats(validOrders, stripe),
      // Add average donation
      averageDonation: validOrders.length > 0 ? Number((totalDonated / validOrders.length).toFixed(2)) : 0,
    };

    res.json({
      status: "Success",
      stats,
    });
  } catch (error) {
    console.error("Error getting order stats:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to get order statistics",
      error: error.message,
    });
  }
};

// Helper function to calculate total expected amount for recurring donations
const calculateRecurringTotalAmount = (order) => {
  if (!order.recurringDetails) return 0;

  const { amount, frequency, startDate, endDate } = order.recurringDetails;
  
  if (!startDate || !endDate) {
    // If no end date specified, just return the amount of payments made so far
    const totalPaymentsMade = order.recurringDetails.totalPayments || 0;
    return totalPaymentsMade * amount;
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  
  // Calculate total expected payments based on frequency
  let totalPayments = 0;
  
  switch (frequency.toLowerCase()) {
    case 'daily':
      totalPayments = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
      break;
    case 'weekly':
      totalPayments = Math.ceil((end - start) / (1000 * 60 * 60 * 24 * 7)) + 1;
      break;
    case 'monthly':
      const monthsDiff = (end.getFullYear() - start.getFullYear()) * 12 + 
                        (end.getMonth() - start.getMonth()) + 1;
      totalPayments = monthsDiff;
      break;
    case 'yearly':
      totalPayments = end.getFullYear() - start.getFullYear() + 1;
      break;
    default:
      // If frequency is not recognized, use totalPayments from order if available
      totalPayments = order.recurringDetails.totalPayments || 1;
  }

  return totalPayments * amount;
};

const getMonthlyStats = async (orders, stripe) => {
  const monthlyData = {};

  // First, process all orders
  for (const order of orders) {
    const initialDate = new Date(order.createdAt);
    const initialMonthYear = `${initialDate.getFullYear()}-${String(
      initialDate.getMonth() + 1
    ).padStart(2, "0")}`;

    if (!monthlyData[initialMonthYear]) {
      monthlyData[initialMonthYear] = {
        total: 0,
        count: 0,
        recurring: 0,
        oneTime: 0,
      };
    }

    // Always count the order itself in the creation month
    monthlyData[initialMonthYear].count += 1;

    // For one-time payments, add the full amount to the creation month
    if (order.paymentType === "single") {
      monthlyData[initialMonthYear].total += order.totalAmount;
      monthlyData[initialMonthYear].oneTime += 1;
    }
    // For recurring/installments, mark as recurring in the creation month
    else {
      monthlyData[initialMonthYear].recurring += 1;

      // Handle recurring payments by fetching Stripe data if possible
      if (
        order.paymentType === "recurring" &&
        order.transactionDetails?.stripeSubscriptionId &&
        (order.paymentMethod === "visa" || order.paymentMethod === "mastercard")
      ) {
        try {
          // Get all paid invoices for this subscription
          const invoices = await stripe.invoices.list({
            subscription: order.transactionDetails.stripeSubscriptionId,
            status: "paid",
            limit: 100,
          });

          // Process each invoice
          for (const invoice of invoices.data) {
            const paymentDate = new Date(
              invoice.status_transitions.paid_at * 1000
            );
            const paymentMonthYear = `${paymentDate.getFullYear()}-${String(
              paymentDate.getMonth() + 1
            ).padStart(2, "0")}`;

            if (!monthlyData[paymentMonthYear]) {
              monthlyData[paymentMonthYear] = {
                total: 0,
                count: 0,
                recurring: 0,
                oneTime: 0,
              };
            }

            monthlyData[paymentMonthYear].total += invoice.amount_paid / 100; // Convert from cents
          }
        } catch (stripeError) {
          console.error("Error fetching Stripe invoice data:", stripeError);

          // Fall back to local data - process each payment from paymentHistory
          if (order.recurringDetails && order.recurringDetails.paymentHistory) {
            order.recurringDetails.paymentHistory
              .filter((p) => p.status === "succeeded")
              .forEach((payment) => {
                const paymentDate = payment.date ? new Date(payment.date) : initialDate;
                const paymentMonthYear = `${paymentDate.getFullYear()}-${String(
                  paymentDate.getMonth() + 1
                ).padStart(2, "0")}`;

                if (!monthlyData[paymentMonthYear]) {
                  monthlyData[paymentMonthYear] = {
                    total: 0,
                    count: 0,
                    recurring: 0,
                    oneTime: 0,
                  };
                }

                monthlyData[paymentMonthYear].total += payment.amount;
              });
          }
        }
      }
      // Handle installment payments
      else if (
        order.paymentType === "installments" &&
        order.installmentDetails
      ) {
        // Process all installment payments based on their dates
        if (
          order.installmentDetails.installmentHistory &&
          order.installmentDetails.installmentHistory.length > 0
        ) {
          order.installmentDetails.installmentHistory
            .filter((h) => h.status === "completed")
            .forEach((installment) => {
              // Use installment date if available, otherwise use order creation date
              const paymentDate = installment.date
                ? new Date(installment.date)
                : initialDate;
              const paymentMonthYear = `${paymentDate.getFullYear()}-${String(
                paymentDate.getMonth() + 1
              ).padStart(2, "0")}`;

              if (!monthlyData[paymentMonthYear]) {
                monthlyData[paymentMonthYear] = {
                  total: 0,
                  count: 0,
                  recurring: 0,
                  oneTime: 0,
                };
              }

              monthlyData[paymentMonthYear].total += installment.amount;
            });
        } else {
          // If no installment history, just add first installment to creation month
          monthlyData[initialMonthYear].total +=
            order.installmentDetails.installmentAmount;
        }
      }
      // Fall back for recurring payments without Stripe ID
      else if (order.paymentType === "recurring" && order.recurringDetails) {
        if (
          order.recurringDetails.paymentHistory &&
          order.recurringDetails.paymentHistory.length > 0
        ) {
          order.recurringDetails.paymentHistory
            .filter((p) => p.status === "succeeded")
            .forEach((payment) => {
              const paymentDate = payment.date
                ? new Date(payment.date)
                : initialDate;
              const paymentMonthYear = `${paymentDate.getFullYear()}-${String(
                paymentDate.getMonth() + 1
              ).padStart(2, "0")}`;

              if (!monthlyData[paymentMonthYear]) {
                monthlyData[paymentMonthYear] = {
                  total: 0,
                  count: 0,
                  recurring: 0,
                  oneTime: 0,
                };
              }

              monthlyData[paymentMonthYear].total += payment.amount;
            });
        } else {
          // If no payment history, just add first payment to creation month
          monthlyData[initialMonthYear].total += order.recurringDetails.amount;
        }
      }
    }
  }

  // Convert to array and sort by date
  return Object.entries(monthlyData)
    .map(([month, data]) => ({
      month,
      ...data,
    }))
    .sort((a, b) => b.month.localeCompare(a.month));
};

const calculateNextPaymentDate = (startDate, frequency, billingDay = null) => {
  const nextDate = new Date(startDate);

  switch (frequency) {
    case "daily":
      nextDate.setDate(nextDate.getDate() + 1);
      break;
    case "weekly":
      nextDate.setDate(nextDate.getDate() + 7);
      break;
    case "monthly":
      // Move to next month
      nextDate.setMonth(nextDate.getMonth() + 1);

      // If billing day is specified, use that date instead of current day
      if (billingDay) {
        // Get days in the next month to handle edge cases (31st, 30th, etc.)
        const daysInMonth = new Date(
          nextDate.getFullYear(),
          nextDate.getMonth() + 1,
          0
        ).getDate();
        nextDate.setDate(Math.min(billingDay, daysInMonth));
      }
      break;
    case "yearly":
      nextDate.setFullYear(nextDate.getFullYear() + 1);
      break;
    default:
      nextDate.setMonth(nextDate.getMonth() + 1);
  }
  return nextDate;
};
/**
 * Process the next installment payment for an order
 * @param {string} orderId - The order ID to process the next installment for
 */
exports.processNextInstallment = async (orderId) => {
  try {
    const order = await Order.findById(orderId);

    if (!order) {
      console.error(`Order not found: ${orderId}`);
      return;
    }

    // Log the order transaction details for debugging
    console.log(
      `Processing order ${orderId} with transaction details:`,
      JSON.stringify(order.transactionDetails || {}, null, 2)
    );
    console.log(
      `Payment type: ${order.paymentType}, Payment method: ${order.paymentMethod}`
    );

    // Ensure this is an active installment order with remaining installments.
    if (
      order.paymentType !== "installments" ||
      !order.installmentDetails ||
      order.installmentDetails.status !== "active" ||
      order.installmentDetails.installmentsPaid >=
        order.installmentDetails.numberOfInstallments
    ) {
      console.log(`No installment to process for order: ${orderId}`);
      return;
    }

    // Check if it's time to process the next installment.
    const now = new Date();
    const nextDate = new Date(order.installmentDetails.nextInstallmentDate);
    if (now < nextDate) {
      console.log(`Not yet time for next installment for order: ${orderId}`);
      return;
    }

    const installmentNumber = order.installmentDetails.installmentsPaid + 1;
    console.log(
      `Processing installment ${installmentNumber}/${order.installmentDetails.numberOfInstallments} for order: ${orderId}`
    );

    // Check payment information and try to recover if missing
    if (
      !order.transactionDetails ||
      !order.transactionDetails.stripeCustomerId ||
      !order.transactionDetails.stripePaymentMethodId
    ) {
      console.error(`Missing payment method information for order: ${orderId}`);

      // If we have a customer ID but no payment method, try to get default payment method
      if (
        order.transactionDetails &&
        order.transactionDetails.stripeCustomerId
      ) {
        try {
          const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
          const customer = await stripe.customers.retrieve(
            order.transactionDetails.stripeCustomerId,
            { expand: ["default_source"] }
          );

          if (customer.default_source) {
            console.log(
              `Found default payment source for customer: ${customer.id}`
            );
            order.transactionDetails.stripePaymentMethodId =
              customer.default_source;
          } else if (
            customer.invoice_settings &&
            customer.invoice_settings.default_payment_method
          ) {
            console.log(
              `Found default payment method in invoice settings: ${customer.invoice_settings.default_payment_method}`
            );
            order.transactionDetails.stripePaymentMethodId =
              customer.invoice_settings.default_payment_method;
          } else {
            // Try to get the latest payment method
            const paymentMethods = await stripe.paymentMethods.list({
              customer: customer.id,
              type: "card",
              limit: 1,
            });

            if (paymentMethods.data.length > 0) {
              console.log(
                `Found payment method from list: ${paymentMethods.data[0].id}`
              );
              order.transactionDetails.stripePaymentMethodId =
                paymentMethods.data[0].id;
            }
          }

          // If we recovered a payment method, save it to the order
          if (order.transactionDetails.stripePaymentMethodId) {
            await order.save();
            console.log(
              `Recovered and saved payment method: ${order.transactionDetails.stripePaymentMethodId}`
            );
          }
        } catch (recoveryError) {
          console.error(
            `Error recovering payment method: ${recoveryError.message}`
          );
        }
      }

      // If still missing required info, we can't proceed
      if (
        !order.transactionDetails ||
        !order.transactionDetails.stripeCustomerId ||
        !order.transactionDetails.stripePaymentMethodId
      ) {
        throw new Error(
          "Critical payment information missing. Cannot process installment."
        );
      }
    }

    // Process payment with Stripe.
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

    // Now create and confirm the payment intent with explicit payment method
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(order.installmentDetails.installmentAmount * 100),
      currency: "aud",
      customer: order.transactionDetails.stripeCustomerId,
      payment_method: order.transactionDetails.stripePaymentMethodId,
      off_session: true,
      confirm: true,
      payment_method_types: ["card"],
      description: `Installment ${installmentNumber}/${order.installmentDetails.numberOfInstallments} for Donation ${order.donationId}`,
      metadata: {
        donationId: order.donationId,
        orderId: order._id.toString(),
        installment: installmentNumber,
        totalInstallments: order.installmentDetails.numberOfInstallments,
      },
    });

    // Update order with payment result.
    order.installmentDetails.installmentsPaid = installmentNumber;

    // Calculate and store the next installment date if there are more installments remaining.
    if (installmentNumber < order.installmentDetails.numberOfInstallments) {
      const paymentIntervalDays =
        order.installmentDetails.paymentIntervalDays || 30;
      order.installmentDetails.nextInstallmentDate = new Date(
        Date.now() + paymentIntervalDays * 24 * 60 * 60 * 1000
      );
    } else {
      // Final installment: mark order as completed.
      order.installmentDetails.status = "completed";
      order.paymentStatus = "completed";
    }

    // Record this installment in the history.
    order.installmentDetails.installmentHistory.push({
      installmentNumber: installmentNumber,
      amount: order.installmentDetails.installmentAmount,
      date: new Date(),
      status: paymentIntent.status === "succeeded" ? "completed" : "processing",
      transactionId: paymentIntent.id,
    });

    await order.save();

    console.log(
      `Successfully processed installment ${installmentNumber} for order: ${orderId}`
    );

    // Send receipt email for the completed installment.
    try {
      const { sendReceiptEmail } = require("../services/recieptUtils");
      await sendReceiptEmail(order, installmentNumber);
    } catch (emailError) {
      console.error("Failed to send receipt email:", emailError);
    }

    return { success: true, paymentIntent };
  } catch (error) {
    console.error(`Error processing installment for order ${orderId}:`, error);

    // On error, update the order with error information without incrementing installmentsPaid.
    try {
      const order = await Order.findById(orderId);
      if (order && order.installmentDetails) {
        order.installmentDetails.installmentHistory.push({
          installmentNumber: order.installmentDetails.installmentsPaid + 1,
          amount: order.installmentDetails.installmentAmount,
          date: new Date(),
          status: "failed",
          error: error.message,
        });
        // Schedule a retry in 24 hours.
        order.installmentDetails.nextInstallmentDate = new Date(
          Date.now() + 24 * 60 * 60 * 1000
        );
        await order.save();
      }
    } catch (updateError) {
      console.error(
        "Failed to update order with error information:",
        updateError
      );
    }

    return { success: false, error: error.message };
  }
};

exports.uploadReceipt = [
  upload.single("receipt"), // "receipt" must match the FormData key from the frontend
  async (req, res) => {
    try {
      const { donationId, userId } = req.body;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "No file uploaded",
        });
      }

      // Check if the file was actually uploaded to S3
      if (!req.file.location) {
        return res.status(500).json({
          success: false,
          message: "Failed to upload file to storage",
        });
      }

      // multer-s3 automatically adds a "location" property with the S3 file URL
      const fileUrl = req.file.location;

      // Find the order in your database by donationId
      const order = await Order.findOne({ donationId });
      if (!order) {
        return res.status(404).json({
          success: false,
          message: `Order not found for donationId: ${donationId}`,
        });
      }

      // Store the file URL in your order document along with metadata
      order.receiptUrl = fileUrl;
      order.receiptUploadedAt = new Date();
      if (userId) {
        order.receiptUploadedBy = userId;
      }
      await order.save();

      // Return a receipt object so the frontend receives complete data
      return res.json({
        success: true,
        message: "Receipt uploaded successfully",
        receipt: {
          fileUrl,
          fileName: path.basename(fileUrl),
          uploadDate: order.receiptUploadedAt,
        },
      });
    } catch (error) {
      console.error("Error uploading receipt:", error);

      // Handle specific error cases
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          success: false,
          message: "File size must be less than 5MB",
        });
      }

      if (error.message === "Only image files are allowed!") {
        return res.status(400).json({
          success: false,
          message: "Only JPG, PNG, and GIF files are allowed",
        });
      }

      // Handle S3-specific errors
      if (error.name === "S3Error" || error.name === "NoSuchBucket") {
        return res.status(500).json({
          success: false,
          message: "Storage service error. Please try again later.",
        });
      }

      return res.status(500).json({
        success: false,
        message: "Server error uploading receipt",
        error: error.message,
      });
    }
  },
];

// Get Order By Donation ID Controller
exports.getOrderByDonationId = async (req, res) => {
  try {
    const { donationId } = req.params;
    const order = await Order.findOne({ donationId });
    if (!order) {
      return res.status(404).json({
        success: false,
        message: `Order not found for donationId: ${donationId}`,
      });
    }
    return res.json({
      success: true,
      order,
    });
  } catch (error) {
    console.error("Error fetching order by donationId:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching order",
      error: error.message,
    });
  }
};

// Delete Receipt Controller
exports.deleteReceipt = async (req, res) => {
  try {
    const { donationId } = req.params;
    const order = await Order.findOne({ donationId });
    if (!order) {
      return res.status(404).json({
        success: false,
        message: `Order not found for donationId: ${donationId}`,
      });
    }
    if (!order.receiptUrl) {
      return res.status(400).json({
        success: false,
        message: "No receipt to delete.",
      });
    }

    // Only clear receipt info in the order document (do not delete from S3)
    order.receiptUrl = undefined;
    order.receiptUploadedAt = undefined;
    order.receiptUploadedBy = undefined;
    await order.save();

    return res.json({
      success: true,
      message: "Receipt deleted from database successfully",
    });
  } catch (error) {
    console.error("Error deleting receipt:", error);
    return res.status(500).json({
      success: false,
      message: "Server error deleting receipt",
      error: error.message,
    });
  }
};

exports.proxyReceiptForViewing = async (req, res) => {
  try {
    const { donationId } = req.params;

    // Find the order in your database
    const order = await Order.findOne({ donationId });
    if (!order || !order.receiptUrl) {
      return res.status(404).json({
        success: false,
        message: "Receipt not found",
      });
    }

    const receiptUrl = order.receiptUrl;

    try {
      // Fetch the file from S3
      const response = await axios.get(receiptUrl, {
        responseType: "arraybuffer",
      });

      // Determine content type based on the file name
      const fileName = receiptUrl.split("/").pop();
      const fileExt = path.extname(fileName).replace(".", "").toLowerCase();

      const contentTypes = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        pdf: "application/pdf",
      };

      const contentType = contentTypes[fileExt] || "application/octet-stream";

      // Set headers for inline display
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Cache-Control", "public, max-age=300"); // Cache for 5 minutes

      // Send the file
      return res.send(response.data);
    } catch (error) {
      console.error("Error fetching receipt from S3:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching receipt from storage",
      });
    }
  } catch (error) {
    console.error("Error proxying receipt for viewing:", error);
    return res.status(500).json({
      success: false,
      message: "Server error proxying receipt",
      error: error.message,
    });
  }
};
