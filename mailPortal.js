// Asking the portal backend for the facts a member email is built from.
//
// Three things a mail needs are decided by backend code this worker cannot
// carry a copy of without drifting from it — who won which medal (the frozen
// achiever rows), who is failing a role rule this week (the leaderboard behind
// the Knight rule), and one member's standing for a "requirements you did not
// meet" list. The backend answers those as plain data over GET
// /api/cron/mail-facts/*; it queues and sends nothing. Same secret and same
// origin as achievers.js uses for the midnight finalize.
//
// Unset PORTAL_API_URL (or the secret) and the three kinds of mail that need an
// answer stand down — medals and weekly role alerts wait, and a "no longer a
// captain" mail goes out without its list — with the reason reported by the
// pass, never silently.
const REQUEST_TIMEOUT_MS = 120000;

const portalConfig = () => {
  const base = String(process.env.PORTAL_API_URL || "").replace(/\/+$/, "");
  // Must match what the portal resolves in routes/cron.js cronSecret().
  const secret = process.env.CRON_SECRET || process.env.JWT_SECRET;
  return base && secret ? { base, secret } : null;
};

const portalUnavailableReason = () =>
  portalConfig() ? "" : "PORTAL_API_URL and CRON_SECRET (or JWT_SECRET) are not set in this worker's .env";

/**
 * GET a facts endpoint. Returns the parsed JSON; throws on a transport error or
 * a non-2xx answer, so a caller can tell "the portal said no" from "no answer
 * was needed".
 */
const portalGet = async (path, query = {}) => {
  const config = portalConfig();
  if (!config) throw new Error(portalUnavailableReason());

  const qs = new URLSearchParams(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== ""),
  ).toString();
  const res = await fetch(`${config.base}/api/cron/mail-facts/${path}${qs ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${config.secret}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`portal returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return res.json();
};

module.exports = { portalConfig, portalUnavailableReason, portalGet };
