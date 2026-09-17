# Scheduled task: maintain SupraBench

Revised 2026-09-17. Background: `docs/research/RANKING_REALITY_AUDIT_2026-09-16.md`
§7.4 — the ranking only reflects reality when the newest frontier releases are
measured on the same hard, unsaturated benchmarks. Earlier runs imported "top
rows", scattered one release over several configuration names, kept feeding
benchmarks their publishers had stopped running, and deferred the benchmarks
the frontier is actually measured on.

Run this task in an isolated worktree of the SupraBench repository every two
days at 06:00 Europe/Berlin. Do not depend on context from an earlier chat.

## Objective

Keep the production SupraBench model and benchmark data current **and dense
where it matters**: every current frontier release should have one canonical
configuration with results on every tracked benchmark its publisher has run it
on. Update existing benchmarks, discover genuinely relevant new ones, publish a
dated evidence report, apply the reviewed batch(es) to Convex, verify the
Cloudflare D1 mirror and the public website, then preserve concrete learnings.

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
3. **Build the coverage matrix first.** Inventory production models,
   benchmarks, scales and source URLs. Determine the **frontier set**: the 15
   most recently released flagship families across providers (plus any release
   from the last 90 days). For every tracked benchmark, read the **complete**
   result table of its official source — not only the top rows. Where the page
   embeds its data (Artificial Analysis pages carry the full matrix in the
   `self.__next_f` payload: `initialModels` / `models` with one field per
   evaluation), extract it from there. Produce a `frontier × benchmark` matrix
   with three states per cell: in production / published but missing / not
   published. Put the matrix in the report.
4. **Spend the write budget in this order:**
   1. published-but-missing cells of the frontier set on tracked benchmarks;
   2. `replace` operations where the official source now shows a different
      value than production (grader or dataset revisions), for the frontier
      set first;
   3. newly released models (all of their published cells at once, not one);
   4. long-tail models.
   At least 70 % of inserted rows must belong to the frontier set unless no
   such cell is missing. If the 150-score batch cap is reached, create further
   batches in the same run (`YYYY-MM-DD-b`, `-c`, …; the pipeline accepts one
   lower-case letter as suffix), each with its own
   manifest, dry-run and apply. Never drop verified rows because of the cap.
5. **Canonical model identity.**
   - One configuration name per source row. Format `<Release> (<effort>)`,
     effort in lower case (`(max)`, `(xhigh)`, `(high)`, `(medium)`, `(low)`).
     Provider-side wording such as "adaptive", "default fallback", "with
     fallback" is an alias of the same configuration, not a new model — keep
     the name already in production.
   - Before creating a model, search its family for an existing configuration
     holding the same value on the same benchmark or carrying an alias name. If
     found, reuse it. Never create an unlabelled model (`GPT-5.6 Sol`) when the
     source row has an effort label.
   - All results of one source configuration go to the same production model,
     whichever benchmark page they come from. A release must not end up with
     its results scattered over configurations that each cover a few benchmarks.
   - Create a secondary effort configuration only when the source publishes it
     on at least four tracked benchmarks, and then import all of them.
   - Provider aliases: SpaceXAI = xAI, Z AI = Zhipu AI, Kimi = Moonshot AI.
   - List every existing duplicate/alias pair you find under "Identity cleanup
     needed" in the report; do not merge or delete production rows yourself.
6. Independently sweep recent releases from all major model providers, then
   research new results for existing benchmarks and popular new benchmarks. Do
   not let the first release or leaderboard encountered define the search
   space. Prefer original publisher pages, official leaderboards, papers,
   repositories and benchmark documentation. Treat third-party roundups as
   discovery leads, not final score evidence. A vendor launch post is
   acceptable evidence only for the vendor's own model and only when the
   benchmark's publisher lists no row for it; it is never evidence for a
   competitor's model. When the official publisher later lists the row, migrate
   the source with `replace` — never insert a second row for the same
   (model, benchmark).
7. Open every source used for an accepted score or benchmark in the visible
   in-app browser and capture viewport screenshots that show the benchmark
   name, version and the table the rows come from. The screenshot
   proves the page and table are what the manifest says; it does not have to
   show every imported row. Store the most precise value the source publishes
   (embedded JSON included) and record in the manifest where each value was
   read from. Spot-check at least five imported values per source against the
   visible table.
