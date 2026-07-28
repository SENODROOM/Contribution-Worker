# Quantum Contribution Worker

Standalone worker that snapshots every member's GitHub activity into the
`ranking.githubContributionStats` collection **before GitHub's public events
API expires it** (~90 days / max 300 events per user). Without this ledger,
commit/PR quantum points silently decay over time.

**This worker is no longer the only writer.** The backend runs the same
algorithm in `backend/utils/githubSweep.js` — a lazy per-user refresh when a
dashboard/profile is loaded, plus a daily `GET /api/cron/github-sweep` that
works through the stalest members. That exists because a worker on a machine
that stops is silent: every tile freezes at the last sweep and anyone who links
GitHub afterwards reads 0 indefinitely.

Running this worker as well is still useful (it sweeps everyone on a fixed
cadence without touching request latency). Both writers use idempotent upserts
keyed on `{username, date}` and stamp `lastSweepAt` on each member's meta doc,
which the other throttles against, so they can run side by side. **Any change
to the sweep algorithm must be made in both places.**

## What a sweep does

1. Collects GitHub usernames from `quantum_logics.users`,
   `quantum_logics.employees`, and `ranking.teamState`
   (captains + members).
2. For each username (sequentially, 2.5 s apart — the search API allows 30/min):
   - PR search API → per-day `pullRequests`, exact, full year
   - public events API → per-day `commits` (and PRs only as a fallback: the
     event stream has one entry per PR *action*, so counting them all inflates
     the total)
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
npm start              # sweep now, then every SWEEP_INTERVAL_HOURS
npm run sweep          # one-off sweep, then exit (for external cron)
```

## Deploy

Any small always-on Node 18+ host works (Railway, Render, a VPS, the same
box as the Discord bot). **Not Vercel** — it needs a long-running process.
On a VPS use the pm2 setup above; on Railway/Render just set the start
command to `npm start` (their platform already supervises the process).

Set `GITHUB_TOKEN` (classic PAT, no scopes needed for public data) to get
the 5000 req/h rate limit; unauthenticated is 60 req/h, which is only
enough for ~15 users per sweep (4 requests per user).
