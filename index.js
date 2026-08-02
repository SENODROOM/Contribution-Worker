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

const fullIntervalMs =
  (Number(process.env.SWEEP_INTERVAL_HOURS) || 24) * 60 * 60 * 1000;
const recentIntervalMs =
  (Number(process.env.RECENT_INTERVAL_MINUTES) || 2) * 60 * 1000;
const polycodeIntervalMs =
  (Number(process.env.POLYCODE_INTERVAL_MINUTES) || 15) * 60 * 1000;
const runOnce = process.argv.includes("--once");
const recentOnly = process.argv.includes("--recent");
const polycodeOnly = process.argv.includes("--polycode");

let connections = null;
let fullRunning = false;
let recentRunning = false;
let polycodeRunning = false;

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

const shutdown = async (signal) => {
  console.log(`[worker] ${signal} received, closing connections`);
  if (connections) await connections.close();
  process.exit(0);
};

(async () => {
  connections = await openConnections({ quantumUri, rankingUri });

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

  if (runOnce) {
    await runPolycode();
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

  // Before the full pass: it is a dozen requests and finishes in seconds,
  // whereas the full GitHub pass takes ~30 minutes.
  await runPolycode();
  setInterval(runPolycode, polycodeIntervalMs);
  console.log(
    `[worker] polycode sweep every ${polycodeIntervalMs / 60000}min`
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
