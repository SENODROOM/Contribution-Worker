// Periodic refresh of ranking.leaderboardSnapshot.
//
// Mirrors achievers.js's wiring: OPTIONAL, and off unless PORTAL_API_URL is
// set (the same var achievers.js already requires), reusing the same
// CRON_SECRET||JWT_SECRET bearer every /api/cron/* route on the portal
// accepts — no new env var needed beyond what achievers already wired up.
//
// Unlike achievers.js this has no "decide once for a date" logic: it is a
// plain periodic refresh. The point is that this worker runs 24/7, unlike
// the serverless backend, so it — not a request — pays for the ~10-collection
// community-wide rebuild. routes/rank.js reads the snapshot this leaves
// behind instead of rebuilding inline on a cold container, which is what
// made a public profile view (or any first hit after a cold start) slow.
//
// Leave PORTAL_API_URL unset and this pass stands down silently: the portal
// still rebuilds live on its own request path when it has to
// (routes/rank.js buildLeaderboard), just without a warm snapshot to read
// first on a cold start.

const REQUEST_TIMEOUT_MS = 120000;

/**
 * Ask the portal to rebuild its leaderboard and persist the result.
 *
 * @returns {Promise<{ ran: boolean, reason?: string, members?: number }>}
 */
const runLeaderboardRebuild = async () => {
  const base = String(process.env.PORTAL_API_URL || "").replace(/\/+$/, "");
  // Must match what the portal resolves in routes/cron.js cronSecret().
  const secret = process.env.CRON_SECRET || process.env.JWT_SECRET;
  if (!base || !secret) {
    return { ran: false, reason: "not configured (PORTAL_API_URL + JWT_SECRET)" };
  }

  const res = await fetch(`${base}/api/cron/rebuild-leaderboard`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `portal returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }

  const result = await res.json();
  return { ran: true, ...result };
};

module.exports = { runLeaderboardRebuild };
