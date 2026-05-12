// routes/admin/donorRoutes.js
const express    = require("express");
const router     = express.Router();
const isAdmin    = require("../../middleware/isAdmin");
const Order      = require("../../models/order");
const User       = require("../../models/user");
const stripeLib  = require("stripe");

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
    const stripe = stripeLib(process.env.STRIPE_SECRET_KEY);
    const allOrders   = await Order.find({}).lean();
    const validOrders = allOrders.filter(o => o.paymentStatus !== "failed");

    let totalDonated = 0, paidDonated = 0;
    let activeRecurring = 0, recurringCount = 0, oneTimeCount = 0, installmentCount = 0;
    let completedCount = 0, monthlyMRR = 0;
    const donorTotals = new Map();

    await Promise.all(validOrders.map(async o => {
      const { user, paymentType, paymentStatus, totalAmount, installmentDetails,
              transactionDetails, recurringDetails } = o;
      const uid = user.toString();
      donorTotals.set(uid, (donorTotals.get(uid) || 0) + totalAmount);

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
          const inv = await stripe.invoices.list({
            subscription: transactionDetails.stripeSubscriptionId,
            status: "paid", limit: 100
          });
          paidAmt = inv.data.reduce((s,i) => s + i.amount_paid/100, 0);
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
      .filter(o => o.paymentType==="recurring" && o.paymentStatus!=="failed")
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
    const search    = (req.query.search || "").toLowerCase();
    const sortBy    = req.query.sortBy  || "totalPaid";
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;
    const type      = req.query.type    || "All";
    const skip      = (page - 1) * limit;

    const allOrders = await Order.find({ paymentStatus: { $ne: "failed" } })
      .populate("user", "name email phone address country dateOfBirth")
      .lean();

    const map = new Map();
    allOrders.forEach(o => {
      const uid = o.user._id.toString();
      if (!map.has(uid)) map.set(uid, { user: o.user, orders: [] });
      map.get(uid).orders.push(o);
    });

    let donors = Array.from(map.values()).map(({ user, orders }) => {
      // split full name
      const [ firstName, ...rest ] = (user.name || "").trim().split(" ");
      const lastName = rest.join(" ");

      // build full address
      const addr = user.address || {};
      const fullAddress = [
        addr.street,
        addr.city,
        addr.state,
        addr.postalCode
      ].filter(Boolean).join(", ");

      let totalPaid     = 0;
      let totalExpected = 0;
      let firstDate, lastDate;
      const types = [];

      orders.forEach(o => {
        types.push(o.paymentType);
        const dt = new Date(o.createdAt);
        if (!firstDate || dt < firstDate) firstDate = dt;
        if (!lastDate  || dt > lastDate)  lastDate  = dt;

        // one-time
        if (!o.paymentType || ["single","one_time"].includes(o.paymentType)) {
          totalExpected += o.totalAmount;
          if (o.paymentStatus === "completed") {
            totalPaid += o.totalAmount;
          }
        }
        // installments
        else if (o.paymentType === "installments" && o.installmentDetails) {
          const { numberOfInstallments, installmentAmount, installmentsPaid } = o.installmentDetails;
          const exp = o.paymentStatus === "cancelled"
            ? (installmentsPaid||0) * installmentAmount
            : numberOfInstallments * installmentAmount;
          totalExpected += exp;
          totalPaid     += (installmentsPaid||0) * installmentAmount;
        }
        // recurring
        else if (o.paymentType === "recurring" && o.recurringDetails) {
          totalExpected += calculateRecurringTotalAmount(o);
          if (Array.isArray(o.recurringDetails.paymentHistory)) {
            totalPaid += o.recurringDetails.paymentHistory
              .filter(p => ["succeeded","completed"].includes(p.status))
              .reduce((sum,p) => sum + (p.amount||0), 0);
          }
        }
      });

      let donationType = "one-time";
      if (types.includes("recurring")) donationType = "recurring";
      else if (types.includes("installments")) donationType = "installments";

      return {
        _id:               user._id,
        name:              user.name,
        firstName,                             // ← added
        lastName,                              // ← added
        email:             user.email,
        phone:             user.phone,
        address:           user.address,
        fullAddress,                           // ← added
        country:           user.country,       // add this line
        dateOfBirth:               user.dateOfBirth,    // ← added (alias for dateOfBirth)
        totalPaid:         Number(totalPaid.toFixed(2)),
        totalExpected:     Number(totalExpected.toFixed(2)),
        donationCount:     orders.length,
        firstDonationDate: firstDate?.toISOString(),
        lastDonationDate:  lastDate?.toISOString(),
        donationTypes:     types,
        donationType
      };
    });
    console.log(donors);

    // 5) search
    if (search) {
      donors = donors.filter(d =>
        d.name.toLowerCase().includes(search) ||
        d.email.toLowerCase().includes(search)
      );
    }
    // 6) type filter
    if (type !== "All") {
      const tf = type === "single" ? "one-time" : type;
      donors = donors.filter(d => d.donationType === tf);
    }
    // 7) sort
    donors.sort((a,b) =>
      ((a[sortBy]||0) - (b[sortBy]||0)) * sortOrder
    );
    // 8) paginate
    const total = donors.length;
    const paged = donors.slice(skip, skip + limit);

    res.json({
      status: "Success",
      data: {
        donors: paged,
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

    const orders = await Order.find({
      user: donorId,
      paymentStatus:{ $ne:"failed" }
    }).sort({ createdAt:-1 }).lean();

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
        fullAddress: [donor.address?.street, donor.address?.city, donor.address?.state, donor.address?.postalCode]
                       .filter(Boolean).join(", "),
        donationHistory: history,
        totalDonations
      }
    });
  } catch(err) {
    console.error(err);
    res.status(500).json({ status:"Error", message:"Failed to fetch donor details", error:err.message });
  }
});

module.exports = router;
