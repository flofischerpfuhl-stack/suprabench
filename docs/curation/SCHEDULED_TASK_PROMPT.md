# Scheduled task: maintain SupraBench

Run this task in an isolated worktree of the SupraBench repository every two
days at 06:00 Europe/Berlin. Do not depend on context from an earlier chat.

## Objective

Keep the production SupraBench model and benchmark data current. Update
existing benchmarks when newly released models have trustworthy published
scores, discover genuinely relevant new benchmarks, publish a dated evidence
report, apply the reviewed batch to Convex, verify the Cloudflare D1 mirror and
the public website, then preserve concrete learnings for the next run.

## Required workflow

1. Start from the latest `origin/main` in a clean isolated worktree. Read
   `docs/curation/README.md`, the most recent dated manifest/report, and its
   `learnings`. Run `git ls-remote origin HEAD` as an independent access check.
   Do not reset, overwrite, or include unrelated work. If the remote changes
   during the run, never force-push; stop safely or rebuild the run on the new
   head.
2. Run `npm ci` when dependencies are absent. Verify access to production
   deployment `upbeat-clam-790` with a read-only query and run
   `scoresWorker:verifyMirror`. Do not continue to writes if access fails or D1
   already has unexplained drift.
3. Inventory current production models, benchmarks, score scales, source URLs,
   and coverage gaps. For **every tracked benchmark**, inspect the current top
   rows in its official source and diff those model names against the complete
   production model inventory. This top-row diff is mandatory even when the
   previous run found no changes. Never infer a benchmark version from a
   similar name.
4. Independently sweep recent releases from all major model providers, then
   research new results for existing benchmarks and popular new benchmarks.
   Do not let the first release or leaderboard encountered define the search
   space. Prefer original publisher pages, official leaderboards, papers,
   repositories, and benchmark documentation. Treat third-party roundups as
   discovery leads, not final score evidence.
5. Open every source used for an accepted score or benchmark in the visible
   in-app browser. Visually locate the exact model name, benchmark version,
   evaluation mode, numeric value, scale, and source URL. Capture one or more
   viewport screenshots that actually show the relevant rows/columns. If a
   wide table needs left and right views, store both. A DOM/text extraction may
   help interpret a page but never replaces the screenshot check.
6. Accept a new benchmark only when it is meaningfully relevant, sufficiently
   adopted or authoritative, difficult/discriminating, reasonably resistant to
   contamination, and reproducible from public documentation or tooling.
   Document candidates that are promising but not ready. Do not write any
   ambiguous, contradictory, inaccessible, or version-mismatched item.
   Record protocol dimensions (including benchmark version, tool mode,
   reasoning effort, and harness) for every candidate. Never mix incompatible
   protocols in the same leaderboard; create a clearly separate benchmark or
   defer the result instead.
7. Create `public/reports/curation/YYYY-MM-DD/index.html`, `manifest.json`, and
   `screenshots/` using schema version 1. The HTML report must list all sources,
   exact accepted changes, stored scale conversions, deferrals and reasons,
   screenshots, validation results, post-publish checks, and specific learnings
   for the next run. A no-change run still gets a report and manifest.
8. Run:

   ```powershell
   npm run curation:validate -- public/reports/curation/YYYY-MM-DD
   npm test
   git diff --check
   npm run curation:dry-run -- public/reports/curation/YYYY-MM-DD --deployment upbeat-clam-790
   ```

   Review the complete dry-run plan. Existing curated values may change only
   through an explicit `replace` operation with newer evidence. Never apply a
   batch containing a write that is not explained in the dated report.
9. If every gate is clean, set `SUPRABENCH_ALLOW_APPLY=1` only for the single
   apply command, remove it immediately afterward, then require Convex/D1 drift
   to be zero. Run the same dry-run again and require all batch rows to be
   unchanged.
10. Re-run tests and credential-pattern checks. Commit only the curation code
    or dated artifacts created by this run. Push by fast-forward to `main`, wait
    for Cloudflare Pages, and verify the public report plus every affected model
    and benchmark page in the visible browser. Capture the live verification.
11. Finish with a concise run summary containing the report URL, commit ID,
    created/replaced/deferred counts, mirror counts/drift, test result, public
    page checks, and anything the next scheduled run should do differently.

## Safety rules

- Never commit tokens, `.env*`, copied login data, deployment keys, or worker
  secrets.
- Never use a source screenshot that does not visibly contain the claimed
  evidence.
- Never collapse distinct versions such as Terminal-Bench 2.1 and
  Terminal-Bench Hard into one record.
- Never force-push, delete production data, or silently overwrite a curated
  score.
- A failed access check, ambiguous evidence, failed test, non-zero D1 drift, or
  rejected fast-forward push is a stop condition; report it without a
  workaround.

Suggested recurrence:

```text
RRULE:FREQ=DAILY;INTERVAL=2;BYHOUR=6;BYMINUTE=0
```
