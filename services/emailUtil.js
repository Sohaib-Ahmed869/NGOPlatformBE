// emailUtil.js
// The single funnel every transactional email passes through.
//
// Tenant-aware: pass `options.org` (an Organisation doc) and the mail is sent
// through that tenant's own SMTP account when configured + enabled, otherwise
// through the platform account. Calls without `options.org` behave exactly as
// before (platform account) -- fully backward compatible.
//
// Two things were added when email templates became dynamic:
//   - `options.preRendered` -- content from services/emailTemplates.js is already
//     a complete HTML document, so it must NOT be wrapped in the legacy <div>.
//   - every attempt is written to EmailLog, so a failed send leaves a record
//     instead of a console.log on whichever instance handled the request.
const mongoose = require("mongoose");
const { getTenantTransport, getFromIdentity, platformTransport, resolveOrg } = require("./tenantEmail");

// Backward-compat export -- some modules import the raw platform transporter.
const transporter = platformTransport;

/**
 * Write one row to the email log. Deliberately fire-and-forget and deliberately
 * silent on failure: a logging problem must never turn a delivered email into a
 * reported failure.
 */
function logSend(row) {
  try {
    const EmailLog = require("../models/emailLog");
    // The model is only usable once mongoose has connected; during scripts and
    // tests it may not be, and that is not worth an error.
    if (mongoose.connection.readyState !== 1) return;
    EmailLog.create(row).catch((err) =>
      console.error("[email] log write failed:", err.message),
    );
  } catch (err) {
    console.error("[email] log unavailable:", err.message);
  }
}

const orgIdOf = (org, options) => {
  const raw = options.organisationId || (org && org._id) || null;
  return raw && mongoose.isValidObjectId(raw) ? raw : null;
};

const sendEmail = async (
  recipientEmail,
  emailBody,
  emailSubject,
  attachments = [],
  options = {}
) => {
  const startedAt = Date.now();
  const to = Array.isArray(recipientEmail) ? recipientEmail.filter(Boolean).join(", ") : recipientEmail;
  // Breadcrumbs the template layer passes down; absent for legacy call sites.
  const logMeta = options.log || {};
  let org = null;

  try {
    // Resolve the tenant from either a passed org doc or just an organisationId.
    org = options.org || (options.organisationId ? await resolveOrg(options.organisationId) : null);
    const { transport, tenant } = getTenantTransport(org);
    const { fromName, fromEmail, replyTo } = getFromIdentity(org, options);

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to,
      subject: emailSubject,
      // Prefer a caller-supplied plain-text part (better deliverability than an
      // auto-stripped one); otherwise fall back to stripping the HTML.
      text: options.text || String(emailBody || "").replace(/<[^>]*>/g, ""),
      // Templated mail arrives as a full <!DOCTYPE html> document. Wrapping that
      // in a <div> produces invalid markup that Outlook in particular mangles.
      html: options.preRendered
        ? emailBody
        : `
        <div>
          ${emailBody}
        </div>
       `,
      attachments,
    };
    if (replyTo) mailOptions.replyTo = replyTo;
    if (options.cc) mailOptions.cc = options.cc;
    // Extra headers (e.g. List-Unsubscribe / List-Unsubscribe-Post for campaigns).
    if (options.headers) mailOptions.headers = options.headers;

    const info = await transport.sendMail(mailOptions);
    console.log("Email sent: ", info.response);

    logSend({
      templateKey: logMeta.templateKey || "",
      organisationId: orgIdOf(org, options),
      to: String(to || "").slice(0, 320),
      subject: String(emailSubject || "").slice(0, 300),
      status: "sent",
      transport: tenant ? "tenant" : "platform",
      source: logMeta.source || "adhoc",
      messageId: info.messageId || "",
      attachments: (attachments || []).length,
      durationMs: Date.now() - startedAt,
      meta: logMeta.meta || {},
    });

    return { success: true, message: "Email sent successfully", messageId: info.messageId };
  } catch (error) {
    console.error("Error sending email: ", error);

    logSend({
      templateKey: logMeta.templateKey || "",
      organisationId: orgIdOf(org, options),
      to: String(to || "").slice(0, 320),
      subject: String(emailSubject || "").slice(0, 300),
      status: "failed",
      // A failure at this point may itself be the transport choice going wrong,
      // so record what we were trying to use rather than asserting success.
      transport: org && org.email && org.email.enabled ? "tenant" : "platform",
      source: logMeta.source || "adhoc",
      error: String(error && (error.response || error.message) || error).slice(0, 1000),
      attachments: (attachments || []).length,
      durationMs: Date.now() - startedAt,
      meta: logMeta.meta || {},
    });

    return { success: false, message: "Failed to send email", error };
  }
};

// Re-exported so a call site only ever needs to require this one module.
// Lazy to avoid a require cycle (emailTemplates requires sendEmail from here).
const sendTemplateEmail = (...args) => require("./emailTemplates").sendTemplateEmail(...args);

module.exports = { sendEmail, sendTemplateEmail, transporter };
