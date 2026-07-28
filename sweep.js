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

// ─── Per-day commits (GraphQL) ───────────────────────────────────────────────
// The events API is capped at ~300 events, which for a prolific member is a
// few percent of a year: one account's 7506 commits showed up there as 460.
// GraphQL reports exact per-day commit counts for the whole year instead.
//
// Asked in four ~91-day windows because `contributions(first: 100)` is per
// repository — over a full year a busy repo blows past 100 contribution days
// and silently truncates, while inside a quarter it cannot. `maxRepositories:
// 100` still caps very broad members, so this raises `commits`, never lowers.
const COMMIT_WINDOW_COUNT = 4;
const COMMIT_WINDOW_DAYS = 91;

const COMMIT_QUERY = `query($login:String!,$from:DateTime!,$to:DateTime!){
  user(login:$login){
    contributionsCollection(from:$from,to:$to){
      commitContributionsByRepository(maxRepositories:100){
        contributions(first:100){
          nodes{ occurredAt commitCount }
        }
      }
    }
  }
}`;

const fetchCommitContributions = async (username) => {
  const commitsByDate = new Map();
  if (!process.env.GITHUB_TOKEN) return commitsByDate;

  const now = new Date();
  const windows = [];
  for (let i = COMMIT_WINDOW_COUNT - 1; i >= 0; i--) {
    const to = new Date(now);
    to.setUTCDate(now.getUTCDate() - i * COMMIT_WINDOW_DAYS);
    const from = new Date(to);
    from.setUTCDate(to.getUTCDate() - (COMMIT_WINDOW_DAYS - 1));
    windows.push({ from: from.toISOString(), to: to.toISOString() });
  }

  const results = await Promise.allSettled(
    windows.map((window) =>
      fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `bearer ${process.env.GITHUB_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: COMMIT_QUERY,
          variables: { login: username, ...window },
        }),
        signal: AbortSignal.timeout(15000),
      })
    )
  );

  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value.ok) continue;
    try {
      const json = await result.value.json();
      const repos =
        json?.data?.user?.contributionsCollection?.commitContributionsByRepository;
      if (!Array.isArray(repos)) continue;

      for (const repo of repos) {
        for (const node of repo?.contributions?.nodes || []) {
          const date = node.occurredAt?.slice(0, 10);
          if (!date) continue;
          commitsByDate.set(
            date,
            (commitsByDate.get(date) || 0) + (node.commitCount || 0)
          );
        }
      }
    } catch {}
  }

  return commitsByDate;
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
  commitsByDate,
  prsAuthoritative,
  oldestEventDate,
  fromKey,
) => {
  const lower = username.toLowerCase();
  const dates = new Set([
    ...detailsByDate.keys(),
    ...calendarByDate.keys(),
    ...prHistoryByDate.keys(),
    ...commitsByDate.keys(),
  ]);
  const now = new Date();
  const ops = [];

  for (const date of dates) {
    const detail = detailsByDate.get(date) || {};
    // GraphQL is the accurate source; events only ever fill gaps it can't see
    // (repos past the maxRepositories cap, or no token configured).
    const commits = Math.max(detail.commits || 0, commitsByDate.get(date) || 0);
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

// ─── Fast pass: recent activity for everyone ─────────────────────────────────
// The full sweep below costs ~9 requests per member and is bounded by the
// search API's 30/min, so it can only run daily. That is far too slow for
// "I pushed a commit, why is my dashboard not moving".
//
// GraphQL aliases fix it: one request carries the last few days for ~35
// members and costs a single rate-limit point, so the whole community fits in
// ~10 requests (5000/hour available) and can run every couple of minutes.
// Recent days are the only ones that can change — history is already in the
// ledger — so this is the only thing that has to run often.
const RECENT_WINDOW_DAYS = 3;
const RECENT_BATCH_SIZE = 35;
const RECENT_BATCH_CONCURRENCY = 7;

// Heartbeat doc. The backend reads this to tell whether this worker is alive;
// without it, a stopped worker silently freezes every number in the portal —
// which is exactly what happened between 2026-06-09 and 2026-06-28.
const HEARTBEAT_KEY = "__worker__";

const recentFragment = (alias, login) => `
  ${alias}: user(login: "${login}") {
    contributionsCollection(from: $from, to: $to) {
      commitContributionsByRepository(maxRepositories: 25) {
        contributions(first: 5) { nodes { occurredAt commitCount } }
      }
      pullRequestContributions(first: 25) {
        nodes { pullRequest { createdAt } }
      }
    }
  }`;

const fetchRecentBatch = async (handles, { from, to }) => {
  const results = new Map();
  // Handles are interpolated into the query, so they must be exactly what
  // GitHub allows in a login. getGithubUsername already guarantees it; this is
  // the second lock on it.
  const safe = handles.filter((h) => /^[a-zA-Z0-9-]+$/.test(h));
  if (safe.length === 0) return results;

  const query = `query($from:DateTime!,$to:DateTime!){${safe
    .map((handle, index) => recentFragment(`u${index}`, handle))
    .join("\n")}\n}`;

  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { from, to } }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL returned ${res.status}`);

  const json = await res.json();
  safe.forEach((handle, index) => {
    // A bad login nulls its own alias and reports an error while every other
    // alias still resolves, so partial data is normal here.
    const cc = json?.data?.[`u${index}`]?.contributionsCollection;
    if (!cc) return;

    const commitsByDate = new Map();
    for (const repo of cc.commitContributionsByRepository || []) {
      for (const node of repo?.contributions?.nodes || []) {
        const date = node.occurredAt?.slice(0, 10);
        if (!date) continue;
        commitsByDate.set(
          date,
          (commitsByDate.get(date) || 0) + (node.commitCount || 0)
        );
      }
    }

    const prsByDate = new Map();
    for (const node of cc.pullRequestContributions?.nodes || []) {
      const date = node?.pullRequest?.createdAt?.slice(0, 10);
      if (date) prsByDate.set(date, (prsByDate.get(date) || 0) + 1);
    }

    results.set(handle.toLowerCase(), { commitsByDate, prsByDate });
  });

  return results;
};

const buildRecentOps = (byHandle) => {
  const now = new Date();
  const ops = [];

  for (const [handle, { commitsByDate, prsByDate }] of byHandle) {
    for (const date of new Set([...commitsByDate.keys(), ...prsByDate.keys()])) {
      const commits = commitsByDate.get(date) || 0;
      const pullRequests = prsByDate.get(date) || 0;
      if (commits === 0 && pullRequests === 0) continue;

      ops.push({
        updateOne: {
          filter: { username: handle, date },
          // Deliberately no `$set: { updatedAt }`: this runs every couple of
          // minutes, and touching a field every pass would make every write
          // count as a modification. A pure $max update means modifiedCount is
          // exactly "someone's numbers went up".
          update: {
            $max: { commits, pullRequests },
            $setOnInsert: { username: handle, date, updatedAt: now },
          },
          upsert: true,
        },
      });
    }
  }

  return ops;
};

const writeHeartbeat = async (statsCollection, extra = {}) => {
  const now = new Date();
  await statsCollection.updateOne(
    { username: HEARTBEAT_KEY, date: "meta" },
    {
      $set: { updatedAt: now, lastRecentAt: now, ...extra },
      $setOnInsert: { username: HEARTBEAT_KEY, date: "meta" },
    },
    { upsert: true }
  );
};

/**
 * Refresh the last few days for every member. One pass ≈ 10 GraphQL requests
 * and ~12s for ~350 members.
 *
 * @returns {Promise<{ members: number, days: number, changed: number }>}
 */
const runRecentSweep = async ({ quantumConn, rankingConn }) => {
  const statsCollection = rankingConn.collection("githubContributionStats");
  const handles = await enumerateUsernames({ quantumConn, rankingConn });
  if (handles.length === 0 || !process.env.GITHUB_TOKEN) {
    return { members: 0, days: 0, changed: 0 };
  }

  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(to.getUTCDate() - RECENT_WINDOW_DAYS);
  const window = { from: from.toISOString(), to: to.toISOString() };

  const batches = [];
  for (let i = 0; i < handles.length; i += RECENT_BATCH_SIZE) {
    batches.push(handles.slice(i, i + RECENT_BATCH_SIZE));
  }

  const byHandle = new Map();
  const errors = [];
  for (let i = 0; i < batches.length; i += RECENT_BATCH_CONCURRENCY) {
    const settled = await Promise.allSettled(
      batches
        .slice(i, i + RECENT_BATCH_CONCURRENCY)
        .map((batch) => fetchRecentBatch(batch, window))
    );
    for (const result of settled) {
      // Never swallow these. A pass that quietly returns nothing looks exactly
      // like a pass where nobody committed, which is how a broken pipeline goes
      // unnoticed for weeks.
      if (result.status !== "fulfilled") {
        errors.push(result.reason?.message || String(result.reason));
        continue;
      }
      for (const [handle, data] of result.value) byHandle.set(handle, data);
    }
  }

  if (errors.length > 0) {
    console.warn(
      `[recent] ${errors.length}/${batches.length} batch(es) failed: ${errors[0]}`
    );
  }

  const ops = buildRecentOps(byHandle);
  let changed = 0;
  if (ops.length > 0) {
    const result = await statsCollection.bulkWrite(ops, { ordered: false });
    changed = (result.upsertedCount || 0) + (result.modifiedCount || 0);
  }

  await writeHeartbeat(statsCollection, { recentMembers: byHandle.size });
  return { members: byHandle.size, days: ops.length, changed };
};

/**
 * Open both connections once. The recent sweep runs every couple of minutes,
 * so it must not pay for a fresh connection handshake each time — the caller
 * opens these at startup and hands them to every pass.
 */
const openConnections = async ({ quantumUri, rankingUri }) => {
  const quantumConn = await mongoose
    .createConnection(quantumUri, { bufferCommands: false })
    .asPromise();
  const rankingConn = await mongoose
    .createConnection(rankingUri, { bufferCommands: false })
    .asPromise();

  await rankingConn
    .collection("githubContributionStats")
    .createIndex({ username: 1, date: 1 }, { unique: true });

  return {
    quantumConn,
    rankingConn,
    close: () =>
      Promise.allSettled([quantumConn.close(), rankingConn.close()]),
  };
};

const runSweep = async ({ quantumConn, rankingConn }) => {
  const startedAt = Date.now();

  {
    const statsCollection = rankingConn.collection("githubContributionStats");

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
        const [eventResult, calendarByDate, prHistory, commitsByDate] =
          await Promise.all([
            fetchEventDetails(username),
            fetchCalendarCounts(username),
            fetchPullRequestHistory(username, fromKey),
            fetchCommitContributions(username),
          ]);

        const ops = buildOps(
          username,
          eventResult.detailsByDate,
          calendarByDate,
          prHistory.prsByDate,
          commitsByDate,
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

    await writeHeartbeat(statsCollection, {
      lastFullAt: new Date(),
      fullMembers: usernames.length,
    });

    console.log(
      `[sweep] done in ${Math.round((Date.now() - startedAt) / 1000)}s — ` +
        `${usernames.length} user(s), ${written} write(s), ${failed} failure(s)`
    );

    return { members: usernames.length, written, failed };
  }
};

module.exports = {
  openConnections,
  runSweep,
  runRecentSweep,
  getGithubUsername,
  HEARTBEAT_KEY,
};
