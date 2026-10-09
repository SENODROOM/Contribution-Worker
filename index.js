// Force known-good DNS servers before anything else runs. Node's bundled
// resolver (c-ares) auto-detects the system's DNS servers separately from
// Windows' own resolver, and on this machine it was picking up `127.0.0.1`
// (nothing listens there — likely a stale leftover from a VPN or local DNS
// proxy that used to bind that address) while `nslookup` correctly used the
// real router (192.168.100.1) and worked fine. That mismatch was the actual
// cause of the mongodb+srv:// "querySrv ECONNREFUSED" crash loop that took
// this worker down for ~3 days (2026-07-28 to 2026-07-31) — not an IPv6
// preference issue, not a MongoDB Atlas problem, not a code bug. Confirmed
// directly: `require('dns').getServers()` printed `['127.0.0.1']` here.
// Bypassing whatever is misdetecting the system resolver, rather than
// depending on it, is more robust than chasing the OS-level root cause.
require("dns").setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

require("dotenv").config();
const { openConnections, runSweep, runRecentSweep } = require("./sweep");
const { runPolycodeSweep } = require("./polycode");
const { runDlsSweep } = require("./dls");
const { runAchieverFinalize, FINALIZE_HOUR_PKT } = require("./achievers");
const { runLeaderboardRebuild } = require("./leaderboard");
const { runMailer } = require("./mailer");

// This worker owns every recurring GitHub and PolyCode call for the portal. The
// backend is deployed on Vercel and only reads what lands here — it makes no
// requests to either of its own — so if this process stops, every commit/PR and
// XP number in the portal freezes at the moment it died. Watch it (`pm2
// status`, and the heartbeats this writes into each ledger's __worker__ meta
// doc).
//
// Three passes on very different cadences:
//
//   recent   — every RECENT_INTERVAL_MINUTES (default 2). Batched GraphQL, ~10
//              requests for the whole community, so a push shows up in the
//              portal within a couple of minutes.
//   full     — every SWEEP_INTERVAL_HOURS (default 24). ~9 requests per member
//              and bounded by the search API's 30/min, so it can only run
//              daily. Owns exact PR history, the contribution calendar, and
//              repair of days the fast pass can't correct.
//   polycode — every POLYCODE_INTERVAL_MINUTES (default 15). One request per
//              member with a linked account (~12), each returning a full year.
//              Slower than `recent` on purpose: it points at a third-party
//              deployment, and XP does not need two-minute freshness.
//   dls      — every DLS_INTERVAL_MINUTES (default 5). Digital Logics Studio XP
//              for every member, a handful of batched requests to our own DLS
//              backend. Optional: stands down without DLS_SYNC_SECRET.
//
// Plus one scheduled decision (achievers.js): once a day, just after the
// Pakistan-time cutover, the finished day's winners are frozen into
// ranking.achievers and can never change again. That is what the Daily/Weekly
// Achiever awards on a member's profile are counted from.
//
// Plus one periodic cache refresh (leaderboard.js): every
// LEADERBOARD_INTERVAL_MINUTES (default 10), the quantum-points leaderboard is
// rebuilt and persisted to ranking.leaderboardSnapshot, so a cold serverless
// request (a public profile view in particular) reads one indexed doc instead
// of rebuilding the whole community's board inline.
//
// Plus mail delivery (mailer.js): every MAILER_INTERVAL_MINUTES (default 1) the
// emails the backend has queued for members in ranking.emailOutbox — role
// alerts, promotions and removals, medal congratulations — are sent from
// admin@. The backend only queues; if this process stops, no member is mailed
// until it is back, and anything that went stale in the meantime is dropped.

const quantumUri = process.env.MONGO_URI_QUANTUM;
const rankingUri = process.env.MONGO_RANKING_URI;

if (!quantumUri || !rankingUri) {
  console.error(
    "Missing env vars: MONGO_URI_QUANTUM and MONGO_RANKING_URI are required."
  );
  process.exit(1);
}

if (!process.env.GITHUB_TOKEN) {
  // Not fatal — the full pass still gets calendar data — but commits come from
  // GraphQL, which is token-only, so without it every commit count decays to
  // whatever the events API happens to still remember.
  console.warn(
    "[worker] GITHUB_TOKEN is not set — commit counts will be badly undercounted."
  );
}

