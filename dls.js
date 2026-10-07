// Digital Logics Studio (DLS) XP sweep.
//
// Same doctrine as the GitHub and PolyCode passes: this worker owns every
// recurring outbound call and the backend only reads what lands here. XP a
// member earns on circuits.quantumlogicslimited.com is pulled into
// ranking.dlsStats, where backend/utils/dlsPoints.js scores it (5 XP = 1 point,
// at most 100 a day).
//
// How a DLS account is matched to a member: by email. DLS has no public
// username to link, but both apps key an account on its email, so a member who
// signs up on DLS with their portal email is matched with nothing to set up.
// Only members whose email this portal can vouch for are sent — verified by
// Google/OTP, or a vetted member — because sign-up here is open: without that,
// registering a throwaway portal account under someone else's address would
// collect their XP.
//
// The request is a POST with the addresses in the body (never a URL), carries
// a shared secret, and goes to our own DLS backend. What comes back is written
// keyed on users._id, so no email address is stored in the ranking DB.
//
// Days are asked for in Pakistan time (+05:00), the calendar the Explore boards
// run on, so a day's or week's board slices these rows exactly.
//
// OPTIONAL, and off unless configured. Set DLS_SYNC_SECRET to the value of
// COMMUNITY_SYNC_SECRET on the DLS backend; until then this pass stands down
// silently and DLS simply scores nothing.

const DLS_API_URL = (
  process.env.DLS_API_URL || "https://digital-logics-studio-backend.vercel.app"
).replace(/\/+$/, "");

const HEARTBEAT_KEY = "__worker__";
// The DLS endpoint takes at most 100 emails and has a 10kb body limit.
const EMAILS_PER_REQUEST = 50;
const DELAY_BETWEEN_BATCHES_MS = 300;
const REQUEST_TIMEOUT_MS = 20000;
const PKT_OFFSET_MINUTES = 5 * 60;
// A little past the 365-day rank window, so the oldest ranked day is covered
// whichever side of midnight the two calendars are on.
const LOOKBACK_DAYS = 370;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

// Inclusive PKT day key the sweep reaches back to.
const sinceKey = (now = new Date()) => {
  const shifted = new Date(now.getTime() + PKT_OFFSET_MINUTES * 60 * 1000);
  shifted.setUTCDate(shifted.getUTCDate() - LOOKBACK_DAYS);
  return shifted.toISOString().slice(0, 10);
};

// email (lowercase) -> users._id, for every member whose email we can vouch for.
const enumerateMembers = async ({ quantumConn }) => {
  const docs = await quantumConn
    .collection("users")
    .find({
      email: { $type: "string", $ne: "" },
      $or: [{ isEmailVerified: true }, { isVerified: true }],
    })
    .project({ email: 1 })
    .toArray();

  const userIdByEmail = new Map();
  for (const doc of docs) {
    const email = String(doc.email || "").trim().toLowerCase();
    if (email && !userIdByEmail.has(email)) {
      userIdByEmail.set(email, String(doc._id));
    }
  }
  return userIdByEmail;
};

