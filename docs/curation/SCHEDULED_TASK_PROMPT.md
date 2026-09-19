# Scheduled task: maintain SupraBench

Run in an isolated worktree of the SupraBench repository every two days at
06:00 Europe/Berlin. Do not depend on context from an earlier chat.

## Objective

Keep production data current and **dense at the frontier**: every current
frontier model should have its configurations measured on every tracked
benchmark the publisher has run them on. The ranking is only as good as that
block of the matrix. Publish a dated evidence report, apply the reviewed
batches, verify the D1 mirror and the live site, record learnings.

Terms: a **model** is a release (`familyTag`, e.g. `GPT-6 Astra`); a
**configuration** is one effort/context setting of it (a row in `models`, e.g.
`GPT-6 Astra (xhigh)`). The manifest's `models` array creates configurations.

## Workflow

1. **Start clean.** Latest `origin/main` in a clean worktree; read
   `docs/curation/README.md` and the latest manifest's `learnings`. `npm ci` if
   needed. Verify read access to `upbeat-clam-790` and run
   `scoresWorker:verifyMirror`; stop on access failure or unexplained drift.
   Never reset, force-push or include unrelated work.
2. **Read complete tables.** For every tracked benchmark, get the publisher's
   full result table, not the default view: look for a JSON/CSV artifact, an
   embedded payload, and "all models" / "all effort levels" toggles. Known:
   Artificial Analysis → run `node scripts/curation-aa-backfill.mjs <date>`
   (reads the `self.__next_f` payload, holds the name alias map — extend it);
   DeepSWE → `/artifacts/v1.1/leaderboard-live.json`. Sweep provider release
   channels for new models; third-party roundups are leads, not evidence.
3. **Coverage matrix.** Frontier set = the 15 newest flagship models plus any
   release of the last 90 days. Report a model × benchmark matrix (present /
   published but missing / not published) and, per source, the number of
   published cells still missing after this run. "Nothing missing" may only be
   claimed for a source whose complete table was diffed.
4. **Write order.** (a) missing cells for configurations that already exist,
   frontier first — every such source row, not only the "Best" row per model;
   (b) `replace` where the source value differs from production, including
   production values that were rounded; (c) new models, all their published
   cells at once; (d) long tail. Batches hold 150 scores; continue with
   `YYYY-MM-DD-b`, `-c` … in the same run instead of dropping verified rows.
5. **Identity.** Name configurations `<Model> (<effort>)`, effort lower case.
   "adaptive", "with fallback", "default fallback" are aliases of an existing
   configuration, not new ones. All results of one source configuration go to
   one production configuration. Never create an unlabelled configuration when
   the source states an effort. Create an additional effort configuration only
   if it is published on at least four tracked benchmarks, then import all of
   them. Never insert a second row for the same configuration and benchmark;
   when the publisher later lists a row first taken from a vendor post, migrate
   it with `replace`. A vendor post is evidence only for that vendor's own
   model. Provider aliases: SpaceXAI = xAI, Z AI = Zhipu AI, Kimi = Moonshot AI.
   After every run list under **Identity cleanup needed** each older row that
   now duplicates a labelled row (same model, benchmark and value under an
   unlabelled or differently named configuration). Do not merge or delete
   production rows yourself.
6. **Harness and limits — one task suite is one benchmark.**
   - If the publisher runs all models under one uniform harness, import only
     that harness (ARC-AGI-3: Standard, not Provider Adapter).
   - If there is no uniform harness and the publisher ranks model + harness
     rows in one table (Agents' Last Exam, Terminal-Bench), that table is the
     benchmark: import each configuration's best row across harnesses and name
     the harness in the report. Never restrict a benchmark to one vendor's
     harness and never split a suite into per-harness benchmarks — that either
     excludes vendors or multiplies the suite's weight.
   - If the publisher changed resource limits, use the current default regime
     (SWE-Bench Pro: uncapped cost, 250 turns). Keep existing rows of a retired
     regime, add no new ones, and `replace` them when a current-regime row
     appears.
   - A publisher's own variant of a benchmark (e.g. a text-only subset) must be
     named as such in benchmark name and URL.
7. **Evidence and precision.** Open each accepted source in the visible browser
   and screenshot benchmark name, version and the table or chart the rows come
   from; the screenshot need not show every row. Store the most precise value
   the source publishes and note where it was read. Spot-check five values per
   source against the visible page.
8. **Admission and retirement.** Admit a benchmark that is relevant,
   discriminating at the frontier, documented, and scored by its publisher for
   at least 20 current models. Private held-out sets are acceptable when the
   method is public; price them in with reproducibility ≤ 3. Justify each
   rating dimension in one line and explain any gap of two or more points to a
   sibling benchmark; never upvote. Elo is stored raw on 500–2500,
   AA-Omniscience raw on −100…100. Mark a benchmark **stale** when its source
   added no model released in the last 60 days (currently Terminal-Bench Hard,
   APEX-Agents-AA, Tau2-Bench Telecom); spend nothing on it and name the
   successor. A deferral states what unblocks it and may recur once; then apply
   the rules above or list it under **Decision needed**.
9. **Publish.** Write `public/reports/curation/<runId>/index.html`,
   `manifest.json`, `screenshots/` (schema 1) with: coverage matrix, sources,
   accepted changes, scale conversions, deferrals, identity cleanup, decisions
   needed, validation, learnings. A no-change run still publishes. Then per
   batch:

   ```powershell
   npm run curation:validate -- public/reports/curation/<runId>
   npm test
   git diff --check
   npm run curation:dry-run -- public/reports/curation/<runId> --deployment upbeat-clam-790
   ```

   Review the full plan; every write must be explained in the report. Apply
   once with `SUPRABENCH_ALLOW_APPLY=1` set for that command only, require D1
   drift 0, and require a repeated dry run to show all rows unchanged.
10. **Ship and verify.** Re-run tests and the credential scan, commit only this
    run's artifacts, fast-forward push to `main`, wait for the deployment, and
    check the report, the affected pages and the top ten of the Model
    leaderboard in the visible browser; say whether the order changed and why.
11. **Summary.** Report URL, commit, inserted/replaced/deferred counts, frontier
    coverage before → after, missing cells per source, mirror drift, tests,
    decisions needed. `learnings` holds only what changes the next run.

## Safety

- Never commit tokens, `.env*`, login data, deployment keys or worker secrets.
- Never use a screenshot that does not show the claimed benchmark and table.
- Never merge distinct benchmark versions (Terminal-Bench 2.1 ≠ Hard ≠ 4.0).
- Never force-push, delete production data or silently overwrite a score.
- Failed access check, ambiguous evidence, failed test, non-zero drift or a
  rejected push is a stop condition: report it, no workaround.

```text
RRULE:FREQ=DAILY;INTERVAL=2;BYHOUR=6;BYMINUTE=0
```
