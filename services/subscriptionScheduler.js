// services/subscriptionScheduler.js

const Order = require("../models/order");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const cron = require("node-cron");

/**
 * Sync payment history for a subscription with Stripe
 */
const syncSubscriptionPaymentHistory = async (subscription) => {
  try {
    const subscriptionId = subscription.transactionDetails.stripeSubscriptionId;

    // Get all paid invoices for this subscription from Stripe
    const invoices = await stripe.invoices.list({
      subscription: subscriptionId,
      status: "paid",
      limit: 100,
    });

    // Get existing payment history invoice IDs
    const existingInvoiceIds = new Set(
      (subscription.recurringDetails.paymentHistory || [])
        .map((p) => p.invoiceId)
        .filter((id) => id)
    );

    let newPaymentsAdded = 0;

    // Process each invoice from Stripe
    for (const invoice of invoices.data) {
      // Skip if we already have this payment recorded
      if (existingInvoiceIds.has(invoice.id)) {
        continue;
      }

      // Initialize payment history if it doesn't exist
      if (!subscription.recurringDetails.paymentHistory) {
        subscription.recurringDetails.paymentHistory = [];
      }

      // Add the payment to history
      subscription.recurringDetails.paymentHistory.push({
        date: new Date(invoice.status_transitions.paid_at * 1000),
        amount: invoice.amount_paid / 100, // Convert from cents
        invoiceId: invoice.id,
        status: "succeeded",
      });

      newPaymentsAdded++;
    }

    if (newPaymentsAdded > 0) {
      // Update totals
      const successfulPayments =
        subscription.recurringDetails.paymentHistory.filter(
          (p) => p.status === "succeeded"
        );

      subscription.recurringDetails.totalPayments = successfulPayments.length;

      // Update last payment date
      if (successfulPayments.length > 0) {
        const latestPayment = successfulPayments.reduce((latest, current) =>
          new Date(current.date) > new Date(latest.date) ? current : latest
        );
        subscription.recurringDetails.lastPaymentDate = latestPayment.date;
      }

      console.log(
        `Added ${newPaymentsAdded} new payments for subscription ${subscription.donationId}`
      );
    }

    return newPaymentsAdded;
  } catch (error) {
    console.error(
      `Error syncing payment history for subscription ${subscription.donationId}:`,
      error
    );
    return 0;
  }
};

/**
 * Check if a subscription has reached its natural end date
 */
