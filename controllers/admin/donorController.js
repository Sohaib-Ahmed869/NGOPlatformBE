// routes/admin/donorRoutes.js
const express    = require("express");
const router     = express.Router();
const isAdmin    = require("../../middleware/isAdmin");
const Order      = require("../../models/order");
const User       = require("../../models/user");
const stripeLib  = require("stripe");
const { getTenantStripe } = require("../../services/tenantStripe");
const { escapeRegex } = require("../../utils/operatorInput");

/* ── donor rollup, computed in MongoDB ──────────────────────────────────────
 * The donor list used to load EVERY non-failed order for the organisation into
 * Node, group it by donor in JavaScript, then filter, sort and finally slice a
 * page out of the result. Asking for ten rows did the whole organisation's work,
 * and every page change did it again.
 *
 * The expressions below are a direct port of that JavaScript so the numbers do
 * not move. Three deliberate differences, all cases where the old code produced
 * a crash or a NaN rather than a value:
 *
 *   - a null `frequency` fell into `frequency.toLowerCase()` and threw; here it
 *     takes the same path as an unrecognised frequency (`totalPayments || 1`).
 *   - a missing `amount` / `installmentAmount` produced NaN, which serialises to
 *     null and renders as an empty cell; here it contributes 0.
 *   - sorting carries an `_id` tiebreak, without which two donors on equal
 *     totals could repeat or vanish across page boundaries.
 */

// getFullYear()/getMonth() read LOCAL time, while $year/$month default to UTC.
// Passing the server's own zone keeps the monthly and yearly counts identical to
// what this endpoint returns today. (That the result depends on server timezone
// at all is a pre-existing quirk — preserved here rather than silently changed.)
const SERVER_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const MS_PER_WEEK = MS_PER_DAY * 7;

/** JavaScript's `x || 1` — 0, null, false and "" all become 1. */
const orOne = (expr) => ({
  $let: { vars: { v: expr }, in: { $cond: [{ $in: ["$$v", [null, 0, false, ""]] }, 1, "$$v"] } },
});

/** JavaScript's `x || 0`, for numeric fields that may be absent. */
const orZero = (expr) => ({ $ifNull: [expr, 0] });

const yearOf = (d) => ({ $year: { date: d, timezone: SERVER_TZ } });
// $month is 1-indexed and getMonth() is 0-indexed, but both are only ever used
// inside a difference, so the offset cancels.
const monthOf = (d) => ({ $month: { date: d, timezone: SERVER_TZ } });

/** Port of calculateRecurringTotalAmount(): how many payments a schedule implies. */
const recurringPaymentCount = {
  $cond: [
    { $or: [{ $not: ["$recurringDetails.startDate"] }, { $not: ["$recurringDetails.endDate"] }] },
    orOne("$recurringDetails.totalPayments"),
    {
      $let: {
        vars: {
          freq: { $toLower: { $ifNull: ["$recurringDetails.frequency", ""] } },
          start: "$recurringDetails.startDate",
          end: "$recurringDetails.endDate",
        },
        in: {
          $switch: {
            branches: [
              {
                case: { $eq: ["$$freq", "daily"] },
                then: { $add: [{ $ceil: { $divide: [{ $subtract: ["$$end", "$$start"] }, MS_PER_DAY] } }, 1] },
              },
              {
                case: { $eq: ["$$freq", "weekly"] },
                then: { $add: [{ $ceil: { $divide: [{ $subtract: ["$$end", "$$start"] }, MS_PER_WEEK] } }, 1] },
              },
              {
                case: { $eq: ["$$freq", "monthly"] },
                then: {
                  $add: [
                    { $multiply: [{ $subtract: [yearOf("$$end"), yearOf("$$start")] }, 12] },
                    { $subtract: [monthOf("$$end"), monthOf("$$start")] },
                    1,
                  ],
                },
              },
              {
                case: { $eq: ["$$freq", "yearly"] },
                then: { $add: [{ $subtract: [yearOf("$$end"), yearOf("$$start")] }, 1] },
              },
            ],
            default: orOne("$recurringDetails.totalPayments"),
          },
        },
      },
    },
  ],
};

