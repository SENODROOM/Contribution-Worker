const mongoose = require("mongoose");

// 2.5s keeps the PR search under GitHub's 30 search requests/min limit.
const DELAY_BETWEEN_USERS_MS = 2500;
const EVENT_PAGES = [1, 2, 3];
const PR_SEARCH_MAX_PAGES = 3;

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

const githubHeaders = () => {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "QuantumCommunity-ContributionWorker",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `token ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
};

// ─── GitHub fetchers ─────────────────────────────────────────────────────────
// Per-day commit detail from the public events API (~90 days / 300 events).
//
// NOTE: this file mirrors backend/utils/githubSweep.js, which the backend runs
// itself (lazy per-user refresh + the scheduled slice). Keep the two in sync —
// they write the same collection.
//
// PRs are counted here only as a fallback for when the search below fails: the
// event stream carries one PullRequestEvent per *action* (opened, closed,
// merged, reopened…), so counting them all inflates a member's PR total —
// 15 events for 10 real PRs was typical. Only "opened" maps 1:1 to a PR.
const fetchEventDetails = async (username) => {
  const headers = githubHeaders();

  const pages = await Promise.allSettled(
    EVENT_PAGES.map((page) =>
      fetch(
        `https://api.github.com/users/${encodeURIComponent(username)}/events/public?per_page=100&page=${page}`,
        { headers, signal: AbortSignal.timeout(8000) }
      )
    )
  );

  const detailsByDate = new Map();
  // Oldest event of ANY type marks how far back the events API actually
  // covers for this user — persisted as the coverage boundary.
  let oldestEventDate = null;
  for (const result of pages) {
    if (result.status !== "fulfilled" || !result.value.ok) continue;

    try {
      const events = await result.value.json();
      if (!Array.isArray(events)) continue;

      for (const event of events) {
        const date = event.created_at?.slice(0, 10);
        if (!date) continue;
        if (!oldestEventDate || date < oldestEventDate) oldestEventDate = date;

        const detail =
          detailsByDate.get(date) || { date, commits: 0, pullRequests: 0 };
        if (event.type === "PushEvent") {
          detail.commits += event.payload?.commits?.length || 1;
        }
        if (
          event.type === "PullRequestEvent" &&
          event.payload?.action === "opened"
        ) {
          detail.pullRequests += 1;
        }
        detailsByDate.set(date, detail);
      }
    } catch {}
  }

  return { detailsByDate, oldestEventDate };
};