const hasReachedNaturalEnd = (subscription, stripeSubscription) => {
  const now = new Date();
  
  console.log(`Checking natural end for subscription ${subscription._id}:`);
  console.log(`Current time: ${now.toISOString()}`);
  
  // Check our database end date
  if (subscription.recurringDetails && subscription.recurringDetails.endDate) {
    const endDate = new Date(subscription.recurringDetails.endDate);
    console.log(`Database end date: ${endDate.toISOString()}`);
    
    // Check if the end date is today or in the past (more generous tolerance)
    const endDateOnly = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    const nowDateOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    console.log(`End date (date only): ${endDateOnly.toISOString()}`);
    console.log(`Current date (date only): ${nowDateOnly.toISOString()}`);
    
    // If current date is on or after the end date, it's a natural end
    if (nowDateOnly >= endDateOnly) {
      console.log(`✅ Subscription ${subscription._id} has reached database end date`);
      return true;
    }
    
    // Also check with time difference for edge cases
    const timeDiff = now.getTime() - endDate.getTime();
    const hoursDiff = timeDiff / (1000 * 3600);
    console.log(`Hours difference from end date: ${hoursDiff}`);
    
    // If within 24 hours of end date (before or after), consider it natural
    if (Math.abs(hoursDiff) <= 24) {
      console.log(`✅ Subscription ${subscription._id} is within 24 hours of end date`);
      return true;
    }
  }
  
  // Check Stripe cancel_at date if available
  if (stripeSubscription && stripeSubscription.cancel_at) {
    const cancelAtDate = new Date(stripeSubscription.cancel_at * 1000);
    console.log(`Stripe cancel_at date: ${cancelAtDate.toISOString()}`);
    
    // Check if the cancel_at date is today or in the past
    const cancelAtDateOnly = new Date(cancelAtDate.getFullYear(), cancelAtDate.getMonth(), cancelAtDate.getDate());
    const nowDateOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    console.log(`Cancel_at date (date only): ${cancelAtDateOnly.toISOString()}`);
    
    // If current date is on or after the cancel_at date, it's a natural end
    if (nowDateOnly >= cancelAtDateOnly) {
      console.log(`✅ Subscription ${subscription._id} has reached Stripe cancel_at date`);
      return true;
    }
    
    // Also check with time difference
    const timeDiff = now.getTime() - cancelAtDate.getTime();
    const hoursDiff = timeDiff / (1000 * 3600);
    console.log(`Hours difference from cancel_at: ${hoursDiff}`);
    
    // If within 24 hours of cancel_at date, consider it natural
    if (Math.abs(hoursDiff) <= 24) {
      console.log(`✅ Subscription ${subscription._id} is within 24 hours of cancel_at date`);
      return true;
    }
  }
  
  // Special case: If Stripe shows both ended_at and cancel_at with the same date,
  // and subscription was set to end on a specific date, it's likely natural
  if (stripeSubscription && 
      stripeSubscription.ended_at && 
      stripeSubscription.cancel_at && 
      subscription.recurringDetails && 
      subscription.recurringDetails.endDate) {
    
    const endedAtDate = new Date(stripeSubscription.ended_at * 1000);
    const cancelAtDate = new Date(stripeSubscription.cancel_at * 1000);
    const dbEndDate = new Date(subscription.recurringDetails.endDate);
    
    console.log(`Stripe ended_at: ${endedAtDate.toISOString()}`);
    console.log(`Stripe cancel_at: ${cancelAtDate.toISOString()}`);
    console.log(`DB end date: ${dbEndDate.toISOString()}`);
    
    // If all dates are close to each other (within 48 hours), it's natural
    const endedAtDiff = Math.abs(endedAtDate.getTime() - dbEndDate.getTime()) / (1000 * 3600);
    const cancelAtDiff = Math.abs(cancelAtDate.getTime() - dbEndDate.getTime()) / (1000 * 3600);
    
    console.log(`Ended_at diff from DB end date: ${endedAtDiff} hours`);
    console.log(`Cancel_at diff from DB end date: ${cancelAtDiff} hours`);
    
    if (endedAtDiff <= 48 && cancelAtDiff <= 48) {
      console.log(`✅ Subscription ${subscription._id} - all dates align, natural completion`);
      return true;
    }
  }
  
  console.log(`❌ Subscription ${subscription._id} - not a natural end`);
  return false;
};

/**
 * Scheduled task to sync subscription statuses with Stripe and update accordingly
 */