// `!o.paymentType` in the original — missing, null and "" all count as one-time.
const IS_ONE_TIME = {
  $or: [
    { $in: [{ $ifNull: ["$paymentType", ""] }, ["", "single", "one_time"]] },
  ],
};
const IS_INSTALLMENTS = {
  $and: [{ $eq: ["$paymentType", "installments"] }, { $ne: [{ $ifNull: ["$installmentDetails", null] }, null] }],
};
const IS_RECURRING = {
  $and: [{ $eq: ["$paymentType", "recurring"] }, { $ne: [{ $ifNull: ["$recurringDetails", null] }, null] }],
};

const INSTALMENTS_PAID_VALUE = {
  $multiply: [orZero("$installmentDetails.installmentsPaid"), orZero("$installmentDetails.installmentAmount")],
};

/** What this order is expected to raise in total. */
const ORDER_EXPECTED = {
  $switch: {
    branches: [
      { case: IS_ONE_TIME, then: orZero("$totalAmount") },
      {
        case: IS_INSTALLMENTS,
        then: {
          $cond: [
            { $eq: ["$paymentStatus", "cancelled"] },
            INSTALMENTS_PAID_VALUE,
            {
              $multiply: [
                orZero("$installmentDetails.numberOfInstallments"),
                orZero("$installmentDetails.installmentAmount"),
              ],
            },
          ],
        },
      },
      {
        case: IS_RECURRING,
        then: { $multiply: [recurringPaymentCount, orZero("$recurringDetails.amount")] },
      },
    ],
    // An order typed "installments"/"recurring" with no matching details block
    // fell through every branch in the original and contributed nothing.
    default: 0,
  },
};

/** What this order has actually collected. */
const ORDER_PAID = {
  $switch: {
    branches: [
      {
        case: IS_ONE_TIME,
        then: { $cond: [{ $eq: ["$paymentStatus", "completed"] }, orZero("$totalAmount"), 0] },
      },
      { case: IS_INSTALLMENTS, then: INSTALMENTS_PAID_VALUE },
      {
        case: IS_RECURRING,
        then: {
          $sum: {
            $map: {
              input: {
                $filter: {
                  input: { $ifNull: ["$recurringDetails.paymentHistory", []] },
                  as: "p",
                  cond: { $in: ["$$p.status", ["succeeded", "completed"]] },
                },
              },
              as: "p",
              in: orZero("$$p.amount"),
            },
          },
        },
      },
    ],
    default: 0,
  },
};

// Only these can be sorted on. The original subtracted the two values
// numerically, so any non-numeric field produced NaN and left the order
// arbitrary; name, email and the two dates now sort for real.
const SORT_FIELDS = {
  totalPaid: "totalPaid",
  totalExpected: "totalExpected",
  donationCount: "donationCount",
  firstDonationDate: "firstDonationDate",
  lastDonationDate: "lastDonationDate",
  name: "user.name",
  email: "user.email",
};

// Helper: calculate full expected amount for recurring orders
function calculateRecurringTotalAmount(order) {
  if (!order.recurringDetails) return 0;
  const { amount, frequency, startDate, endDate, totalPayments } = order.recurringDetails;
  if (!startDate || !endDate) {
    return (totalPayments || 1) * amount;
  }
  const start = new Date(startDate), end = new Date(endDate);
  let count = 0;
  switch (frequency.toLowerCase()) {
    case "daily":
      count = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
      break;
    case "weekly":
      count = Math.ceil((end - start) / (1000 * 60 * 60 * 24 * 7)) + 1;
      break;
    case "monthly":
      count = (end.getFullYear() - start.getFullYear()) * 12
            + (end.getMonth() - start.getMonth()) + 1;
      break;
    case "yearly":
      count = end.getFullYear() - start.getFullYear() + 1;
      break;
    default:
      count = totalPayments || 1;
  }
  return count * amount;
}

