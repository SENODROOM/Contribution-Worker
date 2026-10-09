// Member email delivery.
//
// The portal backend never sends a member's mail itself. It queues each one in
// ranking.emailOutbox (backend/models/EmailOutbox.js) — a weekly "your position
// is at risk" alert, "you are no longer Project Captain", "you won the Daily
// Achiever medal" — already rendered and named by a dedupe key, and this pass
// delivers them. The split is the same one the ledgers make: the backend is
// serverless and cannot be trusted to finish work after a response, and this is
// the process that runs all day and holds the admin@ mailbox.
//
// So this file knows nothing about what a mail says or why it was queued. It
// claims the oldest due mail, looks up the member's current address, sends, and
// records what happened:
//
//   sent    — handed to the SMTP server
//   skipped — expired before it could go, or the member has no usable address
//   failed  — the server kept refusing it; `lastError` says why
//
// The address is read here, at send time, from quantum_logics.users — the
// outbox holds a user id and never an email.
//
// Needs the SMTP_* vars (see email.js) and nothing else. Without them the pass
// stands down and the queue simply waits; a mail still unsent when its
// `expiresAt` passes is dropped rather than delivered late.
const { sendEmail, mailUnavailableReason } = require("./email");

const OUTBOX = "emailOutbox";
// This pass's own row in the outbox: when it last ran and whether it could
// send. Never a mail (status "done"). It is what lets
// backend/scripts/checkEmailOutbox.js, run from anywhere, say "the worker
// cannot send, and here is why" instead of leaving a silent queue to be
// puzzled over — the same job the __worker__ doc does on each ledger.
const HEARTBEAT_KEY = "__worker__";

// Every member notification comes from this address, by name. The SMTP account
// (SMTP_USER) has to be this mailbox or be allowed to send as it.
const FROM = '"Quantum Logics" <admin@quantumlogicslimited.com>';

// A pass that finds a backlog works through it over a few ticks rather than
// opening dozens of SMTP sessions at once.
const BATCH_LIMIT = Number(process.env.MAILER_BATCH_LIMIT) || 25;
// How long a claimed mail is left alone. If the process dies mid-send the mail
// becomes due again after this — at worst a duplicate, never a lost alert.
const LEASE_MS = 10 * 60 * 1000;
// 2, 4, 8, 16, 32, 60, 60 minutes between tries: about three hours of a server
// refusing one message before it is written off.
const MAX_ATTEMPTS = 8;
const backoffMs = (attempts) => Math.min(2 ** attempts, 60) * 60 * 1000;

// Errors that are about the connection or the account, not this message. They
// would fail every mail in the queue identically, so the pass stops and the
// attempt is handed back instead of being counted against the mail.
const TRANSPORT_ERROR_CODES = new Set([
  "EAUTH",
  "ECONNECTION",
  "ECONNREFUSED",
  "ECONNRESET",
  "EDNS",
  "ENOTFOUND",
  "ESOCKET",
  "ETIMEDOUT",
  "ETLS",
]);
// The SMTP server's own verdict on one mail: a refused recipient, refused content.
const MESSAGE_ERROR_CODES = new Set(["EENVELOPE", "EMESSAGE"]);

// An error counts against a mail only when it is recognisably about that mail —
// the server answered and refused it. Everything else is treated as a fault of
// this install or its connection: it would hit every mail in the queue the same
// way, so charging each one an attempt just empties the queue into "failed".
// The list above used to be the whole test, and a missing dependency
// (MODULE_NOT_FOUND) fell through it as a per-message failure — see email.js.
const isAboutThisMessage = (err) => {
  if (TRANSPORT_ERROR_CODES.has(err?.code)) return false;
  if (MESSAGE_ERROR_CODES.has(err?.code)) return true;
  return Number(err?.responseCode) >= 400;
};

const isValidEmail = (value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || "").trim());

