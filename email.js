// Mirrors backend/utils/email.js — same env var names (SMTP_HOST/PORT/SECURE/
// USER/PASS/FROM) so the same .env block works in both places, but this
// process has its own dependencies and its own .env, so it is not shared code.
function getSmtpConfig() {
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
  };
}

async function sendEmail({ to, subject, text, html }) {
  const config = getSmtpConfig();

  if (!config.host || !config.user || !config.pass || !config.from) {
    console.warn("[email] SMTP is not configured. Email not sent.");
    console.warn(`[email] To: ${to}`);
    console.warn(`[email] Subject: ${subject}`);
    return { sent: false, reason: "SMTP_NOT_CONFIGURED" };
  }

  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });

  await transporter.sendMail({ from: config.from, to, subject, text, html });
  return { sent: true };
}

module.exports = { sendEmail };