const fetchXp = async (emails, secret) => {
  const res = await fetch(`${DLS_API_URL}/api/community/xp`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
      "User-Agent": "QuantumCommunity-ContributionWorker",
    },
    body: JSON.stringify({
      emails,
      since: sinceKey(),
      tzOffsetMinutes: PKT_OFFSET_MINUTES,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (res.status === 401 || res.status === 503) {
    // Wrong secret, or the DLS backend has none set. Every batch would fail the
    // same way, so the caller stops instead of logging it once per batch.
    const err = new Error(
      res.status === 401
        ? "DLS rejected DLS_SYNC_SECRET — it must equal COMMUNITY_SYNC_SECRET on the DLS backend"
        : "DLS has no COMMUNITY_SYNC_SECRET configured",
    );
    err.fatal = true;
    throw err;
  }
  if (!res.ok) throw new Error(`DLS API returned ${res.status}`);

  // A frontend host answers every path with the SPA's index.html (200 +
  // text/html) — that means DLS_API_URL points at the wrong domain.
  const contentType = String(res.headers.get("content-type") || "");
  if (!contentType.includes("application/json")) {
    throw new Error(
      `DLS API returned ${contentType || "unknown content type"} — check DLS_API_URL`,
    );
  }

  const data = await res.json();
  return Array.isArray(data?.accounts) ? data.accounts : [];
};

const buildOps = (userId, account) => {
  const now = new Date();

  const ops = (Array.isArray(account.days) ? account.days : [])
    .map((day) => ({
      date: String(day?.date || "").slice(0, 10),
      xp: num(day?.xp),
      solved: num(day?.solved),
      attempted: num(day?.attempted),
    }))
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date) && day.xp > 0)
    .map((day) => ({
      updateOne: {
        filter: { userId, date: day.date },
        // $max, like the other ledgers: XP for a day is earned once and only
        // ever goes up, so a short or half-failed response must not lower it.
        update: {
          $max: { xp: day.xp, solved: day.solved, attempted: day.attempted },
          $setOnInsert: { userId, date: day.date, updatedAt: now },
        },
        upsert: true,
      },
    }));

  const days = ops.length;

  // Its existence is what marks the member as having a DLS account — the day
  // page uses it to tell an idle day from someone who is not on DLS at all.
  ops.push({
    updateOne: {
      filter: { userId, date: "meta" },
      update: {
        $set: { totalXp: num(account.totalXp) },
        $setOnInsert: { userId, date: "meta", linkedAt: now },
      },
      upsert: true,
    },
  });

  return { ops, days };
};

/**
 * Refresh every matched member's DLS XP.
 *
 * @returns {Promise<{ ran: boolean, reason?: string, members?: number,
 *   accounts?: number, days?: number, changed?: number, failed?: number }>}
 */
const runDlsSweep = async ({ quantumConn, rankingConn }) => {
  const secret = process.env.DLS_SYNC_SECRET;
  if (!secret) {
    // Not an error: DLS scoring is opt-in. Reported so a manual `npm run dls`
    // says why nothing happened.
    return { ran: false, reason: "not configured (DLS_SYNC_SECRET)" };
  }

  const collection = rankingConn.collection("dlsStats");
  const userIdByEmail = await enumerateMembers({ quantumConn });
  const emails = [...userIdByEmail.keys()];

  let accounts = 0;
  let days = 0;
  let changed = 0;
  let failed = 0;

  for (let index = 0; index < emails.length; index += EMAILS_PER_REQUEST) {
    const batch = emails.slice(index, index + EMAILS_PER_REQUEST);
    try {
      for (const account of await fetchXp(batch, secret)) {
        // Only ever write for an address this batch asked about.
        const email = String(account?.email || "").trim().toLowerCase();
        const userId = batch.includes(email) ? userIdByEmail.get(email) : null;
        if (!userId) continue;

        const built = buildOps(userId, account);
        accounts += 1;
        days += built.days;

        const result = await collection.bulkWrite(built.ops, { ordered: false });
        changed += (result.upsertedCount || 0) + (result.modifiedCount || 0);
      }
    } catch (err) {
      // No heartbeat on a fatal error: the pass did not really run, and a fresh
      // heartbeat would hide that from anyone checking the ledger.
      if (err.fatal) throw err;
      failed += 1;
      console.warn(`[dls] batch ${index / EMAILS_PER_REQUEST + 1} failed: ${err.message}`);
    }

    if (index + EMAILS_PER_REQUEST < emails.length) {
      await sleep(DELAY_BETWEEN_BATCHES_MS);
    }
  }

  const now = new Date();
  await collection.updateOne(
    { userId: HEARTBEAT_KEY, date: "meta" },
    {
      $set: { lastRunAt: now, updatedAt: now, members: emails.length, accounts, failed },
      $setOnInsert: { userId: HEARTBEAT_KEY, date: "meta" },
    },
    { upsert: true },
  );

  return { ran: true, members: emails.length, accounts, days, changed, failed };
};

module.exports = { runDlsSweep, HEARTBEAT_KEY };
