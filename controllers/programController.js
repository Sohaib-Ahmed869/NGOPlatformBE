const Program = require("../models/program");
const { sendEmail } = require("../services/emailUtil");
const { deleteS3Object } = require("../config/s3");

/**
 * GET /api/programs
 * Public: returns published + completed. Admin (?admin=true): returns all.
 */
exports.listPrograms = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const filter = { organisationId: orgId };
    if (req.query.admin !== "true") {
      filter.status = { $in: ["published", "completed"] };
    }

    const programs = await Program.find(filter)
      .select("title description goalAmount raisedAmount status images coverImageIndex donors followUpRequests createdAt")
      .sort({ createdAt: -1 });

    const result = programs.map((p) => ({
      ...p.toObject(),
      donorCount: p.donors.length,
      pendingRequests: p.followUpRequests?.filter((r) => r.status === "pending").length || 0,
    }));

    res.json(result);
  } catch (error) {
    console.error("List programs error:", error);
    res.status(500).json({ error: "Failed to fetch programs" });
  }
};

/**
 * POST /api/programs
 * Create a new program with optional images (multer array).
 */
exports.createProgram = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const { title, description, goalAmount, status } = req.body;
    if (!title || !goalAmount) {
      return res.status(400).json({ error: "Title and goal amount are required" });
    }

    const images = (req.files || []).map((f) => ({ url: f.location, key: f.key }));

    const program = await Program.create({
      organisationId: orgId,
      title,
      description,
      goalAmount,
      status: status || "published",
      images,
      createdBy: req.user._id,
    });

    res.status(201).json(program);
  } catch (error) {
    console.error("Create program error:", error);
    res.status(500).json({ error: "Failed to create program" });
  }
};

/**
 * PUT /api/programs/:id
 * Update program fields, manage images, change status.
 */
exports.updateProgram = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const program = await Program.findOne({ _id: req.params.id, organisationId: orgId });
    if (!program) return res.status(404).json({ error: "Program not found" });

    if (program.status === "completed" && req.body.status !== "completed") {
      return res.status(400).json({ error: "Completed programs cannot change status" });
    }

    // Update text fields
    if (req.body.title) program.title = req.body.title;
    if (req.body.description !== undefined) program.description = req.body.description;
    if (req.body.goalAmount) program.goalAmount = Number(req.body.goalAmount);
    if (req.body.coverImageIndex !== undefined) program.coverImageIndex = Number(req.body.coverImageIndex);

    // Handle image removals
    if (req.body.removedImageKeys) {
      const keysToRemove = JSON.parse(req.body.removedImageKeys);
      for (const key of keysToRemove) {
        await deleteS3Object(key).catch((err) => console.error("S3 delete error:", err));
      }
      program.images = program.images.filter((img) => !keysToRemove.includes(img.key));
    }

    // Add new uploaded images
    if (req.files?.length) {
      const newImages = req.files.map((f) => ({ url: f.location, key: f.key }));
      program.images.push(...newImages);
    }

    // Clamp cover index
    if (program.coverImageIndex >= program.images.length) {
      program.coverImageIndex = 0;
    }

    // Handle status change
    const oldStatus = program.status;
    if (req.body.status && req.body.status !== oldStatus) {
      program.status = req.body.status;

      // Send completion email if transitioning to completed
      if (req.body.status === "completed") {
        await sendCompletionEmails(program);
      }
    }

    await program.save();
    res.json(program);
  } catch (error) {
    console.error("Update program error:", error);
    res.status(500).json({ error: "Failed to update program" });
  }
};

/**
 * GET /api/programs/:id
 * Public: hidden programs return 404. Admin sees all.
 */
exports.getProgram = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const program = await Program.findOne({
      _id: req.params.id,
      organisationId: orgId,
    }).populate("createdBy", "name email");

    if (!program) return res.status(404).json({ error: "Program not found" });

    // Hidden programs only visible to admin
    if (program.status === "hidden" && req.query.admin !== "true") {
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
 */
exports.donateToProgram = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const program = await Program.findOne({
      _id: req.params.id,
      organisationId: orgId,
      status: "published",
    });

    if (!program) return res.status(404).json({ error: "Program not found or not accepting donations" });

    const { amount, donorEmail } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Valid donation amount is required" });
    }

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
 * Admin posts follow-up with optional image uploads.
 */
exports.postFollowUp = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const program = await Program.findOne({ _id: req.params.id, organisationId: orgId });
    if (!program) return res.status(404).json({ error: "Program not found" });

    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "Update text is required" });

    const imageUrls = (req.files || []).map((f) => f.location);

    const update = { text, images: imageUrls, sentAt: new Date() };
    program.followUpUpdates.push(update);

    // Mark all pending follow-up requests as acknowledged
    program.followUpRequests.forEach((r) => {
      if (r.status === "pending") r.status = "acknowledged";
    });

    await program.save();

    // Email donors
    const donorEmails = [...new Set(program.donors.map((d) => d.email).filter(Boolean))];
    if (donorEmails.length > 0) {
      const imgHtml = imageUrls.length > 0
        ? imageUrls.map((url) => `<img src="${url}" style="max-width:400px;border-radius:8px;margin:8px 0;" />`).join("")
        : "";
      const emailBody = `
        <h2>Update on "${program.title}"</h2>
        <p>${text}</p>
        ${imgHtml}
        <p><em>Thank you for your generous support!</em></p>
      `;
      const promises = donorEmails.map((email) =>
        sendEmail(email, emailBody, `Update: ${program.title}`).catch((err) =>
          console.error(`Failed to email ${email}:`, err)
        )
      );
      await Promise.allSettled(promises);
    }

    res.json({ message: "Follow-up update posted", update });
  } catch (error) {
    console.error("Post follow-up error:", error);
    res.status(500).json({ error: "Failed to post follow-up update" });
  }
};

