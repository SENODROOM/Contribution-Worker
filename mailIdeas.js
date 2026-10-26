// Two mails about an idea, both read from the database a minute after the fact:
// "someone commented on your idea" (runIdeaMail) and "your idea was approved /
// completed / not approved / closed" (runIdeaDecisionMail, at the end).
//
// "Someone commented on your idea".
//
// Read from ranking.ideaComments a minute after a comment is posted — the
// backend no longer mails from the request. Not routed through mailActivity.js:
// a comment writes no activity entry, and an idea names its author by
// users._id rather than the Discord id those handlers resolve.
//
// Two rules, both about the fact that sign-up is open and anyone can comment:
//
//   * Your own comment on your own idea mails nobody.
//   * One mail per commenter, per idea, per PKT day. A commenter may post forty
//     comments a day (backend routes/ideas.js DAILY_COMMENT_LIMIT); without
//     this, that is forty emails from admin@ into one member's inbox at a
//     stranger's choosing. The first comment of the day is the one quoted — the
//     rest are on the board the mail links to. Comments are read oldest first,
//     so the first one is the one that takes the dedupe key.
//
// "Your idea now has N comments" is the idea's count when the mail is built,
// a minute or so after the comment; the backend read it back from its own $inc.
const mongoose = require("mongoose");
const { queueMemberEmail, readCursor, writeCursor } = require("./mailQueue");
const { ideaCommentEmail, ideaDecisionEmail } = require("./mailTemplates");

const { ObjectId } = mongoose.Types;

const CURSOR_KEY = "__cursor__:ideaComments";
const LAG_MS = 60 * 1000;
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const BATCH = 200;
// A comment is a conversation; told about it days later, it is just noise.
const EXPIRY_DAYS = 3;
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
// A comment that keeps failing is retried each pass, then given up on, so one
// bad row can not hold every mail behind it.
const MAX_ROW_FAILURES = 5;
const rowFailures = new Map();

const pktDayKey = (instant) =>
  new Date(new Date(instant).getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10);

/**
 * @param {{ quantumConn: import("mongoose").Connection, rankingConn: import("mongoose").Connection }} ctx
 * @returns {Promise<{ queued: number, handled: number, problem?: string }>}
 */
const runIdeaMail = async (ctx) => {
  const comments = ctx.rankingConn.collection("ideaComments");
  const ideas = ctx.rankingConn.collection("ideas");
  const users = ctx.quantumConn.collection("users");

  const upper = ObjectId.createFromTime(Math.floor((Date.now() - LAG_MS) / 1000));
  let cursor = await readCursor(ctx.rankingConn, CURSOR_KEY);
  if (!cursor) {
    cursor = ObjectId.createFromTime(Math.floor((Date.now() - FIRST_RUN_LOOKBACK_MS) / 1000));
  }

  const batch = await comments
    .find({ _id: { $gt: cursor, $lte: upper } })
    .sort({ _id: 1 })
    .limit(BATCH)
    .toArray();

  let queued = 0;
  let advanceTo = batch.length === BATCH ? batch[batch.length - 1]._id : upper;
  let problem = "";

  for (const comment of batch) {
    try {
      const commenterId = String(comment.authorUserId || "");
      if (!ObjectId.isValid(String(comment.ideaId || ""))) continue;

      const idea = await ideas.findOne(
        { _id: new ObjectId(String(comment.ideaId)) },
        { projection: { title: 1, authorUserId: 1, commentCount: 1 } },
      );
      const authorId = String(idea?.authorUserId || "");
      // Deleted idea, or a comment on your own: nobody to tell.
      if (!idea || !authorId || authorId === commenterId) continue;
      if (!ObjectId.isValid(authorId)) continue;

      // The author's account may be gone — the idea keeps a name snapshot for
      // exactly that case, and there is then nobody to mail.
      const author = await users.findOne(
        { _id: new ObjectId(authorId) },
        { projection: { name: 1 } },
      );
      if (!author) continue;

      const commenter = ObjectId.isValid(commenterId)
        ? await users.findOne({ _id: new ObjectId(commenterId) }, { projection: { name: 1 } })
        : null;

      const result = await queueMemberEmail(ctx.rankingConn, {
        userId: author._id,
        kind: "idea_comment",
        dedupeKey: `idea-comment:${idea._id}:${commenterId}:${pktDayKey(comment.createdAt)}`,
        email: ideaCommentEmail({
          name: author.name,
          commenterName: commenter?.name || comment.authorName || "A member",
          ideaTitle: idea.title,
          commentBody: comment.body,
          commentCount: Number(idea.commentCount) || 0,
        }),
        expiresInDays: EXPIRY_DAYS,
      });
      if (result.queued) queued += 1;
      if (result.reason === "ERROR") throw new Error("could not write to the outbox");
    } catch (err) {
      const id = String(comment._id);
      const failures = (rowFailures.get(id) || 0) + 1;
      rowFailures.set(id, failures);
      console.warn(`[mail] idea comment ${id} attempt ${failures} failed: ${err.message}`);
      if (failures < MAX_ROW_FAILURES) {
        // Stop and retry from this comment on the next pass.
        problem = `idea comment ${id}: ${err.message}`;
        advanceTo = batch[batch.indexOf(comment) - 1]?._id || cursor;
        break;
      }
      rowFailures.delete(id);
      problem = `gave up on idea comment ${id}: ${err.message}`;
    }
  }

  if (String(advanceTo) !== String(cursor)) {
    await writeCursor(ctx.rankingConn, CURSOR_KEY, advanceTo);
  }
  return { queued, handled: batch.length, ...(problem && { problem }) };
};

