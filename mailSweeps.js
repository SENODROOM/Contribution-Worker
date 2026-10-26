// The two mails that go out on a calendar, not on an event: the medal
// congratulations when a day / week / month closes, and the weekly "your
// position is at risk" alert on the Monday after.
//
// Both need an answer only the portal backend can give (see mailPortal.js):
// who won which medal off the frozen achiever rows, and who is failing a role
// rule off the leaderboard. This worker asks, builds each mail, queues it and
// writes a marker, so the check that runs on every pass is one indexed lookup.
//
// MEDALS. The worker's own midnight call to /api/cron/finalize-achievers
// (achievers.js) is what decides a window, and a visitor loading /explore can
// decide it too — either way the window's place-0 decision row lands in
// ranking.achievers, and this pass notices it a minute later. A window decided
// long after it closed (the finalize reaches back two weeks after an outage, and
// scripts/refinalizeAchieverDays.js re-decides old days on purpose) still grants
// its medals, but congratulating someone on last week is noise, so only windows
// that closed in the last MAX_WINDOW_AGE_DAYS are mailed. One mail per member
// per window: a member who wins two of a day's three medals gets one email
// naming both.
//
// ROLE ALERTS. Once per finished Mon–Sun PKT week, every Team Captain, Project
// Captain and Commander failing a rule that keeps their seat is told, in one
// mail listing every rule — the same alerts as the red Alerts button on
// Overview. The week's marker (`role-alerts:sweep:<monday>`) is written last, so
// a sweep that died is run again, and each mail's own dedupe key makes a rerun
// harmless. If the portal's leaderboard is unavailable or incomplete the portal
// answers `ran: false` and no marker is written: nothing puts a Knight verdict
// in writing off a board with a source missing.
const mongoose = require("mongoose");
const {
  queueMemberEmail,
  hasSweepMarker,
  existingSweepMarkers,
  writeSweepMarker,
} = require("./mailQueue");
const { portalGet, portalUnavailableReason } = require("./mailPortal");
const { medalEmail, roleAlertEmail } = require("./mailTemplates");

const { ObjectId } = mongoose.Types;

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_AGE_DAYS = 3;
// Stale by the time next Monday's sweep would say something different.
const ALERT_EXPIRY_DAYS = 6;
// After a failed ask, leave the portal alone this long.
const RETRY_AFTER_MS = 10 * 60 * 1000;

const retryAt = { medals: 0, roleAlerts: 0 };

const pktDateKey = (instant) =>
  new Date(instant.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10);

