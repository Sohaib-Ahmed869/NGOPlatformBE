// emailUtil.js
// Transactional email. Tenant-aware: pass `options.org` (an Organisation doc) and
// the email is sent through that tenant's own SMTP account when configured +
// enabled, otherwise through the platform account. Calls without `options.org`
// behave exactly as before (platform account) — fully backward compatible.
const { getTenantTransport, getFromIdentity, platformTransport, resolveOrg } = require("./tenantEmail");

// Backward-compat export — some modules import the raw platform transporter.
const transporter = platformTransport;

const sendEmail = async (
  recipientEmail,
  emailBody,
  emailSubject,
  attachments = [],
  options = {}
) => {
  try {
    // Resolve the tenant from either a passed org doc or just an organisationId.
    const org = options.org || (options.organisationId ? await resolveOrg(options.organisationId) : null);
    const { transport } = getTenantTransport(org);
    const { fromName, fromEmail, replyTo } = getFromIdentity(org, options);

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: recipientEmail,
      subject: emailSubject,
      text: String(emailBody || "").replace(/<[^>]*>/g, ""), // plain-text fallback
      html: `
        <div>
          ${emailBody}
        </div>
       `,
      attachments,
    };
    if (replyTo) mailOptions.replyTo = replyTo;

    const info = await transport.sendMail(mailOptions);
    console.log("Email sent: ", info.response);
    return { success: true, message: "Email sent successfully" };
  } catch (error) {
    console.error("Error sending email: ", error);
    return { success: false, message: "Failed to send email", error };
  }
};

module.exports = { sendEmail, transporter };