/**
 * PUT /api/programs/:id/close
 * Backward compat — sets status to completed.
 */
exports.closeProgram = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const program = await Program.findOne({ _id: req.params.id, organisationId: orgId });
    if (!program) return res.status(404).json({ error: "Program not found" });
    if (program.status === "completed") {
      return res.status(400).json({ error: "Program is already completed" });
    }

    program.status = "completed";
    await program.save();
    await sendCompletionEmails(program);

    res.json({ message: "Program completed successfully", program });
  } catch (error) {
    console.error("Close program error:", error);
    res.status(500).json({ error: "Failed to close program" });
  }
};

/**
 * GET /api/programs/my/donated
 */
exports.myDonatedPrograms = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const userId = req.user._id;
    const userEmail = req.user.email;

    const programs = await Program.find({
      organisationId: orgId,
      $or: [{ "donors.userId": userId }, { "donors.email": userEmail }],
    })
      .select("title description goalAmount raisedAmount status images coverImageIndex donors followUpUpdates followUpRequests createdAt")
      .sort({ updatedAt: -1 });

    // Attach whether current user has a pending request
    const result = programs.map((p) => {
      const obj = p.toObject();
      obj.hasPendingRequest = p.followUpRequests.some(
        (r) => r.status === "pending" && (r.userId?.equals(userId))
      );
      return obj;
    });

    res.json(result);
  } catch (error) {
    console.error("My donated programs error:", error);
    res.status(500).json({ error: "Failed to fetch your programs" });
  }
};

/**
 * POST /api/programs/:id/request-followup
 * Donor requests a follow-up on a program they donated to.
 */
exports.requestFollowUp = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const program = await Program.findOne({ _id: req.params.id, organisationId: orgId });
    if (!program) return res.status(404).json({ error: "Program not found" });

    const userId = req.user._id;
    const userEmail = req.user.email;

    // Verify user is a donor
    const isDonor = program.donors.some(
      (d) => d.userId?.equals(userId) || d.email === userEmail
    );
    if (!isDonor) return res.status(403).json({ error: "Only donors can request follow-ups" });

    // Dedup: one pending request per user
    const hasPending = program.followUpRequests.some(
      (r) => r.status === "pending" && r.userId?.equals(userId)
    );
    if (hasPending) return res.status(400).json({ error: "You already have a pending follow-up request" });

    program.followUpRequests.push({
      userId,
      message: req.body.message || "",
      requestedAt: new Date(),
    });
    await program.save();

    res.json({ message: "Follow-up request submitted" });
  } catch (error) {
    console.error("Request follow-up error:", error);
    res.status(500).json({ error: "Failed to submit follow-up request" });
  }
};

/**
 * GET /api/programs/admin/followup-requests
 * Admin gets all pending follow-up requests across programs.
 */
exports.getFollowUpRequests = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const programs = await Program.find({
      organisationId: orgId,
      "followUpRequests.status": "pending",
    })
      .select("title followUpRequests")
      .populate("followUpRequests.userId", "name email");

    // Flatten to a list of requests with program context
    const requests = [];
    for (const prog of programs) {
      for (const req of prog.followUpRequests) {
        if (req.status === "pending") {
          requests.push({
            programId: prog._id,
            programTitle: prog.title,
            requestId: req._id,
            user: req.userId,
            message: req.message,
            requestedAt: req.requestedAt,
          });
        }
      }
    }

    requests.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
    res.json(requests);
  } catch (error) {
    console.error("Get follow-up requests error:", error);
    res.status(500).json({ error: "Failed to fetch follow-up requests" });
  }
};

/**
 * PUT /api/programs/admin/followup-requests/:programId/:requestId/acknowledge
 */
exports.acknowledgeFollowUpRequest = async (req, res) => {
  try {
    const orgId = req.organisation?._id;
    if (!orgId) return res.status(400).json({ error: "Organisation context required" });

    const program = await Program.findOne({ _id: req.params.programId, organisationId: orgId });
    if (!program) return res.status(404).json({ error: "Program not found" });

    const request = program.followUpRequests.id(req.params.requestId);
    if (!request) return res.status(404).json({ error: "Request not found" });

    request.status = "acknowledged";
    await program.save();

    res.json({ message: "Request acknowledged" });
  } catch (error) {
    console.error("Acknowledge request error:", error);
    res.status(500).json({ error: "Failed to acknowledge request" });
  }
};

// ── Helper ─────────────────────────────────────────────
async function sendCompletionEmails(program) {
  const donorEmails = [...new Set(program.donors.map((d) => d.email).filter(Boolean))];
  if (donorEmails.length === 0) return;

  const pct = program.goalAmount > 0
    ? Math.round((program.raisedAmount / program.goalAmount) * 100)
    : 0;

  const emailBody = `
    <h2>"${program.title}" Has Been Completed</h2>
    <p>We're pleased to share the final results of this program:</p>
    <ul>
      <li><strong>Goal:</strong> $${program.goalAmount.toLocaleString()}</li>
      <li><strong>Raised:</strong> $${program.raisedAmount.toLocaleString()}</li>
      <li><strong>Achievement:</strong> ${pct}%</li>
      <li><strong>Total Donors:</strong> ${program.donors.length}</li>
    </ul>
    <p>Thank you for your generous contribution to making this possible!</p>
  `;

  const promises = donorEmails.map((email) =>
    sendEmail(email, emailBody, `Program Completed: ${program.title}`).catch((err) =>
      console.error(`Failed to email ${email}:`, err)
    )
  );
  await Promise.allSettled(promises);
}
