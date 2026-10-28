'use strict';

/*
 * Email + public web address helpers.
 *
 * APP_URL   - the public address of your site, e.g. https://ledgerly.onrender.com
 *             Used in password-reset emails and as the Paystack return address.
 *             We never build these links from the visitor's Host header, because
 *             that can be faked to poison reset emails.
 * RESEND_API_KEY + MAIL_FROM - optional. Sends real emails through resend.com.
 *             Without them the app still works: the platform admin can generate
 *             a password-reset link by hand and send it on WhatsApp.
 */

function appUrl() {
  return (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
}

function emailConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

async function sendEmail({ to, subject, text }) {
  if (!emailConfigured()) {
    if (process.env.NODE_ENV !== 'production') console.log(`[email not configured]\nTo: ${to}\nSubject: ${subject}\n${text}\n`);
    else console.log(`[email not configured] could not send "${subject}"`);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) { console.error('email provider error', res.status); return false; }
    return true;
  } catch (err) {
    console.error('email send failed:', err.message);
    return false;
  }
}

module.exports = { appUrl, sendEmail, emailConfigured };
