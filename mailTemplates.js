// What every member email says and looks like.
//
// Pure on purpose — no database, no models — so a template can be rendered and
// read without a connection (previewMemberEmails.js writes them all to disk).
// Each builder returns { subject, text, html }; who it goes to and when is the
// business of mailActivity.js, mailIdeas.js and mailSweeps.js, and the sending
// is mailer.js. The backend sends and queues no member mail at all.
//
// Links in a mail point at CLIENT_URL (the deployed portal, comma-separated
// like the backend's CORS list) — set it in this worker's own .env, or the
// buttons are left out.
//
// Every interpolated value is a name a member typed, so everything goes through
// escapeHtml. The one piece of markup a line may carry is **bold**, applied
// after escaping.

const ROLE_LABEL = Object.freeze({
  teamCaptain: "Team Captain",
  projectCaptain: "Project Captain",
  commander: "Commander",
});

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);

const toHtml = (line) =>
  escapeHtml(line).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
const toText = (line) => String(line ?? "").replace(/\*\*(.+?)\*\*/g, "$1");

const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const plural = (n, word) => `${fmt(n)} ${word}${Number(n) === 1 ? "" : "s"}`;

// CLIENT_URL is the CORS origin list, so a local origin can sit first in it. A
// link in someone's inbox has to be the deployed portal or nothing.
const portalUrl = () =>
  String(process.env.CLIENT_URL || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter((origin) => /^https?:\/\//i.test(origin))
    .find((origin) => !/\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(origin)) || "";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-10-06" → "Tue, 6 Oct 2026". The keys are PKT calendar dates, so they
// are formatted as dates, never shifted through a timezone — and spelled out
// here rather than by toLocaleDateString, whose month names differ between the
// Node versions the backend's hosts run.
const formatDayKey = (key, { weekday = true, year = true } = {}) => {
  const date = new Date(`${key}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return String(key || "");
  return [
    weekday ? `${WEEKDAYS[date.getUTCDay()]},` : "",
    date.getUTCDate(),
    MONTHS[date.getUTCMonth()],
    year ? date.getUTCFullYear() : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
};

const addDaysToKey = (key, days) => {
  const date = new Date(`${key}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

// A Mon–Sun week from its Monday: "29 Sep – 5 Oct 2026".
const formatWeekRange = (mondayKey) => {
  const sundayKey = addDaysToKey(mondayKey, 6);
  if (!sundayKey) return String(mondayKey || "");
  return `${formatDayKey(mondayKey, { weekday: false, year: false })} – ${formatDayKey(
    sundayKey,
    { weekday: false },
  )}`;
};

// A calendar month from its 1st: "Sep 2026".
const formatMonthKey = (firstKey) => {
  const date = new Date(`${firstKey}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return String(firstKey || "");
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "there";

const TONES = Object.freeze({
  alert: "#d92d20",
  success: "#b7791f",
  info: "#4f51e3",
});

/**
 * The one layout every member email uses.
 *
 * @param {object} mail
 * @param {string} mail.subject
 * @param {string} mail.heading
 * @param {string} [mail.name] recipient, for the greeting
 * @param {string[]} [mail.paragraphs] before the list
 * @param {string} [mail.quote] another member's words, shown set apart and
 *   never interpreted — no **bold**, line breaks kept
 * @param {string} [mail.listTitle]
 * @param {string[]} [mail.items]
 * @param {string[]} [mail.closing] after the list
 * @param {{ label: string, path: string }} [mail.cta] path on the portal
 * @param {"alert"|"success"|"info"} [mail.tone]
 */
const renderMemberEmail = ({
  subject,
  heading,
  name = "",
  paragraphs = [],
  quote = "",
  listTitle = "",
  items = [],
  closing = [],
  cta = null,
  tone = "info",
}) => {
  const accent = TONES[tone] || TONES.info;
  const portal = portalUrl();
  const link = cta && portal ? `${portal}${cta.path}` : "";
  const greeting = `Hi ${firstName(name)},`;
  const quoted = String(quote || "").trim();

  const text = [
    greeting,
    ...paragraphs.map(toText),
    ...(quoted ? [quoted.split("\n").map((line) => `> ${line}`).join("\n")] : []),
    ...(items.length
      ? [[listTitle && `${toText(listTitle)}:`, ...items.map((item) => `  - ${toText(item)}`)]
          .filter(Boolean)
          .join("\n")]
      : []),
    ...closing.map(toText),
    ...(link ? [`${cta.label}: ${link}`] : []),
    "— Quantum Logics",
  ].join("\n\n");

  const p = (line, extra = "") =>
    `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#2a2c3a;${extra}">${toHtml(line)}</p>`;

  const list = items.length
    ? `<div style="margin:4px 0 18px;padding:14px 16px;border-radius:10px;background:#f6f7fb;border-left:4px solid ${accent}">
        ${
          listTitle
            ? `<div style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#5b5e72">${escapeHtml(listTitle)}</div>`
            : ""
        }
        <ul style="margin:0;padding:0 0 0 18px">
          ${items
            .map(
              (item) =>
                `<li style="margin:0 0 6px;font-size:15px;line-height:1.55;color:#2a2c3a">${toHtml(item)}</li>`,
            )
            .join("")}
        </ul>
      </div>`
    : "";

  const quoteBlock = quoted
    ? `<div style="margin:4px 0 18px;padding:12px 16px;border-radius:10px;background:#f6f7fb;border-left:4px solid ${accent};font-size:15px;line-height:1.6;color:#2a2c3a;white-space:pre-wrap;word-break:break-word">${escapeHtml(quoted)}</div>`
    : "";

  const button = link
    ? `<p style="margin:22px 0 6px">
        <a href="${escapeHtml(link)}" style="display:inline-block;padding:11px 20px;border-radius:8px;background:${accent};color:#ffffff;font-size:14px;font-weight:700;text-decoration:none">${escapeHtml(cta.label)}</a>
      </p>`
    : "";

  const html = `<div style="margin:0;padding:24px 12px;background:#f1f2f8;font-family:Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e5ef;border-radius:12px">
    <tr>
      <td style="padding:16px 28px;border-bottom:1px solid #eceef5;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#4f51e3">Quantum Logics</td>
    </tr>
    <tr>
      <td style="padding:26px 28px 22px">
        <div style="width:44px;height:4px;margin:0 0 16px;border-radius:2px;background:${accent}"></div>
        <h1 style="margin:0 0 16px;font-size:21px;line-height:1.3;color:#0f1017">${escapeHtml(heading)}</h1>
        ${p(greeting)}
        ${paragraphs.map((line) => p(line)).join("\n        ")}
        ${quoteBlock}
        ${list}
        ${closing.map((line) => p(line)).join("\n        ")}
        ${button}
      </td>
    </tr>
    <tr>
      <td style="padding:14px 28px 18px;border-top:1px solid #eceef5;font-size:12px;line-height:1.5;color:#8a8da1">
        You are receiving this because you are a member of the Quantum Logics community.${
          portal
            ? ` <a href="${escapeHtml(portal)}" style="color:#8a8da1">${escapeHtml(portal.replace(/^https?:\/\//i, ""))}</a>`
            : ""
        }
      </td>
    </tr>
  </table>
</div>`;

  return { subject, text, html };
};

// ─── Role alerts (the red Alerts button on Overview, by email) ───────────────

/**
 * @param {object} args
 * @param {string} args.role teamCaptain | projectCaptain | commander
 * @param {Array} args.alerts as built by utils/roleCompliance.js buildRoleAlerts
 * @param {string} args.prevWeekKey Monday of the week the stream rule judged
 */
const roleAlertEmail = ({ name, role, alerts = [], prevWeekKey }) => {
  const position = ROLE_LABEL[role] || "leadership";
  const paragraphs = [];
  const items = [];

  const streams = alerts.find((alert) => alert.key === "streams");
  if (streams) {
    const remaining = Math.max(0, streams.required - (streams.current || 0));
    paragraphs.push(
      streams.newlyAppointed
        ? `You became ${position} recently, and ${position}s are expected to upload **${streams.required} streams every week**.`
        : `Last week (${formatWeekRange(prevWeekKey)}) you uploaded **${streams.lastWeek} of the ${streams.required} required streams**.`,
    );
    items.push(
      streams.current > 0
        ? `Upload **${plural(remaining, "more stream")}** by Sunday — you have ${streams.current} of ${streams.required} so far this week.`
        : `Upload **${plural(streams.required, "stream")} this week**, by Sunday (Pakistan time).`,
    );
  }

  const knight = alerts.find((alert) => alert.key === "knight");
  if (knight) {
    const toGo = Math.max(0, knight.required - knight.current);
    paragraphs.push(
      `${position}s must hold **Knight tier** — ${fmt(knight.required)} quantum points. You have **${fmt(knight.current)}**.`,
    );
    items.push(`Earn **${fmt(toGo)} more quantum points** to reach Knight tier.`);
  }

  return renderMemberEmail({
    subject: `Action needed: your ${position} position is at risk`,
    heading: `Your ${position} position is at risk`,
    name,
    tone: "alert",
    paragraphs,
    listTitle: "To keep your position",
    items,
    closing: [
      "Each alert clears on its own as soon as you meet the rule. You can follow your progress from the Alerts button on your Overview.",
    ],
    cta: { label: "Open your dashboard", path: "/overview" },
  });
};

// ─── Losing and gaining a position ───────────────────────────────────────────

// The rules a role is held to, as the lines an email lists. `compliance` is the
// shape utils/roleCompliance.js computes; only failing rules come back.
const unmetRequirements = (role, compliance) => {
  if (!compliance) return [];
  const lines = [];
  const knightRole = role === "projectCaptain" || role === "commander";
  const streamRole = role === "projectCaptain" || role === "teamCaptain";

  if (knightRole && compliance.notKnight) {
    lines.push(
      `**Knight tier** — you had ${fmt(compliance.points)} of the ${fmt(compliance.knightMinPoints)} quantum points required.`,
    );
  }
  if (streamRole && compliance.streamsShort) {
    lines.push(
      `**Weekly streams** — you uploaded ${compliance.prevWeekStreamCount} of the ${compliance.requiredPrevWeekStreams} required last week (${formatWeekRange(compliance.prevWeekKey)}).`,
    );
  }
  return lines;
};

const WHAT_NOW = Object.freeze({
  projectCaptain: () =>
    "You are now a regular member of the community and no longer hold a Project Captain position.",
  teamCaptain: (scope) =>
    scope
      ? `You are now a team member of ${scope} rather than its captain.`
      : "You are now a team member rather than a captain.",
  commander: () => "You no longer command a company.",
});

/**
 * @param {object} args
 * @param {string} args.role the position lost
 * @param {string} [args.scope] what it was a position of — a project, team or company
 * @param {string} [args.actorName] who made the change
 * @param {string} [args.replacedBy] the member who now holds it, when replaced
 * @param {string} [args.nowLine] overrides the default "what you are now" line
 * @param {object} [args.compliance] standing at the time, for the unmet rules
 */
const roleLostEmail = ({
  name,
  role,
  scope = "",
  actorName = "",
  replacedBy = "",
  nowLine = "",
  compliance = null,
}) => {
  const position = ROLE_LABEL[role] || "leadership";
  const of = scope ? ` of ${scope}` : "";
  const reasons = unmetRequirements(role, compliance);

  const opening = replacedBy
    ? `**${replacedBy}** has taken over as ${position}${of}.`
    : actorName
      ? `${actorName} has removed you as ${position}${of}.`
      : `You have been removed as ${position}${of}.`;

  return renderMemberEmail({
    subject: `You are no longer ${position}${of}`,
    heading: `You are no longer ${position}${of}`,
    name,
    tone: "alert",
    paragraphs: [opening, nowLine || (WHAT_NOW[role] ? WHAT_NOW[role](scope) : "")].filter(Boolean),
    listTitle: reasons.length ? "Requirements that were not met" : "",
    items: reasons,
    closing: [
      reasons.length
        ? "Meet these requirements and you can earn the position back."
        : "If you think this is a mistake, speak to your Commander or a Software Engineer.",
    ],
    cta: { label: "Read the rules", path: "/rules" },
  });
};

const KEEP_IT = Object.freeze({
  projectCaptain: [
    "Hold **Knight tier** — 3,000 quantum points or more.",
    "Upload **3 streams every week** (Monday to Sunday, Pakistan time).",
  ],
  teamCaptain: ["Upload **3 streams every week** (Monday to Sunday, Pakistan time)."],
  commander: ["Hold **Knight tier** — 3,000 quantum points or more."],
});

const roleGainedEmail = ({ name, role, scope = "", actorName = "", autoSelected = false }) => {
  const position = ROLE_LABEL[role] || "leadership";
  const of = scope ? ` of ${scope}` : "";

  const opening = autoSelected
    ? `You were selected as ${position}${of} — the Knight-tier Team Captain with the most quantum points on the project.`
    : actorName
      ? `${actorName} has appointed you ${position}${of}.`
      : `You have been appointed ${position}${of}.`;

  return renderMemberEmail({
    subject: `Congratulations — you are now ${position}${of}`,
    heading: `You are now ${position}${of}`,
    name,
    tone: "success",
    paragraphs: [opening],
    listTitle: "To keep the position",
    items: KEEP_IT[role] || [],
    closing: [
      "If a requirement slips you will see an alert on your Overview and get an email like this one.",
    ],
    cta: { label: "Open your dashboard", path: "/overview" },
  });
};

// ─── Team membership ─────────────────────────────────────────────────────────

/** @param {"joined"|"removed"|"moved"} args.change */
const teamChangeEmail = ({
  name,
  change,
  teamName = "",
  fromLabel = "",
  toLabel = "",
  actorName = "",
}) => {
  if (change === "joined") {
    return renderMemberEmail({
      subject: `You are now on ${teamName || "a team"}`,
      heading: `Welcome to ${teamName || "your team"}`,
      name,
      tone: "success",
      paragraphs: [
        actorName
          ? `${actorName} added you to **${teamName}**.`
          : `You are now a member of **${teamName}**.`,
        "Your team, its captain and its project are on the Teams page.",
      ],
      cta: { label: "Open the portal", path: "/overview" },
    });
  }

  if (change === "removed") {
    return renderMemberEmail({
      subject: `You were removed from ${teamName || "your team"}`,
      heading: `You are no longer on ${teamName || "your team"}`,
      name,
      tone: "alert",
      paragraphs: [
        actorName
          ? `${actorName} removed you from **${teamName}**.`
          : `You have been removed from **${teamName}**.`,
      ],
      closing: [
        "If you think this is a mistake, speak to your Project Captain or a Software Engineer.",
      ],
      cta: { label: "Open the portal", path: "/overview" },
    });
  }

  const destination = toLabel || teamName || "a new team";
  return renderMemberEmail({
    subject: `You have been moved to ${destination}`,
    heading: `You have been moved to ${destination}`,
    name,
    tone: "info",
    paragraphs: [
      [
        actorName ? `${actorName} moved you` : "You have been moved",
        fromLabel ? ` from **${fromLabel}**` : "",
        ` to **${destination}**.`,
      ].join(""),
    ],
    cta: { label: "Open the portal", path: "/overview" },
  });
};

// ─── Medals ──────────────────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {"day"|"week"} args.period
 * @param {string} args.startKey first PKT day of the window
 * @param {Array<{ label: string, reason: string, points: number }>} args.medals
 * @param {string} [args.handle] GitHub handle, for the profile link
 */
const medalEmail = ({ name, period, startKey, medals = [], handle = "" }) => {
  const when =
    period === "week"
      ? `the week of ${formatWeekRange(startKey)}`
      : period === "month"
        ? formatMonthKey(startKey)
        : formatDayKey(startKey);
  const total = medals.reduce((sum, medal) => sum + (medal.points || 0), 0);
  const single = medals.length === 1 ? medals[0] : null;

  return renderMemberEmail({
    subject: single
      ? `🏅 You won the ${single.label} medal — congratulations!`
      : `🏅 You won ${medals.length} medals — congratulations!`,
    heading: single ? `You won the ${single.label} medal` : `You won ${medals.length} medals`,
    name,
    tone: "success",
    paragraphs: [
      single
        ? `Congratulations! You earned the **${single.label}** medal for **${when}**.`
        : `Congratulations! You earned **${medals.length} medals** for **${when}**.`,
    ],
    listTitle: single ? "How you won it" : "Your medals",
    // `reason` is a lowercase clause ("you topped the board with 312 points")
    // so it reads after a medal's name; on its own line it starts a sentence.
    items: medals.map((medal) =>
      single
        ? `${medal.reason.charAt(0).toUpperCase()}${medal.reason.slice(1)} — worth **+${fmt(medal.points)} quantum points**.`
        : `**${medal.label}** (+${fmt(medal.points)} points) — ${medal.reason}.`,
    ),
    closing: [
      single
        ? "The medal is on your profile now, and its points count toward your rank."
        : `They are on your profile now, and their ${fmt(total)} quantum points count toward your rank.`,
    ],
    cta: handle
      ? { label: "See your profile", path: `/@${encodeURIComponent(handle)}` }
      : { label: "See the board", path: "/explore" },
  });
};

// ─── Account and appeals ─────────────────────────────────────────────────────

/** @param {"banned"|"unbanned"|"retired"} args.change */
const accountEmail = ({ name, change, teamName = "", actorName = "", selfService = false }) => {
  if (change === "banned") {
    return renderMemberEmail({
      subject: "Your Quantum Logics account has been banned",
      heading: "Your account has been banned",
      name,
      tone: "alert",
      paragraphs: [
        [
          actorName ? `${actorName} has banned your account` : "Your account has been banned",
          teamName ? ` following a report on **${teamName}**.` : ".",
        ].join(""),
      ],
      closing: [
        "You can read the reason and submit an appeal by signing in to the portal. Software Engineers review every appeal.",
      ],
      cta: { label: "Sign in to appeal", path: "/login" },
    });
  }

  if (change === "unbanned") {
    return renderMemberEmail({
      subject: "Your ban has been lifted",
      heading: "Your ban has been lifted",
      name,
      tone: "success",
      paragraphs: [
        actorName
          ? `${actorName} has lifted the ban on your account. Welcome back.`
          : "The ban on your account has been lifted. Welcome back.",
      ],
      cta: { label: "Open the portal", path: "/overview" },
    });
  }

  return renderMemberEmail({
    subject: "Your retirement has been recorded",
    heading: "You are now retired",
    name,
    tone: "info",
    paragraphs: [
      selfService || !actorName
        ? "Your retirement from the Quantum Logics community has been recorded."
        : `${actorName} has recorded your retirement from the Quantum Logics community.`,
      "Any team or leadership position you held has been released. Thank you for everything you contributed.",
    ],
    closing: selfService
      ? []
      : ["If you think this is a mistake, speak to a Software Engineer."],
  });
};

/** @param {"promotion"|"transfer"|"ban"} args.appealType */
const appealRejectedEmail = ({ name, appealType, reviewerName = "" }) => {
  const noun =
    appealType === "ban" ? "ban appeal" : `${appealType === "transfer" ? "transfer" : "promotion"} appeal`;
  return renderMemberEmail({
    subject: `Your ${noun} was not approved`,
    heading: `Your ${noun} was not approved`,
    name,
    tone: "info",
    paragraphs: [
      reviewerName
        ? `${reviewerName} reviewed your ${noun} and did not approve it.`
        : `Your ${noun} was reviewed and not approved.`,
    ],
    closing: [
      appealType === "ban"
        ? "The ban on your account stays in place."
        : "Nothing about your current role or team has changed. You can submit a new appeal from the portal.",
    ],
    cta: appealType === "ban" ? null : { label: "Open the portal", path: "/overview" },
  });
};

// ─── Ideas ───────────────────────────────────────────────────────────────────

const clip = (value, max) => {
  const text = String(value || "").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

/**
 * Someone commented on the recipient's idea. The comment is another member's
 * text arriving in a mail from admin@, so it is shown as a quote under their
 * name and nowhere else — never in the subject line.
 */
const ideaCommentEmail = ({ name, commenterName, ideaTitle, commentBody, commentCount = 0 }) => {
  const who = String(commenterName || "").trim() || "A community member";
  const title = clip(ideaTitle, 80) || "your idea";
  // How many comments the idea has now, this one included. Worth saying: with
  // one mail per commenter a day, the count is how an author sees that more
  // was said than the one comment quoted here. Left out when it is not known.
  const count = Math.floor(Number(commentCount)) || 0;
  const tally =
    count === 1
      ? "Your idea now has **1 comment**."
      : count > 1
        ? `Your idea now has **${fmt(count)} comments**.`
        : "";
  return renderMemberEmail({
    subject: "Your idea got a new comment",
    heading: "Your idea got a new comment",
    name,
    tone: "info",
    paragraphs: [`**${who}** commented on your idea **${title}**. ${tally}`.trim()],
    quote: clip(commentBody, 500),
    closing: ["You can reply, and read the whole thread, on the ideas board."],
    cta: { label: "Open the ideas board", path: "/explore#ideas" },
  });
};

module.exports = {
  ROLE_LABEL,
  escapeHtml,
  formatDayKey,
  formatWeekRange,
  portalUrl,
  renderMemberEmail,
  roleAlertEmail,
  roleLostEmail,
  roleGainedEmail,
  teamChangeEmail,
  medalEmail,
  accountEmail,
  appealRejectedEmail,
  ideaCommentEmail,
};
