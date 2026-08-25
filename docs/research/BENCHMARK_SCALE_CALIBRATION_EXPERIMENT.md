# Benchmark-scale calibration experiment

> Superseded for the production family leaderboard by
> [`OPPONENT_ADJUSTED_FAMILY_RANKING.md`](OPPONENT_ADJUSTED_FAMILY_RANKING.md).
> Empirical percentiles fixed raw-score scale mismatch but ignored participant
> field strength, which allowed three selective Gemini results to rank first.

Snapshot: `2026-08-25T15:56:04.732Z`
SHA-256: `821103117329dc002039ee9c2db0b016bd0a89502a6678e4acb6b121b33ceb7c`

## Question

Production averages published 0-100 benchmark scores directly. That assumes a
point has the same capability meaning on every benchmark. ARC-AGI-3 disproves
that assumption in the current data: GPT-5.6 Sol is second of eight at 7.78,
but the raw aggregate treats 7.78 as a large absolute failure. A model without
an ARC-AGI-3 result avoids that negative contribution.

The experiment evaluates structural alternatives against the immutable
snapshot. The preferred family order is reported only as a diagnostic and is
not used to select a method or parameter.

## Parameter-free or already-established alternatives

1. **Evidence gate:** the existing three-benchmark family threshold also
   separates provisional families from the numbered evidence-backed ranking.
2. **Coverage reliability:** reuse the production evidence multiplier
   `sqrt(modelCount / maxModelCount)` for ability weight as well as evidence.
   This introduces no new exponent or threshold.
3. **Empirical percentile:** replace each raw score by its within-benchmark
   Hazen midrank percentile `(midrank - 0.5) / n`. This standard non-parametric
   plotting position is monotone, invariant to positive affine score-scale
   changes, never assigns 0 or 100 to a finite table, and requires no fitted
   constant.
4. **Robust z-score:** center each benchmark at its median, scale by MAD, and
   map through the normal CDF. This is also scale-invariant but can be too
   aggressive when a benchmark has few models and a very small MAD.

Every candidate keeps current community ratings, the current confidence rule,
one concrete family representative, and the existing three-benchmark
representative threshold unless the row explicitly isolates one factor.

## GPT-5.6 Sol evidence

| Benchmark | Raw score | Place | Models | Empirical percentile |
|---|---:|---:|---:|---:|
| ARC-AGI-2 | 92.50 | 1 | 42 | 98.8 |
| TextQuests | 51.50 | 1 | 40 | 98.8 |
| Terminal-Bench Hard | 65.90 | 1 | 15 | 96.7 |
| DeepSWE | 73.00 | 2 | 34 | 95.6 |
| EnigmaEval | 37.12 | 3 | 37 | 93.2 |
| SWE-Bench Pro | 64.60 | 4 | 45 | 92.2 |
| MMMU-Pro | 83.00 | 3 | 27 | 90.7 |
| ARC-AGI-3 | 7.78 | 2 | 8 | 81.2 |

Sol is in the top four on every benchmark for which that exact configuration
has a result. Its production weighted raw mean of 52.76 is therefore a scale
artifact, not an accurate summary of its observed relative performance.

## Results

The gate column means families below three distinct benchmarks are listed as
provisional rather than receiving a numbered main rank. Stability is the mean
pairwise ordering retained across 20 leave-one-benchmark-out runs.

| Scenario | Gate | Sol rank | Sol score | Mean absolute LOBO rank move | Pairwise stability | Sol rank range under LOBO |
|---|---:|---:|---:|---:|---:|---:|
| Production raw | no | 20 | 52.06 | 1.69 | 97.8% | 1-35 |
| Raw + gate | yes | 4 | 52.06 | 1.50 | 98.0% | 1-9 |
| Raw + coverage reliability | no | 4 | 56.36 | 1.59 | 97.9% | 1-14 |
| Raw + coverage reliability + gate | yes | 1 | 56.36 | 1.37 | 98.2% | 1-3 |
| Percentile | no | 1 | 81.36 | 1.48 | 98.0% | 1-1 |
| Percentile + gate | yes | 1 | 81.36 | 1.06 | 98.7% | 1-1 |
| Percentile + coverage reliability + gate | yes | 1 | 82.33 | 1.02 | 98.8% | 1-1 |
| Robust z-score + gate | yes | 1 | 82.11 | 1.00 | 98.7% | 1-2 |

