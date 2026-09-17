# Opponent-adjusted family ranking

Status: superseded on 2026-09-17. The Bradley-Terry fit, the three-rater prior
and the 0.15 regularization selected here are still production math, but the fit
now runs on concrete configurations and a family shows its best configuration
instead of a per-benchmark ceiling. See
[`RANKING_REALITY_AUDIT_2026-09-16.md`](RANKING_REALITY_AUDIT_2026-09-16.md).

Snapshot: `2026-08-25T15:56:04.732Z`, SHA-256
`821103117329dc002039ee9c2db0b016bd0a89502a6678e4acb6b121b33ceb7c`.

## Failure in the percentile experiment

An empirical percentile makes benchmark scales comparable, but not participant
fields. First place against fifteen weak participants and first place against
fifteen frontier participants both become the same percentile. Averaging those
percentiles therefore made Gemini 3.5 Flash (high) rank first from three
selective results even though the full model/benchmark graph contained enough
overlap to compare opponent strength.

The graph is connected: all 150 visible concrete configurations in the snapshot
are linked through shared benchmark opponents. The fix can therefore use the
existing sparse data; it does not require a complete rectangular matrix.

## Production method

The model leaderboard remains configuration-specific. The family leaderboard
answers a different, explicit question: how strong is the best observed
configuration available from each product family?

1. Keep every source score and configuration unchanged.
2. Within one concrete configuration and benchmark, take the median of valid
   source rows.
3. Within one family and benchmark, keep the highest concrete-configuration
   median. This is the family ceiling for that benchmark.
4. Convert every benchmark field into pairwise wins, losses, and half-win ties.
5. Give each model the same total comparison mass per benchmark by dividing the
   benchmark weight by `participants - 1`.
6. Fit one global regularized Bradley-Terry model. Shared opponents connect
   different benchmark fields and calibrate strength of schedule.
7. Display `100 * logistic(family ability)` as the family SupraScore.
8. Mark a family provisional when it has fewer than three distinct benchmarks.

Benchmark weight remains community controlled. The four trust dimensions and
difficulty rating are shrunk toward neutral `3/5` with a three-rater prior,
then multiplied by headroom and relative benchmark upvotes. This stops one
rater from being treated as settled community consensus while retaining the
existing quality, difficulty, headroom, and trust semantics.

Regularization is `0.15`. The production solver uses 40 damped diagonal-Newton
iterations; on the frozen snapshot its top 20 positions exactly match a
3,000-iteration Adam reference and mean absolute ability error is below
`0.000001`.

## Model search, not target-order search

The preferred model order was never the optimization metric. Candidates were
compared by removing an entire benchmark, fitting on the other nineteen, and
predicting the held-out pairwise order. Accuracy is averaged by benchmark and a
second metric weights held-out benchmarks by the same Bayesian quality model.

| Method | Mean held-out accuracy | Quality-weighted accuracy | Mean log loss | Decision |
|---|---:|---:|---:|---|
| Percentile, concrete configurations | 72.07% | 75.78% | n/a | field strength ignored |
| Bradley-Terry, concrete configurations | 72.77% | 76.45% | 0.5439 | better, but selective configurations remain |
| Category-balanced Bradley-Terry | 72.34% | 76.02% | 0.5494 | rejected; current one-benchmark categories dominate |
| Pairwise PageRank | 68.91% | 72.19% | 0.6179 | rejected |
| Family median + Bradley-Terry | 74.12% | 78.11% | 0.5217 | robust, but provider variant counts affect the median |
| **Family ceiling + Bradley-Terry** | **74.87%** | **79.01%** | **0.5184** | **selected** |

Against the strongest concrete-configuration Bradley-Terry baseline, the family
ceiling gains `+2.56` quality-weighted percentage points. A deterministic paired
20-benchmark bootstrap with 20,000 resamples gives a 95% interval of `+0.40` to
`+4.78` points and a `99.10%` positive-gain rate. Family ceiling is `+0.90`
points above family median; that smaller contrast has an interval of `-0.05` to
`+2.25` and is not independently significant. Ceiling is retained because it
answers the stated product-family question without making the number of
provider-published configurations part of the score; median does not.

A multidimensional Bradley-Terry/IRT model was also tested by masking individual
model-benchmark cells. Two latent dimensions predicted missing cells better
than zero dimensions, but its global ability factor was unstable across
regularization choices and failed the external order check. It remains research
code, not production ranking math.

## Snapshot result and uncertainty

The selected family calculation produced:

| Rank | Family | Family SupraScore | Family benches |
|---:|---|---:|---:|
| 1 | Claude Opus 5 | 97.34 | 5 |
| 2 | GPT-5.6 Sol | 97.11 | 9 |
| 3 | Claude Fable 5 | 94.88 | 6 |
| 4 | GPT-5.6 Terra | 91.54 | 8 |
| 5 | Kimi K3 | 90.79 | 8 |
| 8 | Grok 4.6 | 85.14 | 2 |
| 9 | Claude Mythos 5 | 84.30 | 1 |
| 10 | Gemini 3.5 Flash | 84.19 | 4 |
| 11 | Muse Spark 1.2 | 83.53 | 3 |
| 13 | GLM-5.3 | 81.01 | 2 |

Two hundred benchmark bootstraps put Sol's median rank at 2 with a 5-95% range
of 1-3 and Fable's at 3 with a range of 1-5. Gemini's median is 10 with a much
wider range of 2-44. Mythos has only one benchmark and a 4-47 range; the current
data do not verify a Mythos-first claim. This is surfaced as uncertainty instead
of being overridden to match a preferred order.

As an external, non-fitting check, the selected order gets 13 of 15 pairwise
relations correct among the six current Artificial Analysis reference families
available during the experiment: Opus 5, Fable 5, Sol, Kimi K3, Muse Spark 1.2,
and Gemini 3.5 Flash. The two disagreements are Sol/Fable and Gemini/Muse.

## Reproducibility

```powershell
npm run ranking:pairwise -- --mode search
npm run ranking:pairwise -- --mode verify --outcome binary --weights bayesian `
  --prior-raters 3 --regularization 0.15 --family-aggregate max `
  --bootstrap-samples 200 --validation-bootstrap-samples 20000
npm test
```

The offline snapshot command still performs the database reads only once. All
search, cross-validation, missing-cell, bootstrap, and solver-parity work runs
against that immutable local snapshot.