// A token that is *set but rejected* (expired classic PAT, revoked, wrong
// value) is the failure this worker is least able to survive on its own: every
// GitHub fetch 401s, the recent pass retrieves nothing, and the process keeps
// reporting "online". The heartbeat now records that (sweep.js), but a human
// scanning `pm2 logs` should see it in one obvious line at startup rather than
// inferring it from a wall of per-batch warnings. Probe once, non-fatal.
const preflightGithubToken = async () => {
  if (!process.env.GITHUB_TOKEN) return;
  try {
    const res = await fetch("https://api.github.com/rate_limit", {
      headers: {
        Authorization: `token ${process.env.GITHUB_TOKEN}`,
        "User-Agent": "QuantumCommunity-ContributionWorker",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401) {
      console.error(
        "\n" +
          "************************************************************\n" +
          "[worker] GITHUB_TOKEN is set but GitHub rejects it (401 Bad\n" +
          "credentials) — it is EXPIRED or REVOKED. Every commit/PR\n" +
          "number in the portal stays frozen until this is replaced.\n" +
          "Fix: new classic PAT (scopes: repo, read:org) at\n" +
          "https://github.com/settings/tokens -> put in .env ->\n" +
          "`pm2 restart contribution-worker`.\n" +
          "************************************************************\n"
      );
    } else if (!res.ok) {
      console.warn(`[worker] GITHUB_TOKEN preflight: HTTP ${res.status}`);
    } else {
      const expiry = res.headers.get(
        "github-authentication-token-expiration"
      );
      console.log(
        `[worker] GITHUB_TOKEN accepted${expiry ? ` (expires ${expiry})` : ""}`
      );
    }
  } catch (err) {
    console.warn(`[worker] GITHUB_TOKEN preflight failed: ${err.message}`);
  }
};

const fullIntervalMs =
  (Number(process.env.SWEEP_INTERVAL_HOURS) || 24) * 60 * 60 * 1000;
const recentIntervalMs =
  (Number(process.env.RECENT_INTERVAL_MINUTES) || 2) * 60 * 1000;
const polycodeIntervalMs =
  (Number(process.env.POLYCODE_INTERVAL_MINUTES) || 15) * 60 * 1000;
// Faster than PolyCode: the upstream is our own deployment, and a member who
// just solved a problem expects to see it on today's board.
const dlsIntervalMs =
  (Number(process.env.DLS_INTERVAL_MINUTES) || 5) * 60 * 1000;
// The achiever check is cheap (usually a single "nothing to do" request) so it
// can tick often; what stops it repeating is the day it last settled, not the
// interval. A short interval is what makes it survive a restart near midnight.
const achieverIntervalMs =
  (Number(process.env.ACHIEVERS_CHECK_MINUTES) || 10) * 60 * 1000;
// Matches routes/rank.js's own 10-minute in-memory TTL — no point refreshing
// the persisted snapshot more often than a warm container would rebuild it
// itself.
const leaderboardIntervalMs =
  (Number(process.env.LEADERBOARD_INTERVAL_MINUTES) || 10) * 60 * 1000;
// An empty queue costs one indexed lookup, so this can tick every minute — and
// a member told "you are no longer Project Captain" should not hear it late.
const mailerIntervalMs =
  (Number(process.env.MAILER_INTERVAL_MINUTES) || 1) * 60 * 1000;
const runOnce = process.argv.includes("--once");
const recentOnly = process.argv.includes("--recent");
const polycodeOnly = process.argv.includes("--polycode");
const dlsOnly = process.argv.includes("--dls");
const achieversOnly = process.argv.includes("--achievers");
const leaderboardOnly = process.argv.includes("--leaderboard");
const mailerOnly = process.argv.includes("--mailer");

let connections = null;
let fullRunning = false;
let recentRunning = false;
let polycodeRunning = false;
let dlsRunning = false;
let achieverRunning = false;
let leaderboardRunning = false;
let mailerRunning = false;
// The last SMTP-level failure reported and when, so an outage that fails every
// one-minute tick the same way is a line every half hour, not 1,440 a day.
const mailerFault = { message: "", at: 0 };
// Which PKT date the finalize has already been settled for. In memory only: the
// endpoint is idempotent, so the worst a restart costs is one redundant request
// that reports nothing to do.
const achieverState = { lastFinalizedFor: "" };

const runFull = async () => {
  // Skip rather than queue: a full pass takes ~30 minutes, and stacking them
  // would multiply the GitHub load for no benefit.
  if (fullRunning) {
    console.log("[worker] full sweep still running, skipping this tick");
    return;
  }
  fullRunning = true;
  try {
    await runSweep(connections);
  } catch (err) {
    console.error("[worker] full sweep failed:", err.message);
  } finally {
    fullRunning = false;
  }
};

const runRecent = async () => {
  // The full pass rewrites the same documents; letting both run at once just
  // wastes rate limit on numbers the other is already fetching.
  if (recentRunning || fullRunning) return;
  recentRunning = true;
  try {
    const startedAt = Date.now();
    const result = await runRecentSweep(connections);
    // Only worth a log line when something actually moved — this runs ~720
    // times a day and the log is how you tell the worker is alive.
    if (result.changed > 0) {
      console.log(
        `[recent] ${result.changed} day(s) updated across ${result.members} member(s) ` +
          `in ${Date.now() - startedAt}ms`
      );
    }
  } catch (err) {
    console.error("[worker] recent sweep failed:", err.message);
  } finally {
    recentRunning = false;
  }
};

const runPolycode = async () => {
  // Independent of the GitHub passes — different upstream, no shared rate
  // limit — so it only guards against overlapping itself.
  if (polycodeRunning) return;
  polycodeRunning = true;
  try {
    const result = await runPolycodeSweep(connections);
    if (result.changed > 0 || result.failed > 0) {
      console.log(
        `[polycode] ${result.changed} day(s) updated across ${result.members} member(s)` +
          (result.failed ? `, ${result.failed} failed` : "")
      );
    }
  } catch (err) {
    console.error("[worker] polycode sweep failed:", err.message);
  } finally {
    polycodeRunning = false;
  }
};

const runDls = async () => {
  // Its own upstream and its own collection, so like PolyCode it only guards
  // against overlapping itself.
  if (dlsRunning) return;
  dlsRunning = true;
  try {
    const result = await runDlsSweep(connections);
    if (result.ran && (result.changed > 0 || result.failed > 0)) {
      console.log(
        `[dls] ${result.changed} row(s) updated across ${result.accounts} account(s)` +
          (result.failed ? `, ${result.failed} batch(es) failed` : "")
      );
    }
    return result;
  } catch (err) {
    console.error("[worker] dls sweep failed:", err.message);
  } finally {
    dlsRunning = false;
  }
};

const runAchievers = async (options = {}) => {
  if (achieverRunning) return;
  achieverRunning = true;
  try {
    const result = await runAchieverFinalize(connections, achieverState, options);
    if (result.ran && result.decided?.length) {
      for (const entry of result.decided) {
        console.log(
          `[achievers] ${entry.period} ${entry.periodKey} → ` +
            `${entry.winner || "nobody scored"} (${entry.entrants} entrant(s))`
        );
      }
    }
    if (result.ran && result.failed) {
      console.warn(`[achievers] ${result.failed} window(s) failed — will retry`);
    }
    return result;
  } catch (err) {
    console.error("[worker] achiever finalize failed:", err.message);
  } finally {
    achieverRunning = false;
  }
};

const runLeaderboardSnapshot = async () => {
  if (leaderboardRunning) return;
  leaderboardRunning = true;
  try {
    const result = await runLeaderboardRebuild();
    if (result.ran) {
      console.log(`[leaderboard] snapshot refreshed — ${result.members} member(s)`);
    }
    return result;
  } catch (err) {
    console.error("[worker] leaderboard rebuild failed:", err.message);
  } finally {
    leaderboardRunning = false;
  }
};

const runMail = async () => {
  // Its own upstream (the SMTP server) and its own collection; a tick that
  // finds the last one still sending just waits for the next.
  if (mailerRunning) return;
  mailerRunning = true;
  try {
    const result = await runMailer(connections);
    if (result.ran && (result.sent > 0 || result.skipped > 0 || result.failed > 0)) {
      console.log(
        `[mailer] ${result.sent} sent` +
          (result.skipped ? `, ${result.skipped} skipped` : "") +
          (result.failed ? `, ${result.failed} failed` : "")
      );
    }
    // Either way of not sending: the pass stood down (no SMTP settings, or the
    // mail library missing from this install), or it ran and could not reach
    // or sign in to the server. Both leave mail queuing, so both are said out
    // loud — and again every half hour for as long as it lasts.
    const fault = result.transportError || (result.ran ? "" : result.reason);
    if (fault) {
      const repeat =
        fault === mailerFault.message &&
        Date.now() - mailerFault.at < 30 * 60 * 1000;
      if (!repeat) {
        mailerFault.message = fault;
        mailerFault.at = Date.now();
        console.error(
          `[mailer] NOT SENDING — member emails are queuing, none are going out: ${fault}`
        );
      }
    } else {
      mailerFault.message = "";
    }
    return result;
  } catch (err) {
    console.error("[worker] mailer failed:", err.message);
  } finally {
    mailerRunning = false;
  }
};

const shutdown = async (signal) => {
  console.log(`[worker] ${signal} received, closing connections`);
  if (connections) await connections.close();
  process.exit(0);
};

(async () => {
  connections = await openConnections({ quantumUri, rankingUri });

  await preflightGithubToken();

  if (recentOnly) {
    // A manual one-off always reports, even when nothing changed — otherwise
    // "no output" is ambiguous between "nothing moved" and "nothing ran".
    const result = await runRecentSweep(connections);
    console.log(`[recent] ${JSON.stringify(result)}`);
    await connections.close();
    process.exit(0);
  }

  if (polycodeOnly) {
    const result = await runPolycodeSweep(connections);
    console.log(`[polycode] ${JSON.stringify(result)}`);
    await connections.close();
    process.exit(0);
  }

  if (dlsOnly) {
    const result = await runDlsSweep(connections);
    console.log(`[dls] ${JSON.stringify(result)}`);
    await connections.close();
    process.exit(0);
  }

  if (achieversOnly) {
    // force: a manual run is an explicit request to decide now, not a tick.
    const result = await runAchievers({ force: true });
    console.log(`[achievers] ${JSON.stringify(result)}`);
    await connections.close();
    process.exit(0);
  }

  if (leaderboardOnly) {
    const result = await runLeaderboardSnapshot();
    console.log(`[leaderboard] ${JSON.stringify(result)}`);
    await connections.close();
    process.exit(0);
  }

  if (mailerOnly) {
    const result = await runMailer(connections);
    console.log(`[mailer] ${JSON.stringify(result)}`);
    await connections.close();
    process.exit(0);
  }

  if (runOnce) {
    await runPolycode();
    await runDls();
    await runAchievers();
    await runLeaderboardSnapshot();
    await runFull();
    await connections.close();
    process.exit(0);
  }

  // Recent first: it is fast and gets the portal current within seconds of a
  // restart, instead of after the ~30-minute full pass.
  await runRecent();
  setInterval(runRecent, recentIntervalMs);
  console.log(
    `[worker] recent sweep every ${recentIntervalMs / 60000}min`
  );

  // Early, so a restart drains whatever queued while the worker was down
  // before the slower passes start. When it cannot send (no SMTP_*, or
  // nodemailer missing from this install) it stands down and the queue waits;
  // runMail has already said why, so this only confirms the working case.
  const mailerProbe = await runMail();
  setInterval(runMail, mailerIntervalMs);
  if (mailerProbe?.ran !== false) {
    console.log(`[worker] member emails sent every ${mailerIntervalMs / 60000}min`);
  }

  // Before the full pass: it is a dozen requests and finishes in seconds,
  // whereas the full GitHub pass takes ~30 minutes.
  await runPolycode();
  setInterval(runPolycode, polycodeIntervalMs);
  console.log(
    `[worker] polycode sweep every ${polycodeIntervalMs / 60000}min`
  );

  // Optional: without DLS_SYNC_SECRET this stands down and Digital Logics
  // Studio XP scores nothing. Announced either way, so a silent pass is never
  // mistaken for a broken one.
  const dlsProbe = await runDls();
  setInterval(runDls, dlsIntervalMs);
  console.log(
    dlsProbe?.ran === false
      ? "[worker] dls sweep not configured — set DLS_SYNC_SECRET to score Digital Logics Studio XP"
      : `[worker] dls sweep every ${dlsIntervalMs / 60000}min`
  );

  // Optional: without PORTAL_API_URL this stands down and the portal decides on
  // its own rebuild instead. Announce which of the two is in play, so a silent
  // pass is never mistaken for a broken one.
  const achieverProbe = await runAchievers();
  setInterval(runAchievers, achieverIntervalMs);
  console.log(
    achieverProbe?.ran === false && achieverProbe.reason?.startsWith("not configured")
      ? "[worker] achiever finalize not configured — the portal will decide on its own rebuild"
      : `[worker] achiever finalize checked every ${achieverIntervalMs / 60000}min ` +
          `(decides at ${String(FINALIZE_HOUR_PKT).padStart(2, "0")}:00 PKT)`
  );

  // Same optional wiring as achievers: without PORTAL_API_URL this stands
  // down and the portal just rebuilds live on request when its own 10-minute
  // in-memory cache goes cold, same as before this existed.
  const leaderboardProbe = await runLeaderboardSnapshot();
  setInterval(runLeaderboardSnapshot, leaderboardIntervalMs);
  console.log(
    leaderboardProbe?.ran === false && leaderboardProbe.reason?.startsWith("not configured")
      ? "[worker] leaderboard snapshot not configured — cold requests will rebuild it live instead"
      : `[worker] leaderboard snapshot refreshed every ${leaderboardIntervalMs / 60000}min`
  );

  await runFull();
  setInterval(runFull, fullIntervalMs);
  console.log(`[worker] full sweep every ${fullIntervalMs / 3600000}h`);

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
})().catch((err) => {
  console.error("[worker] fatal:", err.message);
  process.exit(1);
});