DeepSWE is not under-rated: its community quality is 95/100, Sol is second of
34, and it contributes positively. Raising only its effective weight from 57.8
to 95 moves Sol merely from 52.06 to about 53.48 in the raw formula. The
failure is cross-benchmark scale comparability, dominated by ARC-AGI-3, not the
DeepSWE rating.

## Follow-up: capability and evidence must not be one hidden trade-off

The first percentile scenario still pushed Fable behind older, broader-tested
families because the production confidence multiplier changes the point
estimate itself. A follow-up therefore tested two parameter-free separations:

1. keep the representative's concrete performance but compute family
   confidence from the union of distinct benchmarks across that release's
   configurations; and
2. rank by calibrated observed capability while publishing confidence as a
   separate evidence axis.

Family-union confidence moves Fable from rank 6 to 5, but still rewards older
families with 16 covered benchmarks enough to keep GPT-5.4 and GPT-5.5 ahead.
Separating capability from evidence produces this evidence-backed main list:

| Rank | Family | Calibrated capability | Family confidence | Representative benches | Family benches |
|---:|---|---:|---:|---:|---:|
| 1 | Gemini 3.5 Flash | 93.06 | 0.49 | 3 | 4 |
| 2 | GPT-5.6 Sol | 92.01 | 0.72 | 8 | 9 |
| 3 | Claude Fable 5 | 88.14 | 0.67 | 4 | 6 |
| 4 | Kimi K3 | 81.84 | 0.71 | 8 | 8 |
| 5 | GPT-5.4 | 80.84 | 0.97 | 9 | 16 |
| 6 | GPT-5.5 | 79.70 | 1.00 | 10 | 16 |

Mythos leads the separate provisional frontier at 98.89 but has only one
benchmark. Presenting that signal is useful; presenting it as equally
triangulated with Sol or Fable is not.

The automatic adjacent-pair audit also shows that the preferred exact order is
not identifiable from the current matrix:

| Proposed comparison | Common representative benches | Direct result |
|---|---:|---|
| Mythos > Fable | 0 | no direct evidence |
| Fable > Sol | 1 | Sol wins Terminal-Bench Hard 65.9 to 62.9 |
| Sol > Kimi | 3 | Sol wins all 3 |
| Kimi > GLM-5.3 | 2 | 1-1 split |
| GLM-5.3 > Grok 4.6 | 1 | Grok wins |
| Grok 4.6 > Muse Spark 1.2 | 0 | no direct evidence |

Across all configurations, Fable and Sol overlap on four benchmarks; Sol wins
DeepSWE, Terminal-Bench Hard, and Terminal-Bench v2.1, while Fable wins
EnigmaEval. A formula that puts Fable above Sol from these rows alone would need
an additional task-category preference, an external prior, or a fitted weight.
It cannot be justified as a neutral consequence of the recorded measurements.

## Revised decision

Do **not** activate a percentile-derived single canonical score yet. The clean
shadow candidate is a two-axis view: **empirical percentile capability plus
separately displayed family evidence**, with provisional families shown as a
frontier-signal group rather than silently mixed into the evidence-backed rank.

- Percentile calibration directly fixes the invalid cross-benchmark unit
  assumption and gives the conservative 81.2 value, rather than a near-ceiling
  robust-z value, for Sol's second place on the eight-model ARC-AGI-3 table.
- The evidence gate remains useful as a presentation boundary, not as a claim
  that three benchmarks suddenly make uncertainty disappear.
- Applying coverage reliability to ability weight is statistically coherent,
  but adds only 0.1 percentage point of pairwise LOBO stability after percentile
  calibration. Keep it as a shadow metric initially instead of bundling it into
  the first production change.
- Do not adopt robust z-score yet. MAD is unstable on small, highly skewed
  leaderboards and its output is harder for users to interpret.
- Do not change DeepSWE's rating to repair a model rank.

Before production activation, add the missing cross-family benchmark results,
freeze the percentile rule as a versioned method, show raw result, calibrated
contribution, representative evidence, and family evidence separately, and run
a public shadow leaderboard. No production score change was made by this
experiment.
