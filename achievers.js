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
// those exact loaders, then emails whoever it reports as the winner — the portal
// itself never sends mail, since /api/cron/finalize-achievers is called from
// both this worker and the Explore-rebuild fallback, and only the worker path
// runs on a schedule worth mailing off of.
//
// OPTIONAL, and off unless configured. Set PORTAL_API_URL (the portal backend's
// origin) plus the secret its /api/cron/* routes accept — CRON_SECRET if that
// deployment defines one, otherwise JWT_SECRET, which it already has — and the
// decision happens at the cutover, to the minute. The email needs its own SMTP_*
// vars (see email.js) — without them it just logs and skips, same as any other
// unconfigured pass here.
//
// Leave PORTAL_API_URL unset and this pass stands down silently: the portal
// decides any undecided window itself on its next Explore rebuild
// (routes/explore.js ensureSettledWindowsDecided), so awards still land, just
// whenever the first visitor arrives after midnight rather than exactly at it —
// but nobody gets emailed, since that only happens from this file.

const { getGithubUsername } = require("./sweep");
const { sendEmail } = require("./email");

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

const escapeHtml = (value) =>
  String(value || "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);

// The portal's response only carries a githubHandle (see
// backend/utils/achieverFinalize.js decided.push) — no email, since that
// lives in quantum_logics, not the ranking DB the portal's finalize job
// reads from. The worker already holds its own connection to quantum_logics
// (index.js openConnections), so it looks the winner up itself rather than
// asking the backend for a second round trip.
const findUserByGithubHandle = async (quantumConn, handle) => {
  if (!handle || !quantumConn) return null;
  const target = handle.toLowerCase();
  const users = await quantumConn
    .collection("users")
    .find({ githubUrl: { $type: "string", $ne: "" } })
    .project({ email: 1, name: 1, githubUrl: 1 })
    .toArray();
  return (
    users.find((user) => (getGithubUsername(user.githubUrl) || "").toLowerCase() === target) ||
    null
  );
};

/**
 * Email the winner of a window the portal just froze. Best-effort: logged and
 * swallowed on failure by the caller — the award is permanent the moment the
 * portal call above returns, regardless of whether this email goes out.
 */
const notifyWinner = async (quantumConn, entry) => {
  if (!entry.githubHandle) return; // nobody scored, or no linked GitHub
  const user = await findUserByGithubHandle(quantumConn, entry.githubHandle);
  if (!user || !user.email) return;

  const label = entry.period === "week" ? "Weekly Achiever" : "Daily Achiever";
  const dateLabel =
    entry.period === "week" ? `the week of ${entry.periodKey}` : entry.periodKey;
  const displayName = entry.name || user.name || entry.githubHandle;

  await sendEmail({
    to: user.email,
    subject: `🏆 You're the ${label} for ${entry.periodKey}!`,
    text:
      `Congratulations ${displayName}! You topped the board for ${dateLabel} with ` +
      `${entry.points || 0} points and earned the ${label} award.`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <h2>🏆 ${escapeHtml(label)}</h2>
        <p>Congratulations <strong>${escapeHtml(displayName)}</strong>!</p>
        <p>You topped the board for <strong>${escapeHtml(dateLabel)}</strong> with
          <strong>${entry.points || 0} points</strong>.</p>
      </div>
    `,
  });
};

/**
 * Ask the portal to decide any finished window that has no result yet.
 *
 * The endpoint is idempotent and reaches back over recent days, so a worker that
 * was down for a week catches up here rather than losing those awards — this
 * function only decides *whether it is worth asking*, never what the answer is.
 *
 * @param {{ quantumConn: import("mongoose").Connection }} connections opened by index.js
 * @param {{ lastFinalizedFor: string }} state mutated with the date key handled
 * @returns {Promise<{ ran: boolean, reason?: string, decided?: Array }>}
 */
const runAchieverFinalize = async (connections, state = {}, { force = false } = {}) => {
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

  for (const entry of result.decided || []) {
    await notifyWinner(connections?.quantumConn, entry).catch((err) =>
      console.warn(
        `[achievers] winner email failed for ${entry.githubHandle || "(none)"}: ${err.message}`,
      ),
    );
  }

  return { ran: true, ...result };
};

module.exports = { runAchieverFinalize, dueDateKey, FINALIZE_HOUR_PKT };