// Best-effort: the heartbeat describes the pass, it must never fail it.
const stampHeartbeat = async (outbox, summary, fault = "") => {
  const now = new Date();
  try {
    await outbox.updateOne(
      { dedupeKey: HEARTBEAT_KEY },
      {
        $set: { subject: summary, lastError: fault, updatedAt: now },
        $setOnInsert: { kind: "heartbeat", status: "done", createdAt: now },
      },
      { upsert: true },
    );
  } catch (err) {
    console.warn(`[mailer] heartbeat not written: ${err.message}`);
  }
};

/**
 * Deliver what is due in the outbox.
 *
 * @param {{ quantumConn: import("mongoose").Connection, rankingConn: import("mongoose").Connection }} connections
 * @returns {Promise<{ ran: boolean, reason?: string, sent?: number, skipped?: number, failed?: number, transportError?: string }>}
 */
const runMailer = async ({ quantumConn, rankingConn }, { limit = BATCH_LIMIT } = {}) => {
  const outbox = rankingConn.collection(OUTBOX);

  // Asked before anything is claimed, so mail queued while this install cannot
  // send simply waits — and the reason is on record for whoever goes looking.
  const unavailable = mailUnavailableReason();
  if (unavailable) {
    await stampHeartbeat(outbox, "standing down", unavailable);
    return { ran: false, reason: unavailable };
  }

  const users = quantumConn.collection("users");
  const finish = (mail, fields) =>
    outbox.updateOne({ _id: mail._id }, { $set: { ...fields, updatedAt: new Date() } });

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let transportError = "";

  for (let handled = 0; handled < limit; handled += 1) {
    const now = new Date();
    // Claim one mail atomically, so a second worker (or a second tick still
    // sending) can never pick the same one up.
    const mail = await outbox.findOneAndUpdate(
      { status: "pending", nextAttemptAt: { $lte: now } },
      {
        $set: { nextAttemptAt: new Date(now.getTime() + LEASE_MS), updatedAt: now },
        $inc: { attempts: 1 },
      },
      { sort: { nextAttemptAt: 1 }, returnDocument: "after" },
    );
    if (!mail) break;

    if (mail.expiresAt && mail.expiresAt < now) {
      await finish(mail, { status: "skipped", lastError: "expired before it could be sent" });
      skipped += 1;
      continue;
    }

    const user = mail.userId
      ? await users.findOne({ _id: mail.userId }, { projection: { email: 1 } })
      : null;
    if (!isValidEmail(user?.email)) {
      await finish(mail, { status: "skipped", lastError: "member has no deliverable address" });
      skipped += 1;
      continue;
    }

    try {
      await sendEmail({
        to: user.email,
        from: FROM,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      await finish(mail, { status: "sent", sentAt: new Date(), lastError: "" });
      sent += 1;
    } catch (err) {
      const message = String(err?.message || err).slice(0, 300);

      if (!isAboutThisMessage(err)) {
        await outbox.updateOne(
          { _id: mail._id },
          {
            $set: { nextAttemptAt: new Date(), lastError: message, updatedAt: new Date() },
            $inc: { attempts: -1 },
          },
        );
        transportError = message;
        break;
      }

      if (mail.attempts >= MAX_ATTEMPTS) {
        await finish(mail, { status: "failed", lastError: message });
        failed += 1;
      } else {
        await finish(mail, {
          nextAttemptAt: new Date(Date.now() + backoffMs(mail.attempts)),
          lastError: message,
        });
      }
      console.warn(`[mailer] ${mail.kind} to user ${mail.userId} failed: ${message}`);
    }
  }

  await stampHeartbeat(
    outbox,
    `${sent} sent, ${skipped} skipped, ${failed} failed`,
    transportError,
  );

  return { ran: true, sent, skipped, failed, ...(transportError && { transportError }) };
};

module.exports = { runMailer, OUTBOX, HEARTBEAT_KEY };
