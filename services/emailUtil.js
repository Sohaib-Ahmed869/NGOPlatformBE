// emailUtil.js
const nodemailer = require("nodemailer");
const path = require("path");
// Configure the transporter for nodemailer
const transporter = nodemailer.createTransport({
  host: "smtp-mail.outlook.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER, // Your email address (store in environment variable for security)
    pass: process.env.EMAIL_PASS, // Your email password (store in environment variable)
  },
  tls: {
    ciphers: "SSLv3",
  },
});

// Utility function to send an email
const sendEmail = async (
  recipientEmail,
  emailBody,
  emailSubject,
  attachments = []
) => {
  try {
    const mailOptions = {
      from: `"Shahid Afridi Foundation" <${process.env.EMAIL_USER}>`,
      to: recipientEmail, // Recipient's email address
      subject: emailSubject, // Subject of the email
      text: emailBody.replace(/<[^>]*>/g, ""), // Plain text body (strip HTML)
      html: ` 
        <div>
          ${emailBody}
        </div>
       `,
      attachments: attachments,
    };

    // Send the email
    const info = await transporter.sendMail(mailOptions);
    console.log("Email sent: ", info.response);
    return { success: true, message: "Email sent successfully" };
  } catch (error) {
    console.error("Error sending email: ", error);
    return { success: false, message: "Failed to send email", error };
  }
};

module.exports = { sendEmail, transporter };
