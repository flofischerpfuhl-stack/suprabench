# SupraBench scores worker (Cloudflare D1)

Off-loads the `modelScores` table from Convex to Cloudflare D1.
Convex still hosts everything else; this worker only stores the
write-once-read-many score rows that drive the ranking recompute,
so the recompute (which reads every score) no longer counts
against the Convex bandwidth quota.

```
┌──────────┐   POST /scores          ┌─────────────────────────┐
│ Convex   │  ─────────────────────▶ │ suprabench-scores worker│
│ actions  │   GET  /scores/all      │   (Workers + D1)        │
└──────────┘  ◀───────────────────── └─────────────────────────┘
```

## Architecture

* **Primary store**: still Convex (`modelScores` table). We
  write to Convex first inside the user-facing mutation so
  the response is strongly consistent.
* **Mirror**: a Convex internal action (scheduled `runAfter`
  the mutation commits) POSTs the new row to this worker.
* **Read replica**: the ranking-recompute action fetches the
  whole score set from this worker via `GET /scores`, computes
  rankings in memory, and writes them back to Convex via an
  internal mutation.

The Convex copy stays as a rollback safety net during
phase-1 of the migration. Once we've verified D1 is the source
of truth, we'll cut over the remaining read paths and drop the
Convex table.

## Routes

| Method | Path                       | Body / params                  | Notes                       |
|--------|----------------------------|--------------------------------|-----------------------------|
| GET    | `/health`                  | —                              | No auth, returns `{ok:true}`|
| GET    | `/scores`                  | —                              | Entire table (rebuild path) |
| GET    | `/scores/by-model/:id`     | —                              | One model's scores          |
| GET    | `/scores/by-bench/:id`     | —                              | One bench's scores          |
| POST   | `/scores`                  | `{ convex_id, modelId, ... }`  | Upsert single row           |
| POST   | `/scores/bulk`             | `{ scores: [ ... ] }`          | Atomic batch upsert         |
| DELETE | `/scores/:convex_id`       | —                              | Delete by Convex id         |

All routes except `/health` require `Authorization: Bearer <SCORES_SECRET>`.

## Cost

* **Free tier limits**: 100k req/day (Workers), 5M reads/day,
  100k writes/day, 5 GB storage (D1).
* **Egress**: free, no per-byte meter.
* **Headroom**: at 100k modelScore rows × 0.4 KB ≈ 40 MB
  storage (0.8% of the 5 GB free quota).

## Deploy

```bash
cd infra/scores-worker

# 1. apply schema to remote D1 (idempotent, IF NOT EXISTS).
npx wrangler d1 execute suprabench-scores --remote --file=schema.sql

# 2. set the shared bearer secret (Convex will hold the same
#    value in WORKER_SECRET env var).
npx wrangler secret put SCORES_SECRET

# 3. deploy worker.
npx wrangler deploy
```

After deploy, smoke test:

```bash
curl -sS https://suprabench-scores.<your-account>.workers.dev/health
# → {"ok":true}
```

## Rotating the secret

```bash
npx wrangler secret put SCORES_SECRET    # paste new value
npx convex env set WORKER_SECRET <same>  # update Convex side
```

Both sides must hold the same string; mismatched secrets cause
401 on every mirror call.