const addDays = (key, days) => {
  const date = new Date(`${key}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

// Monday of the PKT week containing `now`, and of the week before it.
const weekMondayKey = (now = new Date()) => {
  const key = pktDateKey(now);
  const day = new Date(`${key}T00:00:00.000Z`).getUTCDay();
  return addDays(key, day === 0 ? -6 : 1 - day);
};
const prevWeekMondayKey = (now = new Date()) => addDays(weekMondayKey(now), -7);

const freshCutoffKey = (now = new Date()) =>
  pktDateKey(new Date(now.getTime() - MAX_WINDOW_AGE_DAYS * DAY_MS));

const medalMarkerKey = (period, periodKey) => `medal-sweep:${period}:${periodKey}`;
const roleAlertMarkerKey = (weekKey) => `role-alerts:sweep:${weekKey}`;

/**
 * Congratulate the winners of every window decided in the last few days that has
 * not been swept yet.
 *
 * @returns {Promise<{ queued: number, windows: number, note?: string, problem?: string }>}
 */
const runMedalSweep = async ({ rankingConn }) => {
  const none = { queued: 0, windows: 0 };

  const cutoffKey = freshCutoffKey();
  const decided = await rankingConn
    .collection("achievers")
    .find({ place: 0, endKey: { $gte: cutoffKey } }, { projection: { period: 1, periodKey: 1 } })
    .toArray();
  if (!decided.length) return none;

  const done = await existingSweepMarkers(
    rankingConn,
    decided.map((window) => medalMarkerKey(window.period, window.periodKey)),
  );
  const pending = decided.filter(
    (window) => !done.has(medalMarkerKey(window.period, window.periodKey)),
  );
  if (!pending.length) return none;

  const unavailable = portalUnavailableReason();
  if (unavailable) {
    return { ...none, note: `${pending.length} decided window(s) wait for medal emails — ${unavailable}` };
  }
  if (Date.now() < retryAt.medals) return none;

  let facts;
  try {
    facts = await portalGet("medals", { fromKey: cutoffKey });
  } catch (err) {
    retryAt.medals = Date.now() + RETRY_AFTER_MS;
    return { ...none, problem: `medal facts: ${err.message}` };
  }

  let queued = 0;
  for (const win of facts.medals || []) {
    if (!ObjectId.isValid(String(win.userId))) continue;
    const result = await queueMemberEmail(rankingConn, {
      userId: new ObjectId(String(win.userId)),
      kind: "medal",
      dedupeKey: `medal:${win.period}:${win.periodKey}:${win.userId}`,
      email: medalEmail({
        name: win.name,
        period: win.period,
        startKey: win.periodKey,
        handle: win.handle,
        medals: win.medals,
      }),
      expiresInDays: MAX_WINDOW_AGE_DAYS,
    });
    if (result.queued) queued += 1;
    if (result.reason === "ERROR") {
      // Leave the windows unmarked: the next pass tries again.
      retryAt.medals = Date.now() + RETRY_AFTER_MS;
      return { queued, windows: 0, problem: "could not write a medal email to the outbox" };
    }
  }

  // Last, so a sweep that died partway is run again rather than written off.
  for (const window of pending) {
    await writeSweepMarker(
      rankingConn,
      medalMarkerKey(window.period, window.periodKey),
      "medal emails queued",
    );
  }
  return { queued, windows: pending.length };
};

/**
 * Judge last week for every leader and queue an alert for each one failing a
 * rule. Idempotent per week.
 *
 * @param {{ rankingConn: import("mongoose").Connection }} ctx
 * @param {{ resendFor?: string[] }} [options] user ids whose alert was queued
 *   but never delivered (repairFailedEmails.js). Only they are judged again, on
 *   today's numbers, under a second key — so a leader who has cleared the alert
 *   since is not told two days late that their position is at risk. No marker.
 * @returns {Promise<{ queued: number, alerted: number, note?: string, problem?: string }>}
 */
const runRoleAlertSweep = async ({ rankingConn }, { resendFor = null } = {}) => {
  const none = { queued: 0, alerted: 0 };

  const prevKey = prevWeekMondayKey();
  if (!resendFor && (await hasSweepMarker(rankingConn, roleAlertMarkerKey(prevKey)))) return none;

  const unavailable = portalUnavailableReason();
  if (unavailable) {
    return { ...none, note: `week of ${prevKey}: role alerts wait — ${unavailable}` };
  }
  if (!resendFor && Date.now() < retryAt.roleAlerts) return none;

  let facts;
  try {
    facts = await portalGet("role-alerts", resendFor ? { resend: resendFor.join(",") } : {});
  } catch (err) {
    retryAt.roleAlerts = Date.now() + RETRY_AFTER_MS;
    return { ...none, problem: `role alert facts: ${err.message}` };
  }
  if (!facts.ran) {
    retryAt.roleAlerts = Date.now() + RETRY_AFTER_MS;
    return { ...none, note: `week of ${prevKey}: role alerts wait — ${facts.reason || "portal not ready"}` };
  }

  let queued = 0;
  let alerted = 0;
  for (const leader of facts.leaders || []) {
    if (!ObjectId.isValid(String(leader.userId))) continue;
    alerted += 1;
    const result = await queueMemberEmail(rankingConn, {
      userId: new ObjectId(String(leader.userId)),
      kind: "role_alert",
      dedupeKey: `role-alert:${facts.weekKey}:${leader.userId}${resendFor ? ":resend" : ""}`,
      email: roleAlertEmail({
        name: leader.name,
        role: leader.role,
        alerts: leader.alerts,
        prevWeekKey: facts.weekKey,
      }),
      expiresInDays: Math.min(ALERT_EXPIRY_DAYS, Number(facts.daysLeft) || ALERT_EXPIRY_DAYS),
    });
    if (result.queued) queued += 1;
    if (result.reason === "ERROR") {
      retryAt.roleAlerts = Date.now() + RETRY_AFTER_MS;
      return { queued, alerted, problem: "could not write a role alert to the outbox" };
    }
  }

  if (!resendFor) {
    await writeSweepMarker(
      rankingConn,
      roleAlertMarkerKey(facts.weekKey),
      `${facts.checked} leader(s) checked, ${alerted} failing a rule`,
    );
  }
  return { queued, alerted };
};

module.exports = { runMedalSweep, runRoleAlertSweep, prevWeekMondayKey };
