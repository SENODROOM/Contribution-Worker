# Quantum Contribution Worker

Standalone worker that snapshots every member's GitHub activity into the
`ranking.githubContributionStats` collection **before GitHub's public events
API expires it** (~90 days / max 300 events per user), and their PolyCode XP
into `ranking.polycodeStats`. Without these ledgers, commit/PR quantum points
silently decay over time and PolyCode points cannot be scored on public pages
at all.

**This worker owns every recurring GitHub and PolyCode call for the portal.**
The backend is on Vercel — billed per invocation, and able to freeze
post-response work — so it makes no requests to either at all; it reads these
ledgers and serves them. For PolyCode there is a second reason: it is a
third-party app (Team Mercury's), and the pages needing its numbers (`/explore`,
public profiles) are unauthenticated, so fetching on a request path would let
anonymous traffic drive requests at someone else's deployment.

**If this process stops, every commit/PR and XP number in the portal freezes at
that moment, and nobody is told.** That happened between 2026-06-09 and
2026-06-28 and went unnoticed for 19 days. Two guards now exist, but neither
replaces watching the process:

- each pass stamps a heartbeat on its ledger's `__worker__` meta doc, and
  `GET /api/stats/live` reports the GitHub one as `github: { updatedAt, stale }`
- `backend/utils/githubSweep.js` and `backend/utils/polycodeSweep.js` mirror
  these algorithms for manual failover (`/api/cron/github-recent`,
  `/api/cron/github-sweep`, `/api/cron/polycode`, and
  `backend/scripts/sweepGithubLedger.js`) — nothing schedules them
- the daily achiever decision (below) backfills any window it missed, so an
  outage delays awards rather than losing them

**Any change to a sweep algorithm must be made in both places.**

## Four passes

| Pass | Every | Covers |
| --- | --- | --- |
| recent (`RECENT_INTERVAL_MINUTES`, default 2) | ~12s, ~10 GraphQL requests | last 3 days, so a push reaches the portal within minutes |
| full (`SWEEP_INTERVAL_HOURS`, default 24) | ~30 min | the whole year — exact PR history, calendar, repair |
| polycode (`POLYCODE_INTERVAL_MINUTES`, default 15) | ~5s, one request per linked member (~12) | the whole year of XP, plus the chart's overview/streak snapshot |
| dls (`DLS_INTERVAL_MINUTES`, default 5) | one request per 50 members | the whole year of Digital Logics Studio XP — optional, off until `DLS_SYNC_SECRET` is set |

The recent pass is affordable because GraphQL aliases carry ~35 members per
request for a single rate-limit point (5000/hour available).

The PolyCode pass is slower than `recent` on purpose: each response already
carries a full year, and the upstream is someone else's deployment, so there is
nothing to gain from hammering it.

## Plus one daily decision

Once per Pakistan-time day, just after the cutover
(`ACHIEVERS_FINALIZE_HOUR_PKT`, default `0` — midnight, when the day closes and
every score resets), the finished day's winners are frozen into
`ranking.achievers`. First place earns a **Daily Achiever** award on their
profile; the Monday run does the same for the finished week (**Weekly
Achiever**). Winning again raises the ×N multiplier rather than adding a badge.

Freezing is the point: the GitHub full pass keeps repairing old days, so a
podium recomputed next week can quietly crown someone else. Once decided, a
window never changes.

`achievers.js` does not compute the podium — it triggers
`POST /api/cron/finalize-achievers`, which reuses the portal's own scorer. The
score is five sources deep and joins members across Discord IDs, GitHub handles
and PolyCode handles; a second copy of that here would drift, and the first
symptom would be a frozen award contradicting the board that announced it. So
this process owns *when*, the portal owns *what* — one authenticated request a
day, no third-party calls.

**This pass is optional.** Without `PORTAL_API_URL` and the secret it stands down
silently and the portal decides on its own next Explore rebuild instead, so
awards land whenever the first visitor arrives after midnight rather than exactly
at it. Configure it when you want the timing exact; nothing is lost either way,
since a decision is frozen once and never revisited.

The finalize is idempotent and reaches back over recent windows, so a worker that
was down for a week catches up on its next tick instead of losing those awards.
Checked every `ACHIEVERS_CHECK_MINUTES` (default 10) so a restart near midnight
still lands it.

## What a sweep does

1. Collects GitHub usernames from `quantum_logics.users`,
   `quantum_logics.employees`, and `ranking.teamState`
   (captains + members).
2. For each username (sequentially, 2.5 s apart — the search API allows 30/min):
   - GraphQL `commitContributionsByRepository`, in four ~91-day windows →
     per-day `commits`, exact, full year (needs `GITHUB_TOKEN`)
   - PR search API → per-day `pullRequests`, exact, full year
   - public events API → **fallback only** for both: its ~300-event cap covers
     a few percent of a prolific member's year, and it carries one entry per PR
     *action*, so counting them all inflates the total
   - jogruber contribution calendar → per-day `calendarCount`