// GET /admin/donors/dashboard/stats
router.get("/dashboard/stats", isAdmin, async (req, res) => {
  try {
    const stripe = getTenantStripe(req.organisation);
    const orgFilter = req.organisation?._id ? { organisationId: req.organisation._id } : {};
    const allOrders   = await Order.find(orgFilter).lean();
    const validOrders = allOrders.filter(o => o.paymentStatus !== "failed");

    let totalDonated = 0, paidDonated = 0;
    let activeRecurring = 0, recurringCount = 0, oneTimeCount = 0, installmentCount = 0;
    let completedCount = 0, monthlyMRR = 0;
    const donorTotals = new Map();

    await Promise.all(validOrders.map(async o => {
      const { user, paymentType, paymentStatus, totalAmount, installmentDetails,
              transactionDetails, recurringDetails } = o;
      // Orders may have no linked donor user (anonymous donations); skip donor
      // attribution for those but still count their amounts below.
      const uid = user ? user.toString() : null;
      if (uid) donorTotals.set(uid, (donorTotals.get(uid) || 0) + totalAmount);

      if (["completed", "succeeded"].includes(paymentStatus)) completedCount++;
      if (paymentType === "recurring") recurringCount++;
      else if (paymentType === "installments") installmentCount++;
      else oneTimeCount++;

      // One-time
      if (!paymentType || ["single","one_time"].includes(paymentType)) {
        totalDonated += totalAmount;
        if (paymentStatus === "completed") paidDonated += totalAmount;
      }
      // Installments
      else if (paymentType === "installments" && installmentDetails) {
        const { numberOfInstallments, installmentAmount, installmentsPaid } = installmentDetails;
        const paidCnt = installmentsPaid || 0;
        const expected = paymentStatus === "cancelled"
          ? paidCnt * installmentAmount
          : numberOfInstallments * installmentAmount;
        totalDonated += expected;
        paidDonated  += paidCnt * installmentAmount;
        if (paymentStatus !== "cancelled") monthlyMRR += installmentAmount;
        if (["active","pending"].includes(paymentStatus)) activeRecurring++;
      }
      // Recurring
      else if (paymentType === "recurring" && recurringDetails) {
        const expected = calculateRecurringTotalAmount(o);
        totalDonated += expected;
        let paidAmt = 0;
        if (transactionDetails?.stripeSubscriptionId) {
          try {
            const inv = await stripe.invoices.list({
              subscription: transactionDetails.stripeSubscriptionId,
              status: "paid", limit: 100
            });
            paidAmt = inv.data.reduce((s,i) => s + i.amount_paid/100, 0);
          } catch (e) {
            // The subscription may not exist on the current Stripe account (e.g.
            // it was created under a different account before per-tenant keys, or
            // is seed/test data). Fall back to the locally stored payment history.
            console.warn(`Dashboard: invoices.list failed for ${transactionDetails.stripeSubscriptionId}: ${e.message}`);
          }
        }
        if (!paidAmt && Array.isArray(recurringDetails.paymentHistory)) {
          paidAmt = recurringDetails.paymentHistory
            .filter(p => ["succeeded","completed"].includes(p.status))
            .reduce((s,p) => s + (p.amount||0), 0);
        }
        paidDonated += paidAmt;
        if (paidAmt > 0) {
          const amt = recurringDetails.amount;
          const freq = recurringDetails.frequency.toLowerCase();
          let m = freq === "weekly" ? amt*4.33
                : freq === "yearly" ? amt/12
                : freq === "quarterly"? amt/3
                : amt;
          monthlyMRR += m;
        }
        if (["active","pending"].includes(paymentStatus)) activeRecurring++;
      }
    }));

    const totalDonors    = donorTotals.size;
    const avgDonation    = totalDonors ? totalDonated/totalDonors : 0;
    const recurringDonors= new Set(allOrders
      .filter(o => o.paymentType==="recurring" && o.paymentStatus!=="failed" && o.user)
      .map(o => o.user.toString())
    ).size;

    res.json({
      status: "Success",
      data: {
        stats: {
          totalDonors,
          totalDonations: Number(totalDonated.toFixed(2)),
          averageDonation: Number(avgDonation.toFixed(2)),
          recurringDonations: recurringDonors,
          successRate: allOrders.length
            ? Number(((validOrders.length/allOrders.length)*100).toFixed(2))
            : 0,
          monthlyRecurringRevenue: Number(monthlyMRR.toFixed(2))
        },
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status:"Error", message:"Failed to fetch dashboard statistics", error:err.message });
  }
});

// GET /admin/donors/
router.get("/", isAdmin, async (req, res) => {
  try {
    const page      = parseInt(req.query.page)  || 1;
    const limit     = parseInt(req.query.limit) || 10;
    const search    = (req.query.search || "").trim();
    const sortBy    = req.query.sortBy  || "totalPaid";
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;
    const type      = req.query.type    || "All";
    const skip      = (page - 1) * limit;

    const donorOrgFilter = { paymentStatus: { $ne: "failed" }, user: { $ne: null } };
    if (req.organisation?._id) donorOrgFilter.organisationId = req.organisation._id;

    // Post-group filters. Applied after the rollup because both read values that
    // only exist once an donor's orders have been combined.
    const postGroup = [];
    if (type !== "All") {
      postGroup.push({ $match: { donationType: type === "single" ? "one-time" : type } });
    }
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      postGroup.push({ $match: { $or: [{ "user.name": rx }, { "user.email": rx }] } });
    }

    const sortField = SORT_FIELDS[sortBy] || "totalPaid";
    // MongoDB orders strings by byte value, so "asad" sorts after "Zoe". A
    // case-insensitive collation is what anyone reading a name column expects.
    // Applied ONLY for the two string sorts: a collation also changes how string
    // equality matches elsewhere in the pipeline, and there is no reason to take
    // that on when ordering by an amount or a date.
    const stringSort = sortField === "user.name" || sortField === "user.email";

    const pipeline = [
      { $match: donorOrgFilter },
      { $addFields: { _expected: ORDER_EXPECTED, _paid: ORDER_PAID } },
      {
        $group: {
          _id: "$user",
          totalPaid:         { $sum: "$_paid" },
          totalExpected:     { $sum: "$_expected" },
          donationCount:     { $sum: 1 },
          firstDonationDate: { $min: "$createdAt" },
          lastDonationDate:  { $max: "$createdAt" },
          // $push skips missing values, so absent paymentTypes are made explicit
          // — the original array carried an `undefined` slot, which serialises to
          // null, and the client counts these.
          donationTypes:     { $push: { $ifNull: ["$paymentType", null] } },
        },
      },
      {
        $addFields: {
          donationType: {
            $cond: [
              { $in: ["recurring", "$donationTypes"] },
              "recurring",
              { $cond: [{ $in: ["installments", "$donationTypes"] }, "installments", "one-time"] },
            ],
          },
          // Rounded before the sort, exactly as the original did.
          totalPaid:     { $round: ["$totalPaid", 2] },
          totalExpected: { $round: ["$totalExpected", 2] },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user",
          pipeline: [{ $project: { name: 1, email: 1, phone: 1, address: 1, country: 1, dateOfBirth: 1 } }],
        },
      },
      // Not preserveNullAndEmptyArrays: an order pointing at a deleted user came
      // back from populate() as null and was skipped. Same outcome here.
      { $unwind: "$user" },
      ...postGroup,
      {
        // One pass yields both the page and the count it is a page of. Splitting
        // them would mean running the whole rollup twice.
        $facet: {
          rows: [{ $sort: { [sortField]: sortOrder, _id: 1 } }, { $skip: skip }, { $limit: limit }],
          total: [{ $count: "n" }],
        },
      },
    ];

    const aggregation = Order.aggregate(pipeline).allowDiskUse(true);
    if (stringSort) aggregation.collation({ locale: "en", strength: 2 });
    const [result] = await aggregation;

    const total = result?.total?.[0]?.n || 0;

    // Presentation-only derivations, done for the page rather than the org.
    const donors = (result?.rows || []).map((d) => {
      const user = d.user || {};
      const [firstName, ...rest] = (user.name || "").trim().split(" ");
      const addr = user.address || {};
      return {
        _id:               user._id,
        name:              user.name,
        firstName,
        lastName:          rest.join(" "),
        email:             user.email,
        phone:             user.phone,
        address:           user.address,
        fullAddress:       [addr.street, addr.city, addr.state, addr.postalCode].filter(Boolean).join(", "),
        country:           user.country,
        dateOfBirth:       user.dateOfBirth,
        totalPaid:         d.totalPaid,
        totalExpected:     d.totalExpected,
        donationCount:     d.donationCount,
        firstDonationDate: d.firstDonationDate?.toISOString(),
        lastDonationDate:  d.lastDonationDate?.toISOString(),
        donationTypes:     d.donationTypes,
        donationType:      d.donationType,
      };
    });

    res.json({
      status: "Success",
      data: {
        donors,
        pagination: {
          total,
          pages:       Math.ceil(total / limit),
          currentPage: page,
          perPage:     limit
        }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      status:  "Error",
      message: "Failed to fetch donors",
      error:   err.message
    });
  }
});



// GET /admin/donors/:id
router.get("/:id", isAdmin, async (req, res) => {
  try {
    const donorId = req.params.id;
    const donor = await User.findById(donorId).lean();
    if (!donor) {
      return res.status(404).json({ status:"Error", message:"Donor not found" });
    }

    const donorOrderFilter = {
      user: donorId,
      paymentStatus:{ $ne:"failed" }
    };
    if (req.organisation?._id) donorOrderFilter.organisationId = req.organisation._id;
    const orders = await Order.find(donorOrderFilter).sort({ createdAt:-1 }).lean();

    const history=[];
    orders.forEach(o=>{
      if (!o.paymentType||["single","one_time"].includes(o.paymentType)) {
        if (o.paymentStatus==="completed") {
          history.push({ id:o._id.toString(), date:o.createdAt,
                         amount:o.totalAmount, status:o.paymentStatus,
                         type:"one-time", cause:o.items[0]?.title||"Multiple Items"
                       });
        }
      }
      else if (o.paymentType==="installments"&&o.installmentDetails) {
        const paidCnt=o.installmentDetails.installmentsPaid||0;
        const amt=paidCnt*o.installmentDetails.installmentAmount;
        if(paidCnt>0){
          history.push({ id:o._id.toString(), date:o.createdAt,
                         amount:amt, status:o.paymentStatus,
                         type:"installments", cause:o.items[0]?.title||"Multiple Items"
                       });
        }
      }
      else if (o.paymentType==="recurring"&&Array.isArray(o.recurringDetails.paymentHistory)){
        o.recurringDetails.paymentHistory
          .filter(p=>["succeeded","completed"].includes(p.status))
          .forEach(p=>{
            history.push({ id:p.invoiceId||p._id?.toString()||`${o._id}:${p.date}`,
                           date:p.date, amount:p.amount, status:p.status,
                           type:"recurring", cause:o.items[0]?.title||"Multiple Items"
                         });
          });
      }
    });

    history.sort((a,b)=>new Date(b.date)-new Date(a.date));
    const totalDonations=history.reduce((s,e)=>s+e.amount,0);

    // Derived summary for the donor detail page.
    const dated = history.map(h => new Date(h.date)).filter(d => !isNaN(d));
    const firstDonationDate = dated.length ? new Date(Math.min(...dated)).toISOString() : null;
    const lastDonationDate  = dated.length ? new Date(Math.max(...dated)).toISOString() : null;

    const orderTypes = orders.map(o => o.paymentType);
    let donationType = "one-time";
    if (orderTypes.includes("recurring")) donationType = "recurring";
    else if (orderTypes.includes("installments")) donationType = "installments";

    const typeBreakdown = {
      "one-time":     { count: 0, amount: 0 },
      recurring:      { count: 0, amount: 0 },
      installments:   { count: 0, amount: 0 },
    };
    history.forEach(h => {
      const k = h.type === "recurring" ? "recurring" : h.type === "installments" ? "installments" : "one-time";
      typeBreakdown[k].count  += 1;
      typeBreakdown[k].amount += h.amount || 0;
    });

    res.json({
      status:"Success",
      data:{
        id: donor._id,
        name: donor.name,
        firstName: donor.name.split(" ")[0],
        lastName: donor.name.split(" ").slice(1).join(" "),
        email: donor.email,
        phone: donor.phone,
        address: donor.address,
        country: donor.country,
        dateOfBirth: donor.dateOfBirth,
        fullAddress: [donor.address?.street, donor.address?.city, donor.address?.state, donor.address?.postalCode]
                       .filter(Boolean).join(", "),
        donationHistory: history,
        totalDonations,
        // ── enriched ──
        donationCount: history.length,
        firstDonationDate,
        lastDonationDate,
        donationType,
        typeBreakdown,
      }
    });
  } catch(err) {
    console.error(err);
    res.status(500).json({ status:"Error", message:"Failed to fetch donor details", error:err.message });
  }
});

module.exports = router;
