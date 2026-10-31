// Event submission check: clones what members submit to Quantum Launchpad and
// approves the ones that pass.
//
// Same doctrine as the other passes: the backend is on Vercel, which has no
// business cloning anything, so it only writes `pending` rows into
// ranking.eventSubmissions and reads the outcome. Approving writes the row
// directly; points are derived from approved rows (backend/utils/eventPoints.js),
// so there is nothing else to do.
//
// A row is approved only when ALL of these hold. Anything else stays pending for
// a Software Engineer with the reason on it (`repoCheck`) — this pass never
// rejects, because it cannot tell a bad submission from a missing allowance.
//
//   1. The repo's source is all .sa: every file is .sa or an ordinary project
//      file (PROJECT_FILES), and at least one is .sa.
//   2. The repo is under the member's own GitHub account and is not a fork. With
//      no human looking, this is what stops 1,000 points being claimed for
//      someone else's public repo, or a fork of it.
//   3. qpm has the package, and if it names a repository, it names this one.
//   4. No other approved row already earned on this package or repo.
//
// The clone is bare, shallow and has no file contents (--filter=blob:none): only
// the list of file names is needed, so nothing a member wrote is written to this
// machine or run, and a huge repo costs no more than a small one. No token is
// used: only a public repo can be checked, and a private one is told so.
const { execFile } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const mongoose = require("mongoose");
const { getGithubUsername } = require("./sweep");

const REVIEWER_ID = "contribution-worker";
const HEARTBEAT_ID = "__worker__";
const QPM_REGISTRY_URL = "https://qpm.quantumlogicslimited.com/api/registry";

// Enough for a real queue; the rest wait for the next pass.
const MAX_PER_PASS = 10;
const CLONE_TIMEOUT_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
// A member can push a fix without resubmitting, so a failed check is looked at
// again now and then. Something that merely could not be asked goes sooner.
const RECHECK_FAILED_MS = 6 * 60 * 60 * 1000;
const RETRY_UNAVAILABLE_MS = 30 * 60 * 1000;
const OTHER_FILES_KEPT = 20;

const GITHUB_OWNER = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/;
const GITHUB_REPO = /^[a-zA-Z0-9._-]{1,100}$/;

// What may sit beside the .sa files. `qpm init` itself writes the manifest, so a
// repo of nothing but .sa files could not be a published package. Matched on the
// file's name, at any depth. Data files, build output and other languages are not
// here on purpose: those go to a person.
const PROJECT_FILES = [
  /^readme(\.(md|txt|rst))?$/i,
  /^licen[cs]e(\.(md|txt))?$/i,
  /^(package\.json|qpm\.json|package\.qon)$/i,
  /^\.(gitignore|gitattributes)$/i,
];

const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

const isSaFile = (name) => /[^/]\.sa$/i.test(name);
const isProjectFile = (name) => PROJECT_FILES.some((rule) => rule.test(name));

// `git ls-tree -r -z`: "<mode> <type> <sha>\t<path>\0".
const parseTree = (output) =>
  String(output)
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { mode: line.slice(0, tab).split(" ")[0], path: line.slice(tab + 1) };
    });

// A symlink or submodule counts against the repo whatever it is called: a link
// named x.sa is not Quantum source.
const judgeTree = (entries) => {
  let saFiles = 0;
  const others = [];
  for (const entry of entries) {
    const name = path.posix.basename(entry.path);
    if (!REGULAR_FILE_MODES.has(entry.mode)) others.push(entry.path);
    else if (isSaFile(name)) saFiles += 1;
    else if (!isProjectFile(name)) others.push(entry.path);
  }
  return { saFiles, otherFileCount: others.length, otherFiles: others.slice(0, OTHER_FILES_KEPT) };
};

const git = (args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        timeout: CLONE_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
        ...options,
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = String(stderr || "");
          reject(err);
        } else {
          resolve(stdout);
        }
      },
    );
  });

