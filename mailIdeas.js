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
const { ideaCommentEmail } = require("./mailTemplates");

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

module.exports = { runIdeaMail };
