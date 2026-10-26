// Queueing a member email — the worker's own outbox writer.
//
// The portal backend sends and queues no member mail. Everything a member is
// emailed about is decided in this process (mailActivity.js, mailIdeas.js,
// mailSweeps.js), written to ranking.emailOutbox here, and delivered by
// mailer.js. One process owns the whole path, so a mail can only be late when
// this worker is down — and then every one of them is.
//
// `dedupeKey` is what makes a notification the same notification: each trigger
// can fire twice (a worker restarted mid-pass, a second install running by
// mistake), so a mail is named by its event ("medal:day:2026-10-06:<userId>")
// and inserted with $setOnInsert under a unique index.
//
// The address is deliberately not stored: `userId` is `users._id` in
// quantum_logics and mailer.js reads the email at send time, so the ranking DB
// holds nobody's address.
//
// Nothing here throws at its caller: a mail is a courtesy on top of something
// that already happened, so each path answers with a result instead.
const OUTBOX = "emailOutbox";
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EXPIRY_DAYS = 7;

// Every spelling of a member's Discord id on a users doc.
const DISCORD_ID_FIELDS = ["discordId", "discordID", "DiscordID"];

/**
 * Make sure the outbox's indexes exist. They were built by the backend's
 * mongoose model, which no longer runs on any request path, so the worker
 * states them itself — identical definitions, so this is a no-op where they
 * already are.
 */
const ensureOutboxIndexes = async (rankingConn) => {
  const outbox = rankingConn.collection(OUTBOX);
  await outbox.createIndex({ dedupeKey: 1 }, { unique: true });
  await outbox.createIndex({ status: 1, nextAttemptAt: 1 });
  await outbox.createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
};

/**
 * The portal account behind a Discord id, or null. A member whose id lives only
 * on an Employee or DiscordRecord has no account to sign in with and gets no
 * mail.
 */
const findRecipientByDiscordId = async (quantumConn, discordId) => {
  const id = String(discordId || "").trim();
  if (!id || id === "none") return null;
  try {
    return await quantumConn
      .collection("users")
      .findOne(
        { $or: DISCORD_ID_FIELDS.map((field) => ({ [field]: id })) },
        { projection: { name: 1, githubUrl: 1, email: 1 } },
      );
  } catch (err) {
    console.warn(`[mail] recipient lookup failed for ${id}: ${err.message}`);
    return null;
  }
};

/**
 * Queue one email to one member.
 *
 * @param {import("mongoose").Connection} rankingConn
 * @param {object} mail
 * @param {*} mail.userId users._id (ObjectId)
 * @param {string} mail.kind what it is, for the log
 * @param {string} mail.dedupeKey a second queue with the same key is a no-op
 * @param {{ subject: string, text: string, html: string }} mail.email a rendered template
 * @param {number} [mail.expiresInDays] unsent after this long, it is dropped
 * @returns {Promise<{ queued: boolean, reason?: string }>}
 */
const queueMemberEmail = async (
  rankingConn,
  { userId, kind, dedupeKey, email, expiresInDays = DEFAULT_EXPIRY_DAYS },
) => {
  if (!userId || !dedupeKey || !email?.subject) {
    return { queued: false, reason: "INCOMPLETE" };
  }

  const now = new Date();
  try {
    const result = await rankingConn.collection(OUTBOX).updateOne(
      { dedupeKey },
      {
        $setOnInsert: {
          dedupeKey,
          kind,
          userId,
          subject: email.subject,
          text: email.text || "",
          html: email.html || "",
          status: "pending",
          attempts: 0,
          lastError: "",
          nextAttemptAt: now,
          expiresAt: new Date(now.getTime() + expiresInDays * DAY_MS),
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    return result.upsertedCount > 0
      ? { queued: true }
      : { queued: false, reason: "DUPLICATE" };
  } catch (err) {
    // Two passes racing on one key: the unique index refused the second.
    if (err?.code === 11000) return { queued: false, reason: "DUPLICATE" };
    console.warn(`[mail] could not queue ${kind} (${dedupeKey}): ${err.message}`);
    return { queued: false, reason: "ERROR" };
  }
};

/** Whether a recurring sweep has already run for its period. */
const hasSweepMarker = async (rankingConn, dedupeKey) =>
  Boolean(
    await rankingConn.collection(OUTBOX).findOne({ dedupeKey }, { projection: { _id: 1 } }),
  );

/** The marker keys among `keys` that already exist. */
const existingSweepMarkers = async (rankingConn, keys) => {
  if (!keys.length) return new Set();
  const rows = await rankingConn
    .collection(OUTBOX)
    .find({ dedupeKey: { $in: keys } }, { projection: { dedupeKey: 1 } })
    .toArray();
  return new Set(rows.map((row) => row.dedupeKey));
};

/** Mark a recurring sweep as done for its period — written last, so a sweep that died is retried. */
const writeSweepMarker = async (rankingConn, dedupeKey, summary = "") => {
  const now = new Date();
  try {
    await rankingConn.collection(OUTBOX).updateOne(
      { dedupeKey },
      {
        $setOnInsert: {
          dedupeKey,
          kind: "sweep_marker",
          status: "done",
          subject: summary,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
};

/**
 * A producer's place in an append-only collection (the activity log, idea
 * comments): the last `_id` it has handled. Kept in the outbox beside the
 * heartbeat so there is one collection to look at, and never a mail.
 */
const readCursor = async (rankingConn, key) => {
  const row = await rankingConn
    .collection(OUTBOX)
    .findOne({ dedupeKey: key }, { projection: { cursor: 1 } });
  return row?.cursor || null;
};

const writeCursor = async (rankingConn, key, cursor) => {
  const now = new Date();
  await rankingConn.collection(OUTBOX).updateOne(
    { dedupeKey: key },
    {
      $set: { cursor, updatedAt: now },
      $setOnInsert: { dedupeKey: key, kind: "cursor", status: "done", createdAt: now },
    },
    { upsert: true },
  );
};

module.exports = {
  OUTBOX,
  DISCORD_ID_FIELDS,
  ensureOutboxIndexes,
  findRecipientByDiscordId,
  queueMemberEmail,
  hasSweepMarker,
  existingSweepMarkers,
  writeSweepMarker,
  readCursor,
  writeCursor,
};
