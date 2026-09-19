# SupraBench curation runs

The recurring curation job researches new model results and potentially useful
benchmarks, verifies every accepted result against a visible source page, and
publishes an evidence-backed HTML report with the corresponding database batch.

## Run artifact

Each run is committed below `public/reports/curation/YYYY-MM-DD/`. A run that
needs more than one batch (150 score rows, 5 new benchmarks, 30 new models per
batch) adds `YYYY-MM-DD-b/`, `-c/`, … — every batch is a complete artifact with
its own report, manifest, screenshots, dry run and apply:

- `index.html` is the human-readable transparency report.
- `manifest.json` is the machine-readable batch and source record.
- `screenshots/` contains the visible-page evidence used for every accepted
  score and every proposed benchmark.

The manifest uses `schemaVersion: 1` and contains `runId`, `generatedAt`,
`reportPath`, `sources`, `evidence`, `models`, `benches`, `scores`, and
`learnings`. A no-change run still publishes a report and manifest; its four
write arrays are empty and it explains what was checked.

## Generators

Two scripts write ready-to-validate batches from publishers that expose their
complete result table; neither writes to the database:

- `node scripts/curation-aa-backfill.mjs <date> [letter]` — Artificial Analysis
  (embedded page payload; holds the publisher-name → configuration alias map).
- `node scripts/curation-source-sync.mjs <date> [letter]` — DeepSWE and Agents'
  Last Exam (JSON tables; inserts missing cells of existing configurations and
  replaces rounded values with exact ones).

Rows that ended up under the wrong configuration (unlabelled copies, alias
configurations, a vendor row next to the publisher's row) are fixed with
`migrations:applyIdentityCleanup` — explicit plan, dry run first, guarded so a
model never loses its only row on a benchmark. Verify every move at the source
and commit the returned archive under `docs/curation/cleanup/`.

Renaming a benchmark is an explicit migration:
`npx convex run --prod migrations:renameBench '{"slug":…,"newName":…}'`.

## Safety gates

From the repository root:

```powershell
npm run curation:validate -- public/reports/curation/YYYY-MM-DD
npm run curation:dry-run -- public/reports/curation/YYYY-MM-DD --deployment upbeat-clam-790
$env:SUPRABENCH_ALLOW_APPLY='1'
npm run curation:apply -- public/reports/curation/YYYY-MM-DD --deployment upbeat-clam-790
Remove-Item Env:SUPRABENCH_ALLOW_APPLY
npx convex run --deployment upbeat-clam-790 scoresWorker:verifyMirror '{}'
```

Validation fails closed when a source lacks screenshot evidence, an image is
missing or invalid, a report path escapes its dated directory, or an artifact
looks like it contains a credential. The Convex mutation then revalidates the
same invariants against live database state. It is internal-only, idempotent,
limits batch sizes, and requires an explicit newer `replace` operation before a
curated score value can change. Successful writes use the existing internal
worker to mirror changed rows into D1.

Only run `apply` after reviewing the dry-run result. The environment flag is an
intentional second gate, not a stored credential. Never commit `.env*`, Convex
deployment keys, Cloudflare secrets, or copied login tokens.

## Scheduled-run order

1. Require a clean `main` checkout and fetch the latest remote state.
2. Read the latest report's `learnings` before research.
3. Query the production API/Convex data to identify coverage gaps.
4. Research official or original benchmark sources and model leaderboards.
5. Open every accepted source as a visible web page and capture the displayed
   model name, benchmark version, score, scale, and source URL in a screenshot.
6. Write the dated HTML report, screenshots, and manifest.
7. Validate locally, run the Convex dry run, and review its exact write plan.
8. Apply once, then require D1 drift to be zero.
9. Commit and push the report/code to `main`, wait for Cloudflare Pages, and
   verify the public report plus affected model/benchmark pages visually.
10. Record concrete source quirks, naming aliases, benchmark-version pitfalls,
    and better discovery queries in `learnings` for the next run.

If any evidence is ambiguous, contradictory, inaccessible, or not tied to a
specific benchmark version, document it in the report and make no database
write for that item.