3. Upserts one document per `(username, date)`. `commits` and `calendarCount`
   use `$max`, so they **never decrease** when events expire upstream.
   `pullRequests` is overwritten from the search history whenever that history
   came back complete — otherwise an over-count could never be corrected.

The first sweep doubles as the backfill: it stores a full year of
`calendarCount`, which the backend scores ×1 for days older than the events
window that have no commit/PR detail.

## What the PolyCode pass does

1. Collects distinct `polycoder` handles from `quantum_logics.users`.
2. `GET <POLYCODE_API_URL>/api/auth/polycoder/:handle/progress` per handle,
   400 ms apart. A 404 is normal attrition (deleted/renamed account) and leaves
   the stored rows alone, so historical points never vanish.
3. Upserts one document per `(polycoder, date)` with `$max` on `xp` — a
   truncated response must not lower a day already earned — plus a
   `date: "meta"` snapshot doc holding the chart's overview and streak fields.

Only the fields `PolyCodeChart` renders are stored. The upstream payload also
carries a member's id, real name, last login and course list; the endpoint that
replays this (`/api/polycode/progress/:polycoder`) is public, so the snapshot is
a whitelist rather than the raw objects.

`5 XP = 1 quantum point`, floored **per day** and capped at 100 a day (500 XP)
— scored by `backend/utils/polycodeProgress.js polycodeXpToPoints`, not here:
the ledger keeps a day's full XP, so the cap can change without a re-sweep.
Summing XP across days before converting would inflate totals.

## What the Digital Logics Studio pass does

Optional — it stands down until `DLS_SYNC_SECRET` is set.

1. Collects the email of every member the portal can vouch for
   (`isEmailVerified` or `isVerified`) from `quantum_logics.users`.
2. `POST <DLS_API_URL>/api/community/xp` in batches of 50 emails, with the
   shared secret as a bearer and `tzOffsetMinutes: 300`, so days come back cut
   on Pakistan time. Emails with no DLS account are simply absent from the
   response.
3. Upserts one document per `(userId, date)` into `ranking.dlsStats` with `$max`
   on `xp`, plus a `date: "meta"` doc per matched account. Rows are keyed on
   `users._id` — no email address is written to the ranking DB.

`5 XP = 1 quantum point`, floored per day and capped at 100 a day — scored by
`backend/utils/dlsPoints.js`, not here. A wrong or missing secret fails the
whole pass loudly and leaves the heartbeat's `lastRunAt` untouched, so a broken
pass never looks fresh; the reason is written beside it as `lastError` (also
when `DLS_SYNC_SECRET` is simply unset here) and cleared by the next clean pass.
`node backend/scripts/checkDlsLedger.js` (from the backend) prints that reason,
asks the DLS backend whether its half of the secret is set, and shows whether
rows are landing.

Switching it on takes both halves, and the second is the one that gets missed:

1. `DLS_SYNC_SECRET=<value>` in this folder's `.env` **on the host the worker
   runs on**, then restart the worker.
2. `COMMUNITY_SYNC_SECRET=<same value>` on the Vercel project behind
   `digital-logics-studio-backend.vercel.app` (Settings → Environment Variables,
   Production), then **redeploy** it — a variable added in Vercel only reaches
   deployments made afterwards. Until then the endpoint answers `503`.

## What the mailer does

Decides, queues and sends every email the portal owes a member, from
`admin@quantumlogicslimited.com`. **The backend neither sends nor queues any
member mail.** Every `MAILER_INTERVAL_MINUTES` (default 1) the worker first
works out what is owed (`mailProducers.js`), writes it to `ranking.emailOutbox`
already written, and `mailer.js` delivers what is due:

- `mailActivity.js` — reads new rows of `ranking.communityActivities`
  (promotions, removals, moves, bans, rejected appeals);
- `mailIdeas.js` — reads new `ranking.ideaComments` (a comment on your idea);
- `mailSweeps.js` — medal congratulations when a window is decided, and the
  weekly role alerts on the Monday after a week closes. These two ask the
  backend (`GET /api/cron/mail-facts/*`), so they need **`PORTAL_API_URL` and
  `CRON_SECRET`/`JWT_SECRET`** set, as the midnight finalize does.

Also needs `CLIENT_URL` (the deployed portal) for the buttons inside a mail.
`npm run mail:preview` renders every template to disk; `npm run mail:repair:dry`
shows what bringing failed mail back would do.

What is sent:

