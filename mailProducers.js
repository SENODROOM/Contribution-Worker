// Everything that decides a member email is owed — run before each delivery pass.
//
// The backend sends and queues no member mail. A mail is decided here, queued in
// ranking.emailOutbox, and sent by mailer.js from admin@ in the same tick, so
// one process owns the whole path:
//
//   mailActivity.js  promotions, removals, team moves, bans, rejected appeals
//   mailIdeas.js     a comment on your idea
//   mailSweeps.js    medal congratulations at each window's close, and the
//                    weekly role alerts
//
// Each producer is independent: one that fails (the portal down, a bad row)
// is reported and the others still run. Nothing here sends.
const { ensureOutboxIndexes } = require("./mailQueue");
const { runActivityMail } = require("./mailActivity");
const { runIdeaMail } = require("./mailIdeas");
const { runMedalSweep, runRoleAlertSweep } = require("./mailSweeps");

let indexesEnsured = false;

/**
 * @param {{ quantumConn: import("mongoose").Connection, rankingConn: import("mongoose").Connection }} ctx
 * @returns {Promise<{ queued: number, problems: string[], notes: string[] }>}
 */
const runMailProducers = async (ctx) => {
  const problems = [];
  const notes = [];
  let queued = 0;

  if (!indexesEnsured) {
    try {
      await ensureOutboxIndexes(ctx.rankingConn);
      indexesEnsured = true;
    } catch (err) {
      problems.push(`outbox indexes: ${err.message}`);
    }
  }

  const producers = [
    ["activity", runActivityMail],
    ["ideas", runIdeaMail],
    ["medals", runMedalSweep],
    ["role alerts", runRoleAlertSweep],
  ];
  for (const [name, run] of producers) {
    try {
      const result = await run(ctx);
      queued += result.queued || 0;
      if (result.problem) problems.push(result.problem);
      if (result.note) notes.push(result.note);
    } catch (err) {
      problems.push(`${name}: ${err.message}`);
    }
  }

  return { queued, problems, notes };
};

module.exports = { runMailProducers };
