const Program = require("../models/program");
const Order = require("../models/order");
const { sendEmail } = require("../services/emailUtil");

/**
 * GET /api/programs
 * List all programs for the current organisation.
 */
exports.listPrograms = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    const programs = await Program.find({ organisationId: orgId })
      .select("title description goalAmount raisedAmount status donors createdAt")
      .sort({ createdAt: -1 });

    // Add donor count to each program
    const programsWithCount = programs.map((p) => ({
      ...p.toObject(),
      donorCount: p.donors.length,
    }));

    res.json(programsWithCount);
  } catch (error) {
    console.error("List programs error:", error);
    res.status(500).json({ error: "Failed to fetch programs" });
  }
};

/**
 * POST /api/programs
 * Create a new program (admin only, plan-enforced via middleware).
 */
exports.createProgram = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    const { title, description, goalAmount } = req.body;

    if (!title || !goalAmount) {
      return res.status(400).json({ error: "Title and goal amount are required" });
    }

    const program = await Program.create({
      organisationId: orgId,
      title,
      description,
      goalAmount,
      createdBy: req.user._id,
    });

    res.status(201).json(program);
  } catch (error) {
    console.error("Create program error:", error);
    res.status(500).json({ error: "Failed to create program" });
  }
};

/**
 * GET /api/programs/:id
 * Get a single program by ID.
 */
exports.getProgram = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    const program = await Program.findOne({
      _id: req.params.id,
      organisationId: orgId,
    }).populate("createdBy", "name email");

    if (!program) {
      return res.status(404).json({ error: "Program not found" });
    }

    res.json(program);
  } catch (error) {
    console.error("Get program error:", error);
    res.status(500).json({ error: "Failed to fetch program" });
  }
};

/**
 * POST /api/programs/:id/donate
 * Donor donates to a program. Creates an order linked to the program.
 */
exports.donateToProgram = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    const program = await Program.findOne({
      _id: req.params.id,
      organisationId: orgId,
      status: "active",
    });

    if (!program) {
      return res.status(404).json({ error: "Program not found or closed" });
    }

    const { amount, donorEmail } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Valid donation amount is required" });
    }

    // Update program totals
    program.raisedAmount += amount;
    program.donors.push({
      userId: req.user?._id,
      email: donorEmail || req.user?.email,
    });
    await program.save();

    res.json({
      message: "Donation recorded successfully",
      raisedAmount: program.raisedAmount,
      goalAmount: program.goalAmount,
    });
  } catch (error) {
    console.error("Donate to program error:", error);
    res.status(500).json({ error: "Failed to process donation" });
  }
};

/**
 * POST /api/programs/:id/followup
 * Admin posts a follow-up update to a program and emails all donors.
 */
exports.postFollowUp = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    const program = await Program.findOne({
      _id: req.params.id,
      organisationId: orgId,
    });

    if (!program) {
      return res.status(404).json({ error: "Program not found" });
    }

    const { text, images } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Update text is required" });
    }

    const update = {
      text,
      images: images || [],
      sentAt: new Date(),
    };

    program.followUpUpdates.push(update);
    await program.save();

    // Email all donors
    const donorEmails = [
      ...new Set(program.donors.map((d) => d.email).filter(Boolean)),
    ];

    if (donorEmails.length > 0) {
      const emailBody = `
        <h2>Update on "${program.title}"</h2>
        <p>${text}</p>
        ${
          images && images.length > 0
            ? `<p>Images attached: ${images.length}</p>`
            : ""
        }
        <p><em>Thank you for your generous support!</em></p>
      `;

      // Send emails in parallel (non-blocking)
      const emailPromises = donorEmails.map((email) =>
        sendEmail(email, emailBody, `Update: ${program.title}`).catch((err) =>
          console.error(`Failed to email ${email}:`, err)
        )
      );
      await Promise.allSettled(emailPromises);
    }

    res.json({ message: "Follow-up update posted", update });
  } catch (error) {
    console.error("Post follow-up error:", error);
    res.status(500).json({ error: "Failed to post follow-up update" });
  }
};

/**
 * PUT /api/programs/:id/close
 * Admin closes a program and sends final summary email to all donors.
 */
exports.closeProgram = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) {
      return res.status(400).json({ error: "Organisation context required" });
    }

    const program = await Program.findOne({
      _id: req.params.id,
      organisationId: orgId,
    });

    if (!program) {
      return res.status(404).json({ error: "Program not found" });
    }

    if (program.status === "closed") {
      return res.status(400).json({ error: "Program is already closed" });
    }

    program.status = "closed";
    await program.save();

    // Send final summary email to all donors
    const donorEmails = [
      ...new Set(program.donors.map((d) => d.email).filter(Boolean)),
    ];

    if (donorEmails.length > 0) {
      const percentage = program.goalAmount > 0
        ? Math.round((program.raisedAmount / program.goalAmount) * 100)
        : 0;

      const emailBody = `
        <h2>"${program.title}" Has Been Completed</h2>
        <p>We're pleased to share the final results of this program:</p>
        <ul>
          <li><strong>Goal:</strong> $${program.goalAmount.toLocaleString()}</li>
          <li><strong>Raised:</strong> $${program.raisedAmount.toLocaleString()}</li>
          <li><strong>Achievement:</strong> ${percentage}%</li>
          <li><strong>Total Donors:</strong> ${program.donors.length}</li>
        </ul>
        <p>Thank you for your generous contribution to making this possible!</p>
      `;

      const emailPromises = donorEmails.map((email) =>
        sendEmail(email, emailBody, `Program Completed: ${program.title}`).catch(
          (err) => console.error(`Failed to email ${email}:`, err)
        )
      );
      await Promise.allSettled(emailPromises);
    }

    res.json({ message: "Program closed successfully", program });
  } catch (error) {
    console.error("Close program error:", error);
    res.status(500).json({ error: "Failed to close program" });
  }
};
