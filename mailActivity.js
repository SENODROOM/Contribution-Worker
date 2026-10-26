// Emails the member a community-activity entry is *about*.
//
// Every change to someone's standing — a promotion, a depose, a team move, a
// ban, a rejected appeal — already writes one row to ranking.communityActivities
// (backend utils/communityActivity.js). The backend used to email from that
// write; it no longer sends or queues anything. This pass reads the new rows
// instead, a minute or so after they are written, and a new kind of event gets
// its email by adding a row to HANDLERS below.
//
// A handler reads the entry's `meta` and returns who to tell and how to build
// their mail. Types with no handler (uploads, reports, lecture events) email
// nobody. Reports are left out deliberately: mailing the reported member would
// tell them who reported them before anyone has reviewed it.
//
// Where it stands: `__cursor__:activity` in the outbox holds the last row
// handled. It trails the clock by LAG_MS so a row written by a slow serverless
// instance with an older `_id` is not stepped over, and the first ever run
// looks back a day. Every mail keeps the dedupe key the backend gave it
// (`activity:<id>:<userId>:<suffix>`), so a row handled twice is still one mail.
const mongoose = require("mongoose");
const {
  findRecipientByDiscordId,
  queueMemberEmail,
  readCursor,
  writeCursor,
} = require("./mailQueue");
const { portalGet } = require("./mailPortal");
const {
  roleLostEmail,
  roleGainedEmail,
  teamChangeEmail,
  accountEmail,
  appealRejectedEmail,
} = require("./mailTemplates");

const { ObjectId } = mongoose.Types;

const CURSOR_KEY = "__cursor__:activity";
const LAG_MS = 60 * 1000;
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const BATCH = 200;
// A row whose handler keeps failing is retried on each pass, then given up on,
// so one bad row can not hold every mail behind it.
const MAX_ROW_FAILURES = 5;
const rowFailures = new Map();

// The titles activity entries are logged with → the role keys the rules use.
const ROLE_KEY = Object.freeze({
  "Project Captain": "projectCaptain",
  "Team Captain": "teamCaptain",
  Commander: "commander",
});

const ROMAN_VALUES = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
const ROMAN_SYMBOLS = ["M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"];
const toRoman = (value) => {
  let n = Math.floor(Number(value) || 0);
  if (n <= 0) return "";
  let out = "";
  for (let i = 0; i < ROMAN_VALUES.length; i += 1) {
    while (n >= ROMAN_VALUES[i]) {
      out += ROMAN_SYMBOLS[i];
      n -= ROMAN_VALUES[i];
    }
  }
  return out;
};

const clean = (value) => {
  const text = String(value ?? "").trim();
  return text && text !== "none" ? text : "";
};

const firstOf = (...values) => values.map(clean).find(Boolean) || "";

const companyLabel = (company) =>
  Number.isFinite(Number(company)) && Number(company) > 0
    ? `Company ${toRoman(Number(company))}`
    : "";

// A system actor is not someone who "appointed" or "removed" anybody.
const actorOf = (activity) => {
  const name = clean(activity.actorName);
  return name && name !== "Auto-selection" && name !== "Community member" ? name : "";
};

/**
 * A member's standing at this moment, for the "requirements that were not met"
 * list — or null when it cannot be stated reliably. The portal answers null for
 * an unavailable or incomplete leaderboard, and so does this when the portal
 * cannot be asked: no list rather than a false "0 of 3,000".
 */
const standingFor = async (user) => {
  try {
    const { standing } = await portalGet("standing", { userId: String(user._id) });
    return standing || null;
  } catch {
    return null;
  }
};

// A Project Captain is "of" a project, but a depose logs the teams. The Project
// doc survives a depose with its teams intact, so it can still name itself.
const projectNameForTeams = async (ctx, teamIds = []) => {
  const ids = teamIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(String(id)));
  if (!ids.length) return "";
  try {
    const project = await ctx.rankingConn
      .collection("projects")
      .findOne({ "teams.teamId": { $in: ids } }, { projection: { projectName: 1 } });
    return clean(project?.projectName);
  } catch {
    return "";
  }
};

