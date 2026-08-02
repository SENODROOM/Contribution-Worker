// PolyCode XP sweep.
//
// Same doctrine as the GitHub passes in sweep.js: this worker owns every
// recurring outbound call and the backend only reads what lands here. PolyCode
// matters more than GitHub on that point — it is a *third-party* app (Team
// Mercury's), and the pages that need its numbers (/api/explore, public
// profiles) are unauthenticated, so a live fetch there would let any anonymous
// visitor spray requests at someone else's deployment.
//
// Cheap by comparison with the GitHub passes: one request per member with a
// linked account (12 at the time of writing), one full year of history per
// response, no rate limit worth pacing around.
//
// MIRRORS backend/utils/polycodeProgress.js (buildPolycodeDayRows,
// extractPolycodeSnapshot, polycodeXpToPoints) and the write shape in
// backend/utils/polycodeLedger.js writePolycodeProgress. This process has its
// own node_modules and cannot require them — keep the copies in sync.

const POLYCODE_API_URL = (
  process.env.POLYCODE_API_URL || "https://poly-code-backend.vercel.app"
).replace(/\/+$/, "");

const HEARTBEAT_KEY = "__worker__";
const DELAY_BETWEEN_USERS_MS = 400;
const REQUEST_TIMEOUT_MS = 12000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isValidPolycoder = (value) =>
  /^[a-zA-Z0-9_.-]{1,64}$/.test(String(value || ""));

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

// Distinct linked accounts from quantum_logics.users. Two portal users may
// point at the same PolyCode handle (a duplicate account), so this dedupes —
// fetching it twice would just cost an extra request for identical rows.
const enumeratePolycoders = async ({ quantumConn }) => {
  const docs = await quantumConn
    .collection("users")
    .find({ polycoder: { $type: "string", $ne: "" } })
    .project({ polycoder: 1 })
    .toArray();

  const handles = new Map(); // lowercase -> original casing
  for (const doc of docs) {
    const handle = String(doc.polycoder || "").trim();
    if (isValidPolycoder(handle)) handles.set(handle.toLowerCase(), handle);
  }
  return [...handles.values()];
};

const fetchProgress = async (polycoder) => {
  const res = await fetch(
    `${POLYCODE_API_URL}/api/auth/polycoder/${encodeURIComponent(polycoder)}/progress`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "QuantumCommunity-ContributionWorker",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );

  if (res.status === 404) {
    const err = new Error("no PolyCode account");
    err.notFound = true;
    throw err;
  }
  if (!res.ok) throw new Error(`PolyCode API returned ${res.status}`);

  // A frontend host answers every path with the SPA's index.html (200 +
  // text/html) — that means POLYCODE_API_URL points at the wrong domain.
  const contentType = String(res.headers.get("content-type") || "");
  if (!contentType.includes("application/json")) {
    throw new Error(
      `PolyCode API returned ${contentType || "unknown content type"} — check POLYCODE_API_URL`
    );
  }

  return res.json();
};

const buildDayRows = (data) => {
  const days = Array.isArray(data?.pointsByDay)
    ? data.pointsByDay
    : Array.isArray(data?.dailyXp?.days)
      ? data.dailyXp.days
      : [];

  return days
    .map((day) => ({
      date: String(day?.date || "").slice(0, 10),
      xp: num(day?.pointsEarned),
      lessonPoints: num(day?.lessonPoints),
      readBonusPoints: num(day?.readBonusPoints),
      lessonsCompleted: num(day?.lessonsCompleted),
    }))
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date));
};

// Whitelist, not the raw upstream objects: a public endpoint replays this.
const extractSnapshot = (data, rows) => {
  const overview = data?.overview || data?.summary || {};
  const profile = data?.profile || {};

  return {
    overview: {
      completedLessonsCount: num(overview.completedLessonsCount),
      totalMinutesSpent: num(overview.totalMinutesSpent),
      coursesStarted: num(overview.coursesStarted),
      totalDocumentsCompleted: num(overview.totalDocumentsCompleted),
      currentStreak: num(overview.currentStreak),
      highestStreak: num(overview.highestStreak),
    },
    profile: {
      username: String(profile.username || "").slice(0, 64),
      currentStreak: num(profile.currentStreak),
      highestStreak: num(profile.highestStreak),
    },
    totalXp:
      num(data?.dailyXp?.totalXp) ||
      num(data?.dailyXp?.totalPoints) ||
      num(overview.dailyXpTotal) ||
      rows.reduce((sum, day) => sum + day.xp, 0),
  };
};

const buildOps = (polycoder, data) => {
  const handle = polycoder.toLowerCase();
  const now = new Date();
  const rows = buildDayRows(data);

  const ops = rows.map((row) => ({
    updateOne: {
      filter: { polycoder: handle, date: row.date },
      // $max, like the GitHub ledger: a truncated or half-failed response must
      // never lower a day the member already earned.
      update: {
        $max: {
          xp: row.xp,
          lessonPoints: row.lessonPoints,
          readBonusPoints: row.readBonusPoints,
          lessonsCompleted: row.lessonsCompleted,
        },
        $setOnInsert: { polycoder: handle, date: row.date, updatedAt: now },
      },
      upsert: true,
    },
  }));

  ops.push({
    updateOne: {
      filter: { polycoder: handle, date: "meta" },
      // Point-in-time account state, so $set — a reset streak must be able to
      // come back down.
      update: {
        $set: { ...extractSnapshot(data, rows), updatedAt: now },
        $setOnInsert: { polycoder: handle, date: "meta" },
      },
      upsert: true,
    },
  });

  return { ops, days: rows.length };
};

/**
 * Refresh every linked member's PolyCode history.
 *
 * @returns {Promise<{ members: number, days: number, changed: number, failed: number }>}
 */
const runPolycodeSweep = async ({ quantumConn, rankingConn }) => {
  const collection = rankingConn.collection("polycodeStats");
  const handles = await enumeratePolycoders({ quantumConn });

  let days = 0;
  let changed = 0;
  let failed = 0;
  let missing = 0;

  for (const handle of handles) {
    try {
      const data = await fetchProgress(handle);
      const built = buildOps(handle, data);
      days += built.days;

      const result = await collection.bulkWrite(built.ops, { ordered: false });
      changed += (result.upsertedCount || 0) + (result.modifiedCount || 0);
    } catch (err) {
      // A deleted/renamed PolyCode account is normal attrition, not a fault —
      // its stored rows stay put so historical points don't vanish.
      if (err.notFound) missing += 1;
      else {
        failed += 1;
        console.warn(`[polycode] ${handle} failed: ${err.message}`);
      }
    }

    await sleep(DELAY_BETWEEN_USERS_MS);
  }

  const now = new Date();
  await collection.updateOne(
    { polycoder: HEARTBEAT_KEY, date: "meta" },
    {
      $set: { lastRunAt: now, updatedAt: now, members: handles.length, failed },
      $setOnInsert: { polycoder: HEARTBEAT_KEY, date: "meta" },
    },
    { upsert: true }
  );

  return { members: handles.length, days, changed, failed, missing };
};

module.exports = { runPolycodeSweep, HEARTBEAT_KEY };
