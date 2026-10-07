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

// Whether a send can even be attempted. The mailer asks before it claims
// anything, so mail queued while SMTP is unset waits instead of burning its
// attempts on a configuration that cannot work.
function isSmtpConfigured() {
  const config = getSmtpConfig();
  return Boolean(config.host && config.user && config.pass);
}

// `from` overrides SMTP_FROM for mail that has to come from a specific address
// (member notifications are sent as admin@). The SMTP account still
// authenticates as SMTP_USER, so that mailbox must be allowed to send as the
// overridden address or the provider rejects the message.
async function sendEmail({ to, subject, text, html, from }) {
  const config = getSmtpConfig();
  const fromAddress = from || config.from;

  if (!config.host || !config.user || !config.pass || !fromAddress) {
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

  await transporter.sendMail({ from: fromAddress, to, subject, text, html });
  return { sent: true };
}

module.exports = { sendEmail, isSmtpConfigured };
