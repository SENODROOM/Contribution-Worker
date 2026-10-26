#!/usr/bin/env node
/**
 * Give member emails that were written off as "failed" another chance.
 *
 *   node repairFailedEmails.js --dry-run   # show what would happen, change nothing
 *   node repairFailedEmails.js             # do it
 *
 * WRITES to ranking.emailOutbox, and what it writes is sent to members by this
 * worker within a minute. Run the dry run first and read it. Run it from the
 * folder the worker runs from, on the machine it runs on (its .env is the one
 * with the database and PORTAL_API_URL).
 *
 * It exists because of 2026-10-07 → 09: the production worker had the new mail
 * code but not the `nodemailer` package, every send died on "Cannot find
 * module", and 25 mails used up their attempts and were marked failed. Fixing
 * the worker sends new mail; it does not bring those back.
 *
 * What happens to each failed mail:
 *
 *   expired            left alone — a mail past its `expiresAt` is stale, and
 *                      the worker would skip it anyway.
 *   role alert         NOT re-sent as written. It was true the day it was
 *                      queued; by now the member may have uploaded their
 *                      streams. Each such leader is judged again on today's
 *                      numbers (the portal's mail-facts/role-alerts with
 *                      `resend`): still failing → a fresh mail; cleared →
 *                      nothing. The old row is closed as `skipped`.
 *   anything else      put back in the queue as it was — a medal won or a
 *                      comment received is as true today as it was then.
 *
 * It refuses to run for real while the mailer is not reporting that it can send
 * (the heartbeat row), because re-queueing into a mailer that cannot send is how
 * these mails were lost the first time. `--force` overrides that.
 *
 * Safe to run twice: a re-queued mail is no longer "failed", and a resent alert
 * has its own dedupe key.
 */
require("dns").setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);
require("dotenv").config();

const { openConnections } = require("./sweep");
const { portalGet, portalUnavailableReason } = require("./mailPortal");
const { runRoleAlertSweep, prevWeekMondayKey } = require("./mailSweeps");

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

// The mailer stamps its heartbeat every pass (a minute apart by default).
const HEARTBEAT_KEY = "__worker__";
const HEARTBEAT_FRESH_MS = 5 * 60 * 1000;

const firstLine = (text) => String(text || "").split("\n")[0].slice(0, 90);

const workerProblem = async (outbox) => {
  const beat = await outbox.findOne({ dedupeKey: HEARTBEAT_KEY });
  if (!beat) {
    return "the worker has never reported in — it is not running the current code (pull, npm install, restart)";
  }
  if (Date.now() - new Date(beat.updatedAt).getTime() > HEARTBEAT_FRESH_MS) {
    return `the worker last reported in at ${new Date(beat.updatedAt).toISOString()} — it is not running`;
  }
  if (beat.lastError) return `the worker cannot send: ${firstLine(beat.lastError)}`;
  return "";
};

const main = async () => {
  const quantumUri = process.env.MONGO_URI_QUANTUM;
  const rankingUri = process.env.MONGO_RANKING_URI;
  if (!quantumUri || !rankingUri) {
    console.error("MONGO_URI_QUANTUM and MONGO_RANKING_URI are required.");
    process.exit(1);
  }
  const connections = await openConnections({ quantumUri, rankingUri });
  const { quantumConn, rankingConn } = connections;
  const outbox = rankingConn.collection("emailOutbox");

  try {
    const now = new Date();
    const failed = await outbox.find({ status: "failed" }).sort({ createdAt: 1 }).toArray();
    if (failed.length === 0) {
      console.log("No failed emails. Nothing to repair.");
      return;
    }

    const users = await quantumConn
      .collection("users")
      .find({ _id: { $in: failed.map((mail) => mail.userId).filter(Boolean) } }, { projection: { name: 1 } })
      .toArray();
    const nameOf = new Map(users.map((user) => [String(user._id), user.name]));

    const alertPrefix = `role-alert:${prevWeekMondayKey()}:`;
    const expired = [];
    const alerts = [];
    const requeue = [];
    for (const mail of failed) {
      if (mail.expiresAt && new Date(mail.expiresAt) <= now) expired.push(mail);
      else if (mail.kind === "role_alert") {
        // An alert about a week that is no longer the one being judged is stale
        // whatever its expiry says.
        (mail.dedupeKey.startsWith(alertPrefix) ? alerts : expired).push(mail);
      } else requeue.push(mail);
    }

    const show = (label, mails) => {
      console.log(`\n${label} (${mails.length})`);
      for (const mail of mails) {
        console.log(
          `  ${mail.kind.padEnd(12)} ${nameOf.get(String(mail.userId)) || "(unknown member)"} — ${mail.subject}`,
        );
      }
    };

    console.log(
      `${failed.length} failed email(s). Last error on the newest: ${firstLine(failed[failed.length - 1].lastError)}`,
    );
    show("Back into the queue as written", requeue);
    show("Left alone — expired or out of date", expired);

    // Judged on today's numbers; nothing is queued by asking.
    const resendFor = alerts.map((mail) => String(mail.userId));
    let judged = { ran: true, leaders: [] };
    if (resendFor.length) {
      const unavailable = portalUnavailableReason();
      if (unavailable) {
        console.error(`\nCannot re-judge the role alerts: ${unavailable}. Nothing was changed.`);
        process.exitCode = 1;
        return;
      }
      judged = await portalGet("role-alerts", { resend: resendFor.join(",") });
    }
    if (!judged.ran) {
      console.error(
        `\nCould not re-judge the role alerts (${judged.reason}). Nothing was changed — try again shortly.`,
      );
      process.exitCode = 1;
      return;
    }
    const stillFailing = new Set(judged.leaders.map((leader) => leader.userId));
    console.log(`\nRole alerts, judged again on today's numbers (${alerts.length})`);
    for (const mail of alerts) {
      const id = String(mail.userId);
      const leader = judged.leaders.find((entry) => entry.userId === id);
      console.log(
        `  ${(leader ? "fresh mail" : "cleared — no mail").padEnd(18)} ${nameOf.get(id) || "(unknown member)"}` +
          (leader ? `  [${leader.alerts.map((alert) => alert.key).join(" + ")}]` : ""),
      );
    }

    const problem = await workerProblem(outbox);
    if (problem) console.log(`\n✗ Worker: ${problem}`);
    else console.log("\n✓ Worker's mailer is running and able to send.");

    const toSend = requeue.length + stillFailing.size;
    if (DRY_RUN) {
      console.log(`\nDry run — nothing changed. A real run would send ${toSend} email(s).`);
      return;
    }
    if (problem && !FORCE) {
      console.error(
        "\nNot run: these mails would only fail again. Fix the worker first " +
          "(check with `node backend/scripts/checkEmailOutbox.js`), or pass --force.",
      );
      process.exitCode = 1;
      return;
    }

    if (requeue.length) {
      await outbox.updateMany(
        { _id: { $in: requeue.map((mail) => mail._id) }, status: "failed" },
        { $set: { status: "pending", attempts: 0, lastError: "", nextAttemptAt: now } },
      );
    }
    if (alerts.length) {
      await outbox.updateMany(
        { _id: { $in: alerts.map((mail) => mail._id) }, status: "failed" },
        { $set: { status: "skipped", lastError: "never delivered — re-judged by repairFailedEmails" } },
      );
      await runRoleAlertSweep(connections, { resendFor });
    }

    console.log(`\nDone — ${toSend} email(s) queued; the worker sends them within a minute.`);
  } finally {
    await connections.close();
  }
};

main().catch((err) => {
  console.error("Repair failed:", err);
  process.exit(1);
});
