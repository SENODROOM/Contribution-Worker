// Daily achiever decision.
//
// The worker owns *when* the winners are decided: once a day, just after the
// Pakistan-time cutover, the finished day (and, on a Monday, the finished week)
// is settled and frozen into ranking.achievers. Nothing after that can change
// it — which is the whole point, since the GitHub sweep keeps repairing old days
// and a podium recomputed next week can quietly crown someone else.
//
// It does not compute the podium itself. The score is five sources deep and
// joins members across Discord IDs, GitHub handles and PolyCode handles through
// an identity index that lives in backend/utils/exploreData.js; a second copy
// here would drift, and the first symptom would be a frozen award contradicting
// the board that announced it. So this triggers the backend endpoint that reuses
// those exact loaders.
//
// It does not email the winners either, though it used to. The backend queues a
// congratulation for every medal the moment a window is decided
// (backend/utils/medalEmails.js) and mailer.js delivers it — which is what lets
// the mail go out whichever of the two triggers decided the window, and for all
// six medals rather than first place alone. The same call also runs the weekly
// role-alert sweep on the backend, so a configured worker is what makes both
// land at midnight exactly.
//
// OPTIONAL, and off unless configured. Set PORTAL_API_URL (the portal backend's
// origin) plus the secret its /api/cron/* routes accept — CRON_SECRET if that
// deployment defines one, otherwise JWT_SECRET, which it already has — and the
// decision happens at the cutover, to the minute.
//
// Leave PORTAL_API_URL unset and this pass stands down silently: the portal
// decides any undecided window itself on its next Explore rebuild
// (routes/explore.js ensureSettledWindowsDecided), so awards — and their emails
// — still land, just whenever the first visitor arrives after midnight rather
// than exactly at it.

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

// Hour of the PKT day at which the previous day is considered decidable. 0 =
// midnight, the moment the day closes and every score resets. A few minutes of
// grace comes free: this only runs on the scheduler's tick.
const FINALIZE_HOUR_PKT = Number(process.env.ACHIEVERS_FINALIZE_HOUR_PKT) || 0;

const REQUEST_TIMEOUT_MS = 120000;

// PKT calendar date of an instant, as YYYY-MM-DD. Shifting into PKT and reading
// the UTC fields lets the ordinary getters do PKT calendar arithmetic — same
// trick as backend/utils/exploreData.js buildWindow.
const pktParts = (instant) => {
  const shifted = new Date(instant.getTime() + PKT_OFFSET_MS);
  return {
    dateKey: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
  };
};

// The last PKT date whose finalize is due. Before the cutover hour, today's run
// has not come round yet, so the newest due date is still yesterday's.
const dueDateKey = (now = new Date()) => {
  const { dateKey, hour } = pktParts(now);
  if (hour >= FINALIZE_HOUR_PKT) return dateKey;
  const shifted = new Date(now.getTime() + PKT_OFFSET_MS);
  shifted.setUTCDate(shifted.getUTCDate() - 1);
  return shifted.toISOString().slice(0, 10);
};

/**
 * Ask the portal to decide any finished window that has no result yet.
 *
 * The endpoint is idempotent and reaches back over recent days, so a worker that
 * was down for a week catches up here rather than losing those awards — this
 * function only decides *whether it is worth asking*, never what the answer is.
 *
 * @param {object} _connections unused — this pass only talks to the portal;
 *   kept so every pass in index.js is called the same way
 * @param {{ lastFinalizedFor: string }} state mutated with the date key handled
 * @returns {Promise<{ ran: boolean, reason?: string, decided?: Array }>}
 */
const runAchieverFinalize = async (_connections, state = {}, { force = false } = {}) => {
  const base = String(process.env.PORTAL_API_URL || "").replace(/\/+$/, "");
  // Must match what the portal resolves in routes/cron.js cronSecret().
  const secret = process.env.CRON_SECRET || process.env.JWT_SECRET;
  if (!base || !secret) {
    // Not an error: the portal's own rebuild covers this. Reported so a manual
    // `npm run achievers` says why nothing happened.
    return { ran: false, reason: "not configured (PORTAL_API_URL + JWT_SECRET)" };
  }

  const due = dueDateKey();
  if (!force && state.lastFinalizedFor === due) {
    return { ran: false, reason: "already finalized for " + due };
  }

  const res = await fetch(`${base}/api/cron/finalize-achievers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`portal returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }

  const result = await res.json();
  // Only mark the day done on a clean run, so a partial failure is retried on
  // the next tick instead of being written off until tomorrow.
  if (!result.failed) state.lastFinalizedFor = due;

  return { ran: true, ...result };
};

module.exports = { runAchieverFinalize, dueDateKey, FINALIZE_HOUR_PKT };
