# Quantum Contribution Worker

Standalone worker that snapshots every member's GitHub activity into the
`ranking.githubContributionStats` collection **before GitHub's public events
API expires it** (~90 days / max 300 events per user). Without this ledger,
commit/PR quantum points silently decay over time.

The backend (Vercel) never writes this collection — it only reads it and
merges it with live GitHub data in `GET /api/github/contributions/:username`.

## What a sweep does

1. Collects GitHub usernames from `quantum_logics.users`,
   `quantum_logics.employees`, and `ranking.teamState`
   (captains + members).
2. For each username (sequentially, 1.5 s apart):
   - public events API → per-day `commits` / `pullRequests`
   - jogruber contribution calendar → per-day `calendarCount`
3. Upserts one document per `(username, date)` using `$max`, so stored
   values **never decrease** when events expire upstream.

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
