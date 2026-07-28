# Quantum Contribution Worker

Standalone worker that snapshots every member's GitHub activity into the
`ranking.githubContributionStats` collection **before GitHub's public events
API expires it** (~90 days / max 300 events per user). Without this ledger,
commit/PR quantum points silently decay over time.

**This worker owns every recurring GitHub call for the portal.** The backend
is on Vercel — billed per invocation, and able to freeze post-response work —
so it makes no GitHub requests at all; it reads this ledger and serves it.

**If this process stops, every commit/PR number in the portal freezes at that
moment, and nobody is told.** That happened between 2026-06-09 and 2026-06-28
and went unnoticed for 19 days. Two guards now exist, but neither replaces
watching the process:

- each pass stamps a heartbeat on the ledger's `__worker__` meta doc, and
  `GET /api/stats/live` reports it as `github: { updatedAt, stale }`
- `backend/utils/githubSweep.js` mirrors this algorithm for manual failover
  (`/api/cron/github-recent`, `/api/cron/github-sweep`, and
  `backend/scripts/sweepGithubLedger.js`) — nothing schedules it

**Any change to the sweep algorithm must be made in both places.**

## Two passes

| Pass | Every | Covers |
| --- | --- | --- |
| recent (`RECENT_INTERVAL_MINUTES`, default 2) | ~12s, ~10 GraphQL requests | last 3 days, so a push reaches the portal within minutes |
| full (`SWEEP_INTERVAL_HOURS`, default 24) | ~30 min | the whole year — exact PR history, calendar, repair |

The recent pass is affordable because GraphQL aliases carry ~35 members per
request for a single rate-limit point (5000/hour available).

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

## Run

```bash
npm install
cp .env.example .env   # fill in the URIs
```

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
npm start              # both passes on their intervals
npm run recent         # one recent pass, then exit (fast — good for verifying)
npm run sweep          # one-off sweep, then exit (for external cron)
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