/**
 * The newest commit's file list. { commit, entries }, with an empty list for a
 * repo with no commits. Throws when the repo cannot be cloned.
 */
const listRepoFiles = async (url) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "event-check-"));
  try {
    await git([
      // A credential helper could prompt, or answer with the host's own login.
      "-c",
      "credential.helper=",
      "clone",
      "--quiet",
      "--bare",
      "--depth=1",
      "--single-branch",
      "--no-tags",
      "--filter=blob:none",
      "--template=",
      url,
      dir,
    ]);
    let commit;
    try {
      // --verify: plain `rev-parse HEAD` can echo "HEAD" back for a repo with no
      // commits instead of failing.
      commit = String(
        await git(["-C", dir, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
      ).trim();
    } catch {
      return { commit: "", entries: [] };
    }
    const output = await git(["-C", dir, "ls-tree", "-r", "-z", commit]);
    return { commit, entries: parseTree(output) };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

const canonicalRepo = (value) => {
  const match = String(value || "").match(
    /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?(?:[#?].*)?$/i,
  );
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : "";
};

// Null when it could not be asked, which is not an answer about the repo.
const isFork = async (repoKey) => {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "QuantumCommunity-ContributionWorker",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `token ${process.env.GITHUB_TOKEN}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${repoKey}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return Boolean((await res.json()).fork);
  } catch {
    return null;
  }
};

// { found: true|false, repository }, or { found: null } when qpm did not answer.
const askQpm = async (packageName) => {
  try {
    const res = await fetch(`${QPM_REGISTRY_URL}/${encodeURIComponent(packageName)}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return { found: false };
    if (!res.ok) return { found: null };
    const data = await res.json();
    return { found: true, repository: String(data?.repository || "") };
  } catch {
    return { found: null };
  }
};

const memberHandle = async (quantumConn, userId) => {
  if (!mongoose.isValidObjectId(userId)) return "";
  const user = await quantumConn
    .collection("users")
    .findOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      { projection: { githubUrl: 1 } },
    );
  return String(getGithubUsername(user?.githubUrl) || "").toLowerCase();
};

const unavailable = (reason) => ({ state: "unavailable", reason });
const needsReview = (reason) => ({ state: "needs_review", reason });

// git missing from the host is this machine's fault, not the repo's: it stops the
// pass, and no row is marked.
class GitMissingError extends Error {}

const describeOthers = ({ otherFileCount, otherFiles }) =>
  `${otherFileCount} file${otherFileCount === 1 ? "" : "s"} that ` +
  `${otherFileCount === 1 ? "is" : "are"} not .sa, such as ${otherFiles.slice(0, 3).join(", ")}.`;

/** Work out one submission. Reads only: the caller writes the outcome. */
const inspectSubmission = async (row, { quantumConn, submissions }) => {
  if (!GITHUB_OWNER.test(row.repoOwner || "") || !GITHUB_REPO.test(row.repoName || "")) {
    return needsReview("The repository name is not valid.");
  }
  const repoKey = `${row.repoOwner}/${row.repoName}`;

  let listing;
  try {
    listing = await listRepoFiles(`https://github.com/${repoKey}.git`);
  } catch (err) {
    if (err.code === "ENOENT") throw new GitMissingError("git is not installed on this machine");
    return unavailable(
      err.killed
        ? "Cloning the repository took too long."
        : "The repository could not be cloned. It may be private, renamed or deleted.",
    );
  }

  const files = judgeTree(listing.entries);
  const facts = { commit: listing.commit, ...files };
  const stop = (verdict) => ({ ...facts, ...verdict });

  if (!files.saFiles) return stop(needsReview("The repository has no .sa files."));
  if (files.otherFileCount) return stop(needsReview(`The repository has ${describeOthers(files)}`));

  const handle = await memberHandle(quantumConn, row.userId);
  if (!handle || handle !== row.repoOwner.toLowerCase()) {
    return stop(needsReview("The repository is not under this member's linked GitHub account."));
  }

  const fork = await isFork(repoKey);
  if (fork === null) return stop(unavailable("GitHub could not say whether this is a fork."));
  if (fork) return stop(needsReview("The repository is a fork."));

  const qpm = await askQpm(row.packageName);
  if (qpm.found === null) return stop(unavailable("qpm could not be reached."));
  if (!qpm.found) return stop(needsReview("qpm has no package with this name."));
  const listed = canonicalRepo(qpm.repository);
  if (listed && listed !== repoKey.toLowerCase()) {
    return stop(needsReview(`The package on qpm names another repository, ${listed}.`));
  }

  const earned = await submissions.findOne({
    _id: { $ne: row._id },
    eventKey: row.eventKey,
    status: "approved",
    $or: [{ packageName: row.packageName }, { repoKey: repoKey.toLowerCase() }],
  });
  if (earned) return stop(needsReview("This package or repository has already earned."));

  return stop({ state: "passed", reason: "" });
};

const recordHeartbeat = async (collection, fields) => {
  try {
    await collection.updateOne(
      { _id: HEARTBEAT_ID },
      { $set: { ...fields, updatedAt: new Date() } },
      { upsert: true },
    );
  } catch (err) {
    console.warn(`[events] could not record the heartbeat: ${err.message}`);
  }
};

/**
 * Check every pending submission that is due, up to MAX_PER_PASS.
 * @returns {{ ran: boolean, checked: number, approved: number, reason?: string }}
 */
const runEventCheck = async ({ quantumConn, rankingConn }) => {
  const submissions = rankingConn.collection("eventSubmissions");
  const heartbeat = rankingConn.collection("eventWorkerStatus");
  const now = new Date();

  const due = await submissions
    .find({
      status: "pending",
      // An SE who reopened a row has taken it over (routes/events.js).
      autoReview: { $ne: false },
      $or: [
        { "repoCheck.retryAt": { $exists: false } },
        { "repoCheck.retryAt": { $lte: now } },
      ],
    })
    .sort({ lastSubmittedAt: 1 })
    .limit(MAX_PER_PASS)
    .toArray();

  let approved = 0;
  try {
    for (const row of due) {
      const verdict = await inspectSubmission(row, { quantumConn, submissions });
      const checkedAt = new Date();
      const passed = verdict.state === "passed";
      const repoCheck = {
        ...verdict,
        checkedAt,
        ...(passed
          ? {}
          : {
              retryAt: new Date(
                checkedAt.getTime() +
                  (verdict.state === "unavailable" ? RETRY_UNAVAILABLE_MS : RECHECK_FAILED_MS),
              ),
            }),
      };

      // Still pending and still ours: an SE may have decided it during the clone.
      const result = await submissions.updateOne(
        { _id: row._id, status: "pending", autoReview: { $ne: false } },
        {
          $set: passed
            ? {
                repoCheck,
                status: "approved",
                reviewNote: "",
                reviewedAt: checkedAt,
                reviewedByUserId: REVIEWER_ID,
                updatedAt: checkedAt,
              }
            : { repoCheck, updatedAt: checkedAt },
        },
      );
      if (passed && result.modifiedCount) {
        approved += 1;
        console.log(`[events] approved ${row.packageName} (${row.repoOwner}/${row.repoName})`);
      }
    }
  } catch (err) {
    if (!(err instanceof GitMissingError)) throw err;
    await recordHeartbeat(heartbeat, { lastError: err.message, lastErrorAt: new Date() });
    return { ran: false, reason: err.message, checked: 0, approved: 0 };
  }

  await recordHeartbeat(heartbeat, {
    lastRunAt: new Date(),
    lastError: "",
    checked: due.length,
    approved,
  });
  return { ran: true, checked: due.length, approved };
};

module.exports = {
  runEventCheck,
  listRepoFiles,
  parseTree,
  judgeTree,
  canonicalRepo,
  REVIEWER_ID,
};