8. **Benchmark admission and retirement — apply one rule to all.**
   - Admit a benchmark when it is relevant, discriminating at the frontier,
     documented, and its publisher scores at least 20 current models. A private
     held-out test set is acceptable when the methodology is public (it was
     accepted for APEX-Agents-AA, AA-LCR and AutomationBench-AA); rate its
     reproducibility ≤ 3 instead of deferring it.
   - The ten components of the current Artificial Analysis Intelligence Index
     are the benchmarks on which every frontier release is measured. All ten are
     tracked since the 2026-09-17 backfill; keep them dense for every new
     release. Elo benchmarks are stored as raw Elo with `scaleMin 500`,
     `scaleMax 2500` (the publisher's own index normalisation);
     AA-Omniscience as the raw index with `scaleMin -100`, `scaleMax 100`.
   - Flag a tracked benchmark as **stale** when its source has added no model
     released in the last 60 days (currently Terminal-Bench Hard,
     APEX-Agents-AA, Tau2-Bench Telecom on Artificial Analysis). Stop spending
     budget on stale benchmarks and name the successor.
   - A deferral must state what would unblock it. The same item may be deferred
     at most twice; after that either admit it under the documented default or
     list it under "Decision needed from the maintainer".
   - Never mix incompatible protocols in one leaderboard. When a publisher runs
     its own variant (e.g. Artificial Analysis' text-only HLE subset) the
     benchmark name and URL must say so.
9. **Ratings.** When rating a new benchmark, justify each of the five
   dimensions in one line against the rubric in the About page and compare with
   sibling benchmarks already rated; a difference of two or more points to a
   sibling needs a stated reason. Do not upvote benchmarks.
10. Create `public/reports/curation/YYYY-MM-DD/index.html`, `manifest.json` and
    `screenshots/` using schema version 1. The report must contain the coverage
    matrix, all sources, exact accepted changes, stored scale conversions,
    deferrals with unblock conditions, identity cleanup list, screenshots,
    validation results, post-publish checks and learnings. A no-change run
    still gets a report and manifest.
11. Run:

    ```powershell
    npm run curation:validate -- public/reports/curation/YYYY-MM-DD
    npm test
    git diff --check
    npm run curation:dry-run -- public/reports/curation/YYYY-MM-DD --deployment upbeat-clam-790
    ```

    Review the complete dry-run plan. Existing curated values may change only
    through an explicit `replace` operation with newer evidence. Never apply a
    batch containing a write that is not explained in the dated report.
12. If every gate is clean, set `SUPRABENCH_ALLOW_APPLY=1` only for the single
    apply command, remove it immediately afterward, then require Convex/D1
    drift to be zero. Run the same dry-run again and require all batch rows to
    be unchanged. Repeat steps 11–12 per additional batch.
13. Re-run tests and credential-pattern checks. Commit only the curation code
    or dated artifacts created by this run. Push by fast-forward to `main`, wait
    for Cloudflare Pages, and verify the public report plus the affected model
    and benchmark pages in the visible browser. Also check the first
    ten rows of the Model-Family leaderboard and state in the summary whether
    the order changed and why.
14. Finish with a concise run summary: report URL, commit ID,
    created/replaced/deferred counts, **frontier coverage before → after
    (cells filled / cells published)**, mirror counts/drift, test result, public
    page checks, decisions needed from the maintainer. `learnings`
    contains only items that change what the next run does; gate confirmations
    ("example.com check passed") belong under validation.

## Reading Artificial Analysis

`node scripts/curation-aa-backfill.mjs <YYYY-MM-DD> [first-batch-letter]` reads
the publisher's embedded result matrix, diffs it against production and writes
ready-to-validate insert-only batches (manifest, report, screenshots). Use it
as the first step of every run. It contains the alias map between publisher
short names and production model names — extend that map instead of creating a
second model for the same configuration. Review its output like any other
batch before the dry run.

## Safety rules

- Never commit tokens, `.env*`, copied login data, deployment keys, or worker
  secrets.
- Never use a source screenshot that does not show the claimed benchmark and
  table.
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