const lost = ({ discordId, role, scope, actorName, replacedBy = "", nowLine = "", suffix = "lost" }) => ({
  discordId,
  kind: "role_lost",
  suffix,
  build: async (user) =>
    roleLostEmail({
      name: user.name,
      role,
      scope,
      actorName,
      replacedBy,
      nowLine,
      compliance: await standingFor(user),
    }),
});

const gained = ({ discordId, role, scope, actorName, autoSelected = false, suffix = "gained" }) => ({
  discordId,
  kind: "role_gained",
  suffix,
  build: (user) =>
    roleGainedEmail({ name: user.name, role, scope, actorName, autoSelected }),
});

const HANDLERS = {
  member_promoted: async (activity, meta, ctx) => {
    const role = ROLE_KEY[meta.promotedTo];
    if (!role) return [];
    const summary = meta.executionSummary || {};
    const scope =
      role === "commander"
        ? companyLabel(meta.company ?? summary.company)
        : firstOf(
            meta.projectName,
            summary.project,
            meta.teamName,
            summary.team,
            (meta.teamNames || []).join(", "),
          );
    const notices = [
      gained({
        discordId: meta.discordId,
        role,
        scope,
        actorName: actorOf(activity),
        autoSelected: Boolean(meta.autoSelected),
      }),
    ];

    // Seats this appointment emptied. The log records the new holder's
    // promotion and nothing for whoever they replaced, so the promotion names
    // them (`replacedDiscordId` on a leave return, `replacedDiscordIds` where an
    // SE appoints over a sitting captain) and they are told here.
    const replaced = [
      ...new Set(
        [meta.replacedDiscordId, ...(Array.isArray(meta.replacedDiscordIds) ? meta.replacedDiscordIds : [])]
          .map(clean)
          .filter((id) => id && id !== clean(meta.discordId)),
      ),
    ];
    if (replaced.length) {
      const replacement = await findRecipientByDiscordId(ctx.quantumConn, meta.discordId);
      for (const discordId of replaced) {
        notices.push(
          lost({
            discordId,
            role,
            scope,
            actorName: "",
            replacedBy: clean(replacement?.name),
            suffix: "replaced",
          }),
        );
      }
    }
    return notices;
  },

  member_demoted: async (activity, meta, ctx) => {
    const role = ROLE_KEY[meta.demotedFrom];
    if (!role) return [];
    const scope =
      role === "projectCaptain"
        ? firstOf(
            meta.ownProjectName,
            await projectNameForTeams(ctx, meta.teamIds),
            (meta.teamNames || []).join(", "),
          )
        : firstOf(meta.teamName, (meta.teamNames || []).join(", "));
    return [lost({ discordId: meta.discordId, role, scope, actorName: actorOf(activity) })];
  },

  member_transferred: async (activity, meta) => {
    const actorName = actorOf(activity);

    // A commander dragging someone between seats. Leaving a leadership seat for
    // a team roster is a demotion and reads as one; taking a seat is the
    // opposite; anything else is just a move.
    if (meta.transferKind === "commander_move") {
      const fromRole = { project_captain: "projectCaptain", commander: "commander" }[meta.fromContext];
      const seatScope = (label) => {
        const scope = clean(label).replace(/^(Project Captain|Commander) of /, "");
        return /^(an|their) /.test(scope) ? "" : scope;
      };
      if (fromRole && meta.toContext === "member") {
        return [
          lost({
            discordId: meta.discordId,
            role: fromRole,
            scope: seatScope(meta.fromLabel),
            actorName,
            nowLine: clean(meta.toLabel)
              ? `You are now a team member of **${clean(meta.toLabel)}**.`
              : "",
          }),
        ];
      }
      if (meta.toContext === "project_captain") {
        return [
          gained({
            discordId: meta.discordId,
            role: "projectCaptain",
            scope: seatScope(meta.toLabel),
            actorName,
          }),
        ];
      }
      return [
        {
          discordId: meta.discordId,
          kind: "team_change",
          suffix: "moved",
          build: (user) =>
            teamChangeEmail({
              name: user.name,
              change: "moved",
              fromLabel: clean(meta.fromLabel),
              toLabel: clean(meta.toLabel),
              actorName,
            }),
        },
      ];
    }

    const summary = meta.executionSummary || {};
    return [
      {
        discordId: meta.discordId,
        kind: "team_change",
        suffix: "moved",
        build: (user) =>
          teamChangeEmail({
            name: user.name,
            change: "moved",
            fromLabel: clean(meta.fromTeamName),
            toLabel: firstOf(
              meta.toTeamName,
              summary.toTeam,
              summary.team,
              summary.project,
              companyLabel(summary.company),
            ),
            actorName,
          }),
      },
    ];
  },

  member_removed_team: async (activity, meta) => [
    {
      discordId: meta.discordId,
      kind: "team_change",
      suffix: "removed",
      build: (user) =>
        teamChangeEmail({
          name: user.name,
          change: "removed",
          teamName: clean(meta.teamName),
          actorName: actorOf(activity),
        }),
    },
  ],

  member_joined_team: async (activity, meta) => [
    {
      discordId: meta.discordId,
      kind: "team_change",
      suffix: "joined",
      build: (user) =>
        teamChangeEmail({
          name: user.name,
          change: "joined",
          teamName: clean(meta.teamName),
          // Auto-assign and picking a team on returning from leave are the
          // member's own click; nobody added them.
          actorName:
            meta.joinKind === "auto_assign" || meta.joinKind === "leave_return"
              ? ""
              : actorOf(activity),
        }),
    },
  ],

  member_retired: async (activity, meta) => {
    const selfService = /self-service/i.test(String(meta.retiredBy || ""));
    return [
      {
        discordId: meta.discordId,
        kind: "account",
        suffix: "retired",
        build: (user) =>
          accountEmail({
            name: user.name,
            change: "retired",
            actorName: selfService ? "" : actorOf(activity),
            selfService,
          }),
      },
    ];
  },

  member_banned: async (activity, meta) => [
    {
      discordId: meta.reportedDiscordId,
      kind: "account",
      suffix: "banned",
      build: (user) =>
        accountEmail({
          name: user.name,
          change: "banned",
          teamName: clean(meta.teamName),
          actorName: actorOf(activity),
        }),
    },
  ],

  member_unbanned: async (activity, meta) => [
    {
      discordId: meta.bannedDiscordId,
      kind: "account",
      suffix: "unbanned",
      build: (user) =>
        accountEmail({ name: user.name, change: "unbanned", actorName: actorOf(activity) }),
    },
  ],

  appeal_rejected: async (activity, meta) => {
    // Lecture appeals carry no member id — only role and ban appeals do.
    const isBan = meta.appealKind === "ban";
    if (!isBan && meta.appealKind !== "role") return [];
    return [
      {
        discordId: isBan ? meta.bannedDiscordId : meta.discordId,
        kind: "appeal",
        suffix: "rejected",
        build: (user) =>
          appealRejectedEmail({
            name: user.name,
            appealType: isBan ? "ban" : meta.appealType,
            reviewerName: actorOf(activity),
          }),
      },
    ];
  },

  // Only the company events that move a person in or out of a commander seat.
  org_structure_changed: async (activity, meta) => {
    const actorName = actorOf(activity);
    const scope = companyLabel(meta.company);

    if (meta.action === "company_vacated") {
      return [lost({ discordId: meta.discordId, role: "commander", scope, actorName })];
    }
    if (meta.action === "company_reassigned") {
      return [
        lost({
          discordId: meta.fromDiscordId,
          role: "commander",
          scope,
          replacedBy: clean(meta.toName),
        }),
        gained({ discordId: meta.toDiscordId, role: "commander", scope, actorName }),
      ];
    }
    // A drag that takes someone into the commander seat, or out of it — the
    // same action either way, told apart by which end is the seat.
    if (meta.action === "company_commander_moved") {
      if (meta.toContext === "commander") {
        return [
          gained({ discordId: meta.discordId, role: "commander", scope, actorName }),
          lost({
            discordId: meta.replacedCommanderDiscordId,
            role: "commander",
            scope,
            replacedBy: clean(meta.memberName),
          }),
        ];
      }
      const destination = clean(meta.toLabel);
      return [
        lost({
          discordId: meta.discordId,
          role: "commander",
          scope,
          actorName,
          nowLine: !destination
            ? ""
            : meta.toContext === "member"
              ? `You are now a team member of **${destination}**.`
              : `You are now **${destination}**.`,
        }),
      ];
    }
    return [];
  },
};