// Full-year PR history via the search API — unlike the events API this has
// no ~90-day retention limit, so old PRs keep their ×5 points. It also counts
// each PR exactly once, on the day it was created, so when it completes
// cleanly it is authoritative and overwrites stored counts (see buildOps).
//
// `complete` is false whenever a page errored, was rate limited, or the result
// was truncated at the page cap — then the data is only a lower bound.
const fetchPullRequestHistory = async (username, fromKey) => {
  const prsByDate = new Map();
  const query = `type:pr author:${username} created:>=${fromKey}`;
  let retried = false;
  let complete = false;

  for (let page = 1; page <= PR_SEARCH_MAX_PAGES; page++) {
    let res;
    try {
      res = await fetch(
        `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}`,
        { headers: githubHeaders(), signal: AbortSignal.timeout(10000) }
      );
    } catch {
      break;
    }

    // Search rate limit (30/min with token) — wait for the window to reset
    // and retry this page once.
    if (res.status === 403 || res.status === 429) {
      if (retried) break;
      retried = true;
      await sleep(65000);
      page -= 1;
      continue;
    }
    if (!res.ok) break;

    try {
      const json = await res.json();
      const items = Array.isArray(json?.items) ? json.items : [];
      for (const pr of items) {
        const date = pr.created_at?.slice(0, 10);
        if (date) prsByDate.set(date, (prsByDate.get(date) || 0) + 1);
      }
      if (items.length < 100) {
        complete = true;
        break;
      }
      if (page === PR_SEARCH_MAX_PAGES) {
        // Only trustworthy if the cap happened to be the exact total.
        complete = (Number(json?.total_count) || 0) <= PR_SEARCH_MAX_PAGES * 100;
      }
    } catch {
      break;
    }
  }

  return { prsByDate, complete };
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
const buildOps = (
  username,
  detailsByDate,
  calendarByDate,
  prHistoryByDate,
  prsAuthoritative,
  oldestEventDate,
  fromKey,
) => {
  const lower = username.toLowerCase();
  const dates = new Set([
    ...detailsByDate.keys(),
    ...calendarByDate.keys(),
    ...prHistoryByDate.keys(),
  ]);
  const now = new Date();
  const ops = [];

  for (const date of dates) {
    const detail = detailsByDate.get(date) || {};
    const commits = detail.commits || 0;
    // The search only covers the window it was asked for; older days keep
    // whatever was recorded while they were still inside a search window.
    const authoritative = prsAuthoritative && date >= fromKey;
    const searchPrs = prHistoryByDate.get(date) || 0;
    const pullRequests = authoritative
      ? searchPrs
      : Math.max(detail.pullRequests || 0, searchPrs);
    const calendarCount = calendarByDate.get(date) || 0;
    if (commits === 0 && pullRequests === 0 && calendarCount === 0) continue;

    // $max: expiring events can never reduce what was already recorded. PRs
    // are the exception when authoritative — they get $set so an over-count
    // from the old event-based logic is corrected rather than frozen in place.
    // (A field must appear in only one operator, never both.)
    const $max = { commits, calendarCount };
    const $set = { updatedAt: now };
    if (authoritative) $set.pullRequests = pullRequests;
    else $max.pullRequests = pullRequests;

    ops.push({
      updateOne: {
        filter: { username: lower, date },
        update: { $max, $set, $setOnInsert: { username: lower, date } },
        upsert: true,
      },
    });
  }

  // Meta doc: the earliest date the events API was ever observed to cover
  // for this user. The backend scores days before this boundary with the
  // calendar+PR hybrid formula instead of expecting event detail.
  // `lastSweepAt` is the claim the backend's own sweeps throttle against, so
  // whichever writer runs, the other one stands down for a while.
  const metaUpdate = {
    $set: { updatedAt: now, lastSweepAt: now },
    $setOnInsert: { username: lower, date: "meta" },
  };
  if (oldestEventDate) metaUpdate.$min = { eventCoverageSince: oldestEventDate };
  ops.push({
    updateOne: {
      filter: { username: lower, date: "meta" },
      update: metaUpdate,
      upsert: true,
    },
  });

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

    const from = new Date();
    from.setUTCDate(from.getUTCDate() - 364);
    const fromKey = from.toISOString().slice(0, 10);
    const toKey = new Date().toISOString().slice(0, 10);

    for (const username of usernames) {
      try {
        const [eventResult, calendarByDate, prHistory] = await Promise.all([
          fetchEventDetails(username),
          fetchCalendarCounts(username),
          fetchPullRequestHistory(username, fromKey),
        ]);

        const ops = buildOps(
          username,
          eventResult.detailsByDate,
          calendarByDate,
          prHistory.prsByDate,
          prHistory.complete,
          eventResult.oldestEventDate,
          fromKey,
        );
        if (ops.length > 0) {
          const result = await statsCollection.bulkWrite(ops, {
            ordered: false,
          });
          written += result.upsertedCount + result.modifiedCount;
        }

        // Days that used to hold a PR count but have none in the authoritative
        // history (pure event-inflation) are not in `ops` at all, so clear them
        // explicitly — otherwise the old value would survive forever.
        let repaired = 0;
        if (prHistory.complete) {
          const cleared = await statsCollection.updateMany(
            {
              username: username.toLowerCase(),
              date: {
                $gte: fromKey,
                $lte: toKey,
                $nin: [...prHistory.prsByDate.keys()],
              },
              pullRequests: { $gt: 0 },
            },
            { $set: { pullRequests: 0, updatedAt: new Date() } },
          );
          repaired = cleared.modifiedCount || 0;
        }

        console.log(
          `[sweep] ${username}: ${ops.length - 1} day(s) upserted` +
            (repaired ? `, ${repaired} inflated PR day(s) cleared` : ""),
        );
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