// ─── The outcome of an idea ──────────────────────────────────────────────────
//
// A Software Engineer approving, completing or closing an idea stamps
// `decidedAt` on it (backend routes/ideas.js PATCH /:ideaId/status — the whole of
// the backend's part), and the author is told here so they do not have to ask
// for an update. Where the idea stands decides the wording: approved,
// completed, or closed as declined. **Ignore sends nothing** (the user,
// 2026-10-27): it sets an idea aside without a verdict, so there is no outcome to
// report. A reopen is not announced either.
//
// One mail per idea per outcome, whatever the flip-flopping: an SE who approves,
// unapproves and approves again does not mail the author three times. A decision
// the author took themselves (an SE closing their own idea) mails nobody, and
// ideas decided before the field existed have no `decidedAt` and are never
// mailed. The cursor is a date, `__cursor__:ideaDecisions`, trailing the clock by
// a minute so a decision stamped by a server whose clock runs behind is not
// stepped over; the first ever run looks back a day.
const DECISION_CURSOR_KEY = "__cursor__:ideaDecisions";
const DECISION_EXPIRY_DAYS = 7;
const decisionFailures = new Map();

const outcomeOf = (idea) => {
  if (idea.status === "approved") return "approved";
  if (idea.status === "closed" && ["completed", "declined"].includes(idea.closedReason)) {
    return idea.closedReason;
  }
  return "";
};

/**
 * @param {{ quantumConn: import("mongoose").Connection, rankingConn: import("mongoose").Connection }} ctx
 * @returns {Promise<{ queued: number, handled: number, problem?: string }>}
 */
const runIdeaDecisionMail = async (ctx) => {
  const ideas = ctx.rankingConn.collection("ideas");
  const users = ctx.quantumConn.collection("users");

  const upper = new Date(Date.now() - LAG_MS);
  let cursor = await readCursor(ctx.rankingConn, DECISION_CURSOR_KEY);
  if (!cursor) cursor = new Date(Date.now() - FIRST_RUN_LOOKBACK_MS);

  const batch = await ideas
    .find({ decidedAt: { $gt: new Date(cursor), $lte: upper } })
    .sort({ decidedAt: 1 })
    .limit(BATCH)
    .toArray();

  let queued = 0;
  let advanceTo = batch.length === BATCH ? batch[batch.length - 1].decidedAt : upper;
  let problem = "";

  for (const idea of batch) {
    try {
      // Read at mail time, not at decision time: an idea approved and reopened
      // inside the minute is open again, and no mail is owed for it.
      const outcome = outcomeOf(idea);
      const authorId = String(idea.authorUserId || "");
      if (!outcome || !ObjectId.isValid(authorId)) continue;
      // An SE deciding their own idea knows what they decided.
      if (String(idea.decidedByUserId || "") === authorId) continue;

      const author = await users.findOne(
        { _id: new ObjectId(authorId) },
        { projection: { name: 1 } },
      );
      if (!author) continue;

      const result = await queueMemberEmail(ctx.rankingConn, {
        userId: author._id,
        kind: "idea_decision",
        dedupeKey: `idea-decision:${idea._id}:${outcome}`,
        email: ideaDecisionEmail({ name: author.name, ideaTitle: idea.title, outcome }),
        expiresInDays: DECISION_EXPIRY_DAYS,
      });
      if (result.queued) queued += 1;
      if (result.reason === "ERROR") throw new Error("could not write to the outbox");
    } catch (err) {
      const id = String(idea._id);
      const failures = (decisionFailures.get(id) || 0) + 1;
      decisionFailures.set(id, failures);
      console.warn(`[mail] idea decision ${id} attempt ${failures} failed: ${err.message}`);
      if (failures < MAX_ROW_FAILURES) {
        problem = `idea decision ${id}: ${err.message}`;
        advanceTo = batch[batch.indexOf(idea) - 1]?.decidedAt || cursor;
        break;
      }
      decisionFailures.delete(id);
      problem = `gave up on idea decision ${id}: ${err.message}`;
    }
  }

  if (new Date(advanceTo).getTime() !== new Date(cursor).getTime()) {
    await writeCursor(ctx.rankingConn, DECISION_CURSOR_KEY, new Date(advanceTo));
  }
  return { queued, handled: batch.length, ...(problem && { problem }) };
};

module.exports = { runIdeaMail, runIdeaDecisionMail };
