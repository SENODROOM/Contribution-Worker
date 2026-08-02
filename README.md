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

**Any change to a sweep algorithm must be made in both places.**

## Three passes

| Pass | Every | Covers |
| --- | --- | --- |
| recent (`RECENT_INTERVAL_MINUTES`, default 2) | ~12s, ~10 GraphQL requests | last 3 days, so a push reaches the portal within minutes |
| full (`SWEEP_INTERVAL_HOURS`, default 24) | ~30 min | the whole year — exact PR history, calendar, repair |
| polycode (`POLYCODE_INTERVAL_MINUTES`, default 15) | ~5s, one request per linked member (~12) | the whole year of XP, plus the chart's overview/streak snapshot |

The recent pass is affordable because GraphQL aliases carry ~35 members per
request for a single rate-limit point (5000/hour available).

The PolyCode pass is slower than `recent` on purpose: each response already
carries a full year, and the upstream is someone else's deployment, so there is
nothing to gain from hammering it.

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

`5 XP = 1 quantum point`, floored **per day** — matching
`backend/utils/polycodeProgress.js polycodeXpToPoints`. Summing XP across days
before flooring would inflate totals.

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
| `RECENT_INTERVAL_MINUTES` / `SWEEP_INTERVAL_HOURS` / `POLYCODE_INTERVAL_MINUTES` | no | pass cadences (2 / 24 / 15) |

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
npm start              # all three passes on their intervals
npm run recent         # one recent pass, then exit (fast — good for verifying)
npm run polycode       # one PolyCode pass, then exit (~5s)
npm run sweep          # one-off full sweep (+ PolyCode), then exit (for external cron)
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
