const mongoose = require("mongoose");

const DELAY_BETWEEN_USERS_MS = 1500;
const EVENT_PAGES = [1, 2, 3];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Same extraction logic as frontend/src/utils/github.js getGithubUsername.
const getGithubUsername = (githubUrl) => {
  if (!githubUrl || typeof githubUrl !== "string" || !githubUrl.trim()) {
    return null;
  }
  try {
    const normalized = githubUrl.startsWith("http")
      ? githubUrl
      : `https://github.com/${githubUrl.replace(/^@/, "")}`;
    const url = new URL(normalized);
    const u = url.pathname.split("/").filter(Boolean)[0];
    return /^[a-zA-Z0-9-]+$/.test(u) ? u : null;
  } catch {
    const u = githubUrl.replace(/^@/, "").split("/").filter(Boolean)[0];
    return /^[a-zA-Z0-9-]+$/.test(u) ? u : null;
  }
};

// ─── Username enumeration ────────────────────────────────────────────────────
// Collects GitHub usernames from quantum_logics.users, quantum_logics.employees
// and ranking.teamState (captains + members). Dedupes case-insensitively.
const enumerateUsernames = async ({ quantumConn, rankingConn }) => {
  const usernames = new Map(); // lowercase -> original casing

  const add = (githubUrl) => {
    const username = getGithubUsername(githubUrl);
    if (username) usernames.set(username.toLowerCase(), username);
  };

  const users = await quantumConn
    .collection("users")
    .find({ githubUrl: { $type: "string", $ne: "" } })
    .project({ githubUrl: 1 })
    .toArray();
  for (const doc of users) add(doc.githubUrl);

  const employees = await quantumConn
    .collection("employees")
    .find({ githubUrl: { $type: "string", $ne: "" } })
    .project({ githubUrl: 1 })
    .toArray();
  for (const doc of employees) add(doc.githubUrl);

  const teams = await rankingConn
    .collection("teamState")
    .find({})
    .project({
      "TeamCaptain.githubUrl": 1,
      "ProjectCaptain.githubUrl": 1,
      "members.githubUrl": 1,
    })
    .toArray();
  for (const team of teams) {
    add(team.TeamCaptain?.githubUrl);
    add(team.ProjectCaptain?.githubUrl);
    for (const member of team.members || []) add(member.githubUrl);
  }

  return [...usernames.values()];
};

// ─── GitHub fetchers ─────────────────────────────────────────────────────────
// Per-day commit/PR detail from the public events API (~90 days / 300 events).
// Same logic as fetchPublicEventDetails in backend/routes/github.js.
const fetchEventDetails = async (username) => {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "QuantumCommunity-ContributionWorker",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `token ${process.env.GITHUB_TOKEN}`;
  }

  const pages = await Promise.allSettled(
    EVENT_PAGES.map((page) =>
      fetch(
        `https://api.github.com/users/${encodeURIComponent(username)}/events/public?per_page=100&page=${page}`,
        { headers, signal: AbortSignal.timeout(8000) }
      )
    )
  );

  const detailsByDate = new Map();
  for (const result of pages) {
    if (result.status !== "fulfilled" || !result.value.ok) continue;

    try {
      const events = await result.value.json();
      if (!Array.isArray(events)) continue;

      for (const event of events) {
        const date = event.created_at?.slice(0, 10);
        if (!date) continue;

        const detail =
          detailsByDate.get(date) || { date, commits: 0, pullRequests: 0 };
        if (event.type === "PushEvent") {
          detail.commits += event.payload?.commits?.length || 1;
        }
        if (event.type === "PullRequestEvent") {
          detail.pullRequests += 1;
        }
        detailsByDate.set(date, detail);
      }
    } catch {}
  }

  return detailsByDate;
};

// Per-day contribution calendar counts for the last year (public data).
const fetchCalendarCounts = async (username) => {
  const countsByDate = new Map();
  try {
    const res = await fetch(
      `https://github-contributions-api.jogruber.de/v4/${encodeURIComponent(username)}?y=last`,
      {
        headers: {
          "User-Agent": "QuantumCommunity-ContributionWorker",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(12000),
      }
    );
    if (!res.ok) return countsByDate;

    const json = await res.json();
    for (const c of json?.contributions || []) {
      if (c.date && (c.count || 0) > 0) countsByDate.set(c.date, c.count);
    }
  } catch {}
  return countsByDate;
};

// ─── Upsert ──────────────────────────────────────────────────────────────────
const buildOps = (username, detailsByDate, calendarByDate) => {
  const lower = username.toLowerCase();
  const dates = new Set([...detailsByDate.keys(), ...calendarByDate.keys()]);
  const now = new Date();
  const ops = [];

  for (const date of dates) {
    const detail = detailsByDate.get(date) || {};
    const commits = detail.commits || 0;
    const pullRequests = detail.pullRequests || 0;
    const calendarCount = calendarByDate.get(date) || 0;
    if (commits === 0 && pullRequests === 0 && calendarCount === 0) continue;

    ops.push({
      updateOne: {
        filter: { username: lower, date },
        // $max: expiring events can never reduce what was already recorded.
        update: {
          $max: { commits, pullRequests, calendarCount },
          $set: { updatedAt: now },
          $setOnInsert: { username: lower, date },
        },
        upsert: true,
      },
    });
  }

  return ops;
};

const runSweep = async ({ quantumUri, rankingUri }) => {
  const startedAt = Date.now();
  const quantumConn = await mongoose
    .createConnection(quantumUri, { bufferCommands: false })
    .asPromise();
  const rankingConn = await mongoose
    .createConnection(rankingUri, { bufferCommands: false })
    .asPromise();

  try {
    const statsCollection = rankingConn.collection("githubContributionStats");
    await statsCollection.createIndex(
      { username: 1, date: 1 },
      { unique: true }
    );

    const usernames = await enumerateUsernames({ quantumConn, rankingConn });
    console.log(`[sweep] ${usernames.length} GitHub username(s) found`);

    let written = 0;
    let failed = 0;

    for (const username of usernames) {
      try {
        const [detailsByDate, calendarByDate] = await Promise.all([
          fetchEventDetails(username),
          fetchCalendarCounts(username),
        ]);

        const ops = buildOps(username, detailsByDate, calendarByDate);
        if (ops.length > 0) {
          const result = await statsCollection.bulkWrite(ops, {
            ordered: false,
          });
          written += result.upsertedCount + result.modifiedCount;
        }
        console.log(`[sweep] ${username}: ${ops.length} day(s) upserted`);
      } catch (err) {
        failed += 1;
        console.warn(`[sweep] ${username} failed: ${err.message}`);
      }

      await sleep(DELAY_BETWEEN_USERS_MS);
    }

    console.log(
      `[sweep] done in ${Math.round((Date.now() - startedAt) / 1000)}s — ` +
        `${usernames.length} user(s), ${written} write(s), ${failed} failure(s)`
    );
  } finally {
    await Promise.allSettled([quantumConn.close(), rankingConn.close()]);
  }
};

module.exports = { runSweep, getGithubUsername };
