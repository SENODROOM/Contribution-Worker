#!/usr/bin/env node
/**
 * Render every member email with sample data, to read before it reaches anyone.
 * Touches no database and sends nothing.
 *
 *   node previewMemberEmails.js [outDir]
 *
 * Writes one .html per email plus an index.html into outDir (default: a
 * ql-member-emails folder in the system temp directory) and prints the path.
 * The templates are mailTemplates.js; the names and numbers here are
 * made up.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

// Links are only rendered against a deployed origin (never localhost), so the
// preview gets a stand-in one to show the buttons with.
process.env.CLIENT_URL = "https://portal.example";

const {
  roleAlertEmail,
  roleLostEmail,
  roleGainedEmail,
  teamChangeEmail,
  medalEmail,
  accountEmail,
  appealRejectedEmail,
  ideaCommentEmail,
} = require("./mailTemplates");

const failing = {
  points: 2450,
  knightMinPoints: 3000,
  notKnight: true,
  prevWeekKey: "2026-09-28",
  prevWeekStreamCount: 1,
  requiredPrevWeekStreams: 3,
  streamsShort: true,
};

const SAMPLES = {
  "role-alert-team-captain": roleAlertEmail({
    name: "Ayesha Khan",
    role: "teamCaptain",
    prevWeekKey: "2026-09-28",
    alerts: [{ key: "streams", lastWeek: 1, current: 0, required: 3 }],
  }),
  "role-alert-project-captain": roleAlertEmail({
    name: "Bilal Ahmed",
    role: "projectCaptain",
    prevWeekKey: "2026-09-28",
    alerts: [
      { key: "knight", current: 2450, required: 3000 },
      { key: "streams", lastWeek: 0, current: 1, required: 3 },
    ],
  }),
  "role-alert-commander": roleAlertEmail({
    name: "Sana Malik",
    role: "commander",
    prevWeekKey: "2026-09-28",
    alerts: [{ key: "knight", current: 2890, required: 3000 }],
  }),
  "role-lost-project-captain": roleLostEmail({
    name: "Bilal Ahmed",
    role: "projectCaptain",
    scope: "PolyCode",
    actorName: "Hamza Tariq",
    compliance: failing,
  }),
  "role-lost-team-captain-replaced": roleLostEmail({
    name: "Ayesha Khan",
    role: "teamCaptain",
    scope: "Mercury",
    replacedBy: "Usman Raza",
    compliance: { ...failing, notKnight: false },
  }),
  "role-lost-no-unmet-rules": roleLostEmail({
    name: "Sana Malik",
    role: "commander",
    scope: "Company IV",
    actorName: "Hamza Tariq",
    compliance: null,
  }),
  "role-gained-auto-selected": roleGainedEmail({
    name: "Usman Raza",
    role: "projectCaptain",
    scope: "PolyCode",
    autoSelected: true,
  }),
  "role-gained-team-captain": roleGainedEmail({
    name: "Ayesha Khan",
    role: "teamCaptain",
    scope: "Mercury",
    actorName: "Hamza Tariq",
  }),
  "team-joined": teamChangeEmail({ name: "Zain Ali", change: "joined", teamName: "Mercury" }),
  "team-removed": teamChangeEmail({
    name: "Zain Ali",
    change: "removed",
    teamName: "Mercury",
    actorName: "Hamza Tariq",
  }),
  "team-moved": teamChangeEmail({
    name: "Zain Ali",
    change: "moved",
    fromLabel: "Mercury",
    toLabel: "Venus",
    actorName: "Bilal Ahmed",
  }),
  "medal-daily": medalEmail({
    name: "Fatima Noor",
    period: "day",
    startKey: "2026-10-06",
    handle: "fatima-noor",
    medals: [
      {
        label: "Daily Achiever",
        reason: "you topped the Most active board with 312 points",
        points: 50,
      },
    ],
  }),
  "medal-weekly-three": medalEmail({
    name: "Fatima Noor",
    period: "week",
    startKey: "2026-09-28",
    handle: "fatima-noor",
    medals: [
      {
        label: "Weekly Achiever",
        reason: "you topped the Most active board with 1,480 points",
        points: 100,
      },
      {
        label: "GitHub Champ",
        reason: "you pushed the most commits that week (96 commits)",
        points: 40,
      },
      {
        label: "PR Titan Silver",
        reason: "you opened the most pull requests that week (14 pull requests)",
        points: 60,
      },
    ],
  }),
  "medal-monthly": medalEmail({
    name: "Fatima Noor",
    period: "month",
    startKey: "2026-09-01",
    handle: "fatima-noor",
    medals: [
      {
        label: "Monthly Achiever",
        reason: "you topped the Most active board with 2,346 points",
        points: 400,
      },
      {
        label: "PR Titan Gold",
        reason: "you opened the most pull requests that month (99 pull requests)",
        points: 240,
      },
    ],
  }),
  "account-banned": accountEmail({
    name: "Zain Ali",
    change: "banned",
    teamName: "Mercury",
    actorName: "Hamza Tariq",
  }),
  "account-unbanned": accountEmail({ name: "Zain Ali", change: "unbanned", actorName: "Hamza Tariq" }),
  "account-retired": accountEmail({ name: "Zain Ali", change: "retired", selfService: true }),
  "appeal-rejected": appealRejectedEmail({
    name: "Ayesha Khan",
    appealType: "promotion",
    reviewerName: "Hamza Tariq",
  }),
  "idea-comment": ideaCommentEmail({
    name: "Ayesha Khan",
    commenterName: "Usman Raza",
    ideaTitle: "Dark mode for the profile heatmap",
    commentCount: 1,
    commentBody:
      "Love this.\nCould it follow the system theme by default, with a toggle for people who want to pin it?",
  }),
};

const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "ql-member-emails"));
fs.mkdirSync(outDir, { recursive: true });

const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${title}</title></head><body style="margin:0">${body}</body></html>`;

const links = [];
for (const [name, email] of Object.entries(SAMPLES)) {
  fs.writeFileSync(path.join(outDir, `${name}.html`), page(email.subject, email.html));
  fs.writeFileSync(path.join(outDir, `${name}.txt`), `Subject: ${email.subject}\n\n${email.text}\n`);
  links.push(
    `<li style="margin:0 0 8px"><a href="${name}.html">${name}</a> — ${email.subject}</li>`,
  );
}
fs.writeFileSync(
  path.join(outDir, "index.html"),
  page(
    "Member emails",
    `<div style="padding:24px;font-family:Arial,sans-serif"><h1 style="font-size:20px">Member emails</h1><ul>${links.join("")}</ul></div>`,
  ),
);

console.log(`${Object.keys(SAMPLES).length} emails written to ${outDir}`);