const deliver = async (ctx, notice, activity) => {
  const user = await findRecipientByDiscordId(ctx.quantumConn, notice.discordId);
  if (!user) return { queued: false, reason: "NO_ACCOUNT" };
  return queueMemberEmail(ctx.rankingConn, {
    userId: user._id,
    kind: notice.kind,
    dedupeKey: `activity:${activity._id}:${user._id}:${notice.suffix}`,
    email: await notice.build(user),
  });
};

/**
 * Queue the emails the activity written since the last pass calls for.
 *
 * @param {{ quantumConn: import("mongoose").Connection, rankingConn: import("mongoose").Connection }} ctx
 * @returns {Promise<{ queued: number, handled: number, problem?: string }>}
 */
const runActivityMail = async (ctx) => {
  const rows = ctx.rankingConn.collection("communityActivities");

  const upper = ObjectId.createFromTime(Math.floor((Date.now() - LAG_MS) / 1000));
  let cursor = await readCursor(ctx.rankingConn, CURSOR_KEY);
  if (!cursor) {
    cursor = ObjectId.createFromTime(Math.floor((Date.now() - FIRST_RUN_LOOKBACK_MS) / 1000));
  }

  const batch = await rows
    .find({ _id: { $gt: cursor, $lte: upper }, type: { $in: Object.keys(HANDLERS) } })
    .sort({ _id: 1 })
    .limit(BATCH)
    .toArray();

  let queued = 0;
  let handled = 0;
  let problem = "";
  let advanceTo = batch.length === BATCH ? batch[batch.length - 1]._id : upper;

  for (const activity of batch) {
    const id = String(activity._id);
    try {
      const notices = await HANDLERS[activity.type](activity, activity.meta || {}, ctx);
      for (const notice of notices) {
        const result = await deliver(ctx, notice, activity);
        if (result.queued) queued += 1;
        // A queue that would not take a mail is a fault, not "no recipient".
        if (result.reason === "ERROR") throw new Error("could not write to the outbox");
      }
      rowFailures.delete(id);
      handled += 1;
    } catch (err) {
      const failures = (rowFailures.get(id) || 0) + 1;
      rowFailures.set(id, failures);
      console.warn(`[mail] ${activity.type} ${id} attempt ${failures} failed: ${err.message}`);
      if (failures < MAX_ROW_FAILURES) {
        // Stop here; the next pass starts again from this row.
        problem = `${activity.type} ${id}: ${err.message}`;
        advanceTo = batch[batch.indexOf(activity) - 1]?._id || cursor;
        break;
      }
      rowFailures.delete(id);
      problem = `gave up on ${activity.type} ${id}: ${err.message}`;
    }
  }

  if (String(advanceTo) !== String(cursor)) {
    await writeCursor(ctx.rankingConn, CURSOR_KEY, advanceTo);
  }
  return { queued, handled, ...(problem && { problem }) };
};

module.exports = { runActivityMail, HANDLERS };