const scheduleSubscriptionChecks = () => {
  // Run every minute (adjust frequency as needed for production)
  cron.schedule("* * * * *", async () => {
    try {
      console.log(
        `[${new Date().toISOString()}] Running subscription sync with Stripe...`
      );

      // Find ALL recurring subscriptions with Stripe subscription IDs
      // Including those already marked as "cancelled" in our system
      const subscriptions = await Order.find({
        paymentType: "recurring",
        paymentStatus: { $nin: ["ended"] }, // Only exclude "ended" subscriptions
        "transactionDetails.stripeSubscriptionId": { $exists: true, $ne: null },
      });

      console.log(
        `Found ${subscriptions.length} subscriptions to check with Stripe`
      );

      // Check each subscription with Stripe
      for (const subscription of subscriptions) {
        try {
          // Get current status from Stripe
          const stripeSubscription = await stripe.subscriptions.retrieve(
            subscription.transactionDetails.stripeSubscriptionId
          );

          // SYNC PAYMENT HISTORY - This is the key addition!
          await syncSubscriptionPaymentHistory(subscription);

          console.log(`Stripe subscription data for ${subscription._id}:`);

          const now = new Date();

          // Check specifically for ended_at in the Stripe response
          const hasEndedAt = !!stripeSubscription.ended_at;
          // Check specifically for cancel_at in the Stripe response (scheduled end date)
          const hasCancelAt = !!stripeSubscription.cancel_at;
          // Check if either date is in the past
          const endedAtDate = hasEndedAt
            ? new Date(stripeSubscription.ended_at * 1000)
            : null;
          const cancelAtDate = hasCancelAt
            ? new Date(stripeSubscription.cancel_at * 1000)
            : null;

          // Check if recurring end date in our DB has passed
          const dbEndDatePassed =
            subscription.recurringDetails &&
            subscription.recurringDetails.endDate &&
            new Date(subscription.recurringDetails.endDate) <= now;

          let newStatus = subscription.paymentStatus; // Default to current status
          let completionDetails = null;

          // Log all the conditions for debugging
          console.log(`Subscription ${subscription._id}:
            - Current status in our DB: ${subscription.paymentStatus}
            - Stripe status: ${stripeSubscription.status}
            - Has ended_at: ${hasEndedAt} (${endedAtDate})
            - Has cancel_at: ${hasCancelAt} (${cancelAtDate})
            - DB end date passed: ${dbEndDatePassed}
          `);

          // FIXED PRIORITY DECISION LOGIC:

          // Skip status update if subscription is pending cancellation
          if (subscription.paymentStatus === "pending_cancellation") {
            console.log(
              `Subscription ${subscription._id} is pending cancellation, preserving status`
            );
            // Keep the current pending_cancellation status and don't change anything
          } else {
            // Handle different Stripe statuses
            switch (stripeSubscription.status) {
              case "active":
                // Check if this should naturally end
                if (hasReachedNaturalEnd(subscription, stripeSubscription)) {
                  console.log(`Subscription ${subscription._id} should end naturally but is still active in Stripe`);
                  // Don't change status yet - wait for the webhook or next sync cycle
                } else {
                  newStatus = "active";
                }
                break;

              case "past_due":
                newStatus = "past_due";
                break;

              case "unpaid":
                newStatus = "failed";
                break;

              case "completed":
                newStatus = "ended";
                completionDetails = {
                  date: new Date(),
                  reason: "Stripe marked as completed",
                  type: "natural_completion",
                  originalEndDate: subscription.recurringDetails?.endDate
                };
                break;

              case "canceled":
                // CRITICAL FIX: Determine if this was a natural end or administrative cancellation
                if (hasReachedNaturalEnd(subscription, stripeSubscription)) {
                  // This was a natural completion
                  newStatus = "ended";
                  completionDetails = {
                    date: new Date(),
                    reason: "Reached scheduled end date",
                    type: "natural_completion",
                    originalEndDate: subscription.recurringDetails?.endDate,
                    stripeCancelAt: cancelAtDate,
                    totalPayments: subscription.recurringDetails?.totalPayments || 0,
                    totalAmountDonated: subscription.recurringDetails?.paymentHistory
                      ? subscription.recurringDetails.paymentHistory
                          .filter(p => p.status === "succeeded")
                          .reduce((sum, p) => sum + p.amount, 0)
                      : subscription.totalAmount
                  };
                  console.log(`✅ Subscription ${subscription._id} naturally ended - setting status to 'ended'`);
                } else {
                  // This was an administrative cancellation
                  newStatus = "cancelled";
                  console.log(`❌ Subscription ${subscription._id} was administratively cancelled`);
                }
                break;

              case "paused":
                newStatus = "paused";
                break;

              default:
                console.log(`Unhandled Stripe status: ${stripeSubscription.status} for subscription ${subscription._id}`);
            }
          }

          // Also check if DB end date has passed but Stripe doesn't show it as cancelled
          // This handles subscriptions that expire naturally without being cancelled
          if (dbEndDatePassed && stripeSubscription.status !== "canceled" && subscription.paymentStatus !== "pending_cancellation") {
            newStatus = "ended";
            completionDetails = {
              date: new Date(),
              reason: "Reached database end date",
              type: "natural_completion",
              originalEndDate: subscription.recurringDetails?.endDate
            };
            console.log(
              `Subscription ${subscription._id} has passed its DB end date and is not canceled in Stripe, marking as ended`
            );
          }

          // Update if status has changed
          if (newStatus !== subscription.paymentStatus) {
            console.log(
              `Updating subscription ${subscription._id} status from ${subscription.paymentStatus} to ${newStatus}`
            );

            subscription.paymentStatus = newStatus;
            
            // Update recurring details status if it exists
            if (subscription.recurringDetails) {
              subscription.recurringDetails.status = newStatus;
            }
            
            // Add completion details if this is a natural end
            if (completionDetails) {
              subscription.completionDetails = completionDetails;
            }

            subscription.transactionDetails = {
              ...subscription.transactionDetails,
              stripeStatus: stripeSubscription.status,
              lastSyncedAt: new Date(),
            };

            // Store end date information from Stripe if available
            if (hasEndedAt) {
              subscription.transactionDetails.stripeEndedAt = endedAtDate;
            }
            if (hasCancelAt) {
              subscription.transactionDetails.stripeCancelAt = cancelAtDate;
            }

            await subscription.save();
            console.log(
              `Successfully updated subscription ${subscription._id}`
            );
          } else {
            // Even if status didn't change, we might have updated payment history, so save
            await subscription.save();
            console.log(
              `No status change needed for subscription ${subscription._id}`
            );
          }
        } catch (error) {
          // Handle case where subscription might have been deleted in Stripe
          if (error.code === "resource_missing") {
            console.log(
              `Subscription ${subscription.transactionDetails.stripeSubscriptionId} not found in Stripe, checking if should be ended vs cancelled`
            );
            
            // Check if this should be marked as ended vs cancelled
            if (hasReachedNaturalEnd(subscription, null)) {
              subscription.paymentStatus = "ended";
              subscription.completionDetails = {
                date: new Date(),
                reason: "Subscription not found in Stripe (likely reached end date)",
                type: "natural_completion",
                originalEndDate: subscription.recurringDetails?.endDate
              };
              console.log(`✅ Missing subscription ${subscription._id} marked as ended (natural completion)`);
            } else {
              subscription.paymentStatus = "cancelled";
              console.log(`❌ Missing subscription ${subscription._id} marked as cancelled`);
            }
            
            if (subscription.recurringDetails) {
              subscription.recurringDetails.status = subscription.paymentStatus;
            }
            
            subscription.transactionDetails = {
              ...subscription.transactionDetails,
              stripeStatus: "deleted",
              lastSyncedAt: new Date(),
            };
            await subscription.save();
          } else {
            console.error(
              `Error checking subscription ${subscription._id} with Stripe:`,
              error
            );
          }
        }
      }

      // Also check for subscriptions that have local end dates but no Stripe ID
      const now = new Date();
      const localExpiredSubscriptions = await Order.find({
        paymentType: "recurring",
        paymentStatus: { $nin: ["ended", "cancelled"] },
        "transactionDetails.stripeSubscriptionId": { $exists: false },
        "recurringDetails.endDate": { $lt: now, $ne: null },
      });

      console.log(
        `Found ${localExpiredSubscriptions.length} locally expired subscriptions`
      );

      for (const subscription of localExpiredSubscriptions) {
        subscription.paymentStatus = "ended";
        if (subscription.recurringDetails) {
          subscription.recurringDetails.status = "ended";
        }
        subscription.completionDetails = {
          date: new Date(),
          reason: "Reached local end date",
          type: "natural_completion",
          originalEndDate: subscription.recurringDetails?.endDate
        };
        await subscription.save();
        console.log(
          `Updated local subscription ${subscription._id} to ended status`
        );
      }

      console.log(
        `[${new Date().toISOString()}] Completed subscription sync with Stripe`
      );
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Error in subscription sync:`,
        error
      );
    }
  });

  console.log(
    `[${new Date().toISOString()}] Subscription sync scheduler initialized`
  );
};

module.exports = { scheduleSubscriptionChecks };