- **role alerts** — once a week, each Team Captain, Project Captain or Commander
  failing a rule that keeps their seat ("you uploaded 1 of the 3 required
  streams last week");
- **role and team changes** — promoted, deposed, replaced, moved, removed,
  banned, unbanned, retired, or an appeal rejected, as it happens;
- **medals** — "you won the Daily Achiever medal", for all six window medals,
  when the day or week is decided.

For each mail it claims the row, reads the member's current address from
`quantum_logics.users` (the outbox holds a user id, never an email), sends, and
records `sent`, `skipped` (expired, or no usable address) or `failed` with the
reason. A message the server refuses is retried with a growing delay for about
three hours; a failure to reach or sign in to the SMTP server stops the pass
without counting against any mail, and is logged once per half hour.

**After every `git pull` on the host, run `npm install` before restarting.**
This pass is the one that needs `nodemailer`; a folder that has the code but
not the package cannot send, and for two days that is exactly what production
was. The worker now checks for it up front, logs `[mailer] NOT SENDING — …` at
start and every half hour while it lasts, and records the reason in its
heartbeat row (`__worker__` in the outbox), which is the first line
`checkEmailOutbox.js` prints. A fault like that — or the SMTP server being
unreachable, or refusing the sign-in — costs no mail an attempt; only the
server refusing a particular message does.

Needs only the `SMTP_*` vars. Without them it stands down and the queue waits —
but a mail still unsent when it goes stale (a few days) is dropped rather than
delivered late. `node backend/scripts/checkEmailOutbox.js` (from the backend)
shows what is queued, sent and stuck.

## Run

```bash
npm install
cp .env.example .env   # fill in the URIs
```

`.env`:

| Var | Required | Notes |
| --- | --- | --- |
| `MONGO_URI_QUANTUM` | yes | member list (`users`, `employees`) |
| `MONGO_RANKING_URI` | yes | both ledgers are written here |
| `GITHUB_TOKEN` | yes | classic PAT — see the note under Deploy |
| `POLYCODE_API_URL` | no | PolyCode **backend**, defaults to `https://poly-code-backend.vercel.app`. `code.quantumlogicslimited.com` is the frontend and answers every path with HTML — the pass detects that and errors rather than storing junk. |
| `PORTAL_API_URL` | no | Origin of the portal **backend**, no trailing slash. Only needed to decide awards exactly at the cutover; unset, the portal decides them on its own rebuild. |
| `JWT_SECRET` | with the above | The same value the backend uses — its `/api/cron/*` routes accept it as the bearer. Set `CRON_SECRET` instead only if that deployment defines one; it wins over `JWT_SECRET` on both sides. |
| `DLS_SYNC_SECRET` | no | Turns the Digital Logics Studio pass on. Must equal `COMMUNITY_SYNC_SECRET` on the DLS **backend**. |
| `DLS_API_URL` | no | DLS **backend**, defaults to `https://digital-logics-studio-backend.vercel.app` |
| `RECENT_INTERVAL_MINUTES` / `SWEEP_INTERVAL_HOURS` / `POLYCODE_INTERVAL_MINUTES` / `DLS_INTERVAL_MINUTES` | no | pass cadences (2 / 24 / 15 / 5) |
| `ACHIEVERS_FINALIZE_HOUR_PKT` / `ACHIEVERS_CHECK_MINUTES` | no | when the day is decided, and how often that is checked (0 / 10) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | for email | The `admin@quantumlogicslimited.com` mailbox. Member emails are always sent *from* that address, so `SMTP_USER` must be it (or be allowed to send as it). Unset, no member is emailed. |
| `MAILER_INTERVAL_MINUTES` | no | how often the outbox is drained (1) |

### With pm2 (recommended)

```bash
npm run pm2:start      # start under pm2 (sweeps now, then every SWEEP_INTERVAL_HOURS)
npm run pm2:status     # is it running?
npm run pm2:logs       # tail sweep output (also in ./logs/)
npm run pm2:restart    # restart (re-runs a sweep immediately — safe, $max upserts)
npm run pm2:stop       # stop
```

pm2 is a local dependency, so no global install is needed. To survive
server reboots, run once on the host:

```bash
npx pm2 startup        # prints a command to enable pm2 on boot — run it
npx pm2 save           # remember the current process list
```

### Without pm2

```bash
npm start              # all three passes + the daily decision, on their intervals
npm run recent         # one recent pass, then exit (fast — good for verifying)
npm run polycode       # one PolyCode pass, then exit (~5s)
npm run dls            # one Digital Logics Studio pass, then exit
npm run achievers      # force the achiever decision now, then exit
npm run mailer         # send whatever is due in the email outbox, then exit
npm run sweep          # one-off full sweep (+ PolyCode + decision), then exit
```

## Deploy

Any small always-on Node 18+ host works (Railway, Render, a VPS, the same
box as the Discord bot). **Not Vercel** — it needs a long-running process.
On a VPS use the pm2 setup above; on Railway/Render just set the start
command to `npm start` (their platform already supervises the process).

`GITHUB_TOKEN` (classic PAT) is **required**, not an optimisation. Commits come
from GraphQL, which rejects unauthenticated requests outright, and the REST
limit without it is 60 req/h — about 15 members per sweep. A revoked token
fails exactly like a healthy one from the outside: the passes run, write
calendar-only rows, and report no error. If commit counts look impossibly low,
check the token first:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: bearer $GITHUB_TOKEN" \
  -d '{"query":"{viewer{login}}"}' https://api.github.com/graphql
```

401 means the token is dead. `npm run recent` also reports failed batches now.
