# Benchmark-scale calibration experiment

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

## Decision

The clean production candidate is **empirical percentile + the existing
confidence calculation + a three-benchmark numbered-rank gate**.

- Percentile calibration directly fixes the invalid cross-benchmark unit
  assumption and gives the conservative 81.2 value, rather than a near-ceiling
  robust-z value, for Sol's second place on the eight-model ARC-AGI-3 table.
- The evidence gate fixes a separate presentation problem and prevents one- or
  two-benchmark families from being presented as equally triangulated.
- Applying coverage reliability to ability weight is statistically coherent,
  but adds only 0.1 percentage point of pairwise LOBO stability after percentile
  calibration. Keep it as a shadow metric initially instead of bundling it into
  the first production change.
- Do not adopt robust z-score yet. MAD is unstable on small, highly skewed
  leaderboards and its output is harder for users to interpret.
- Do not change DeepSWE's rating to repair a model rank.

Before production activation, freeze the percentile rule as a versioned score
method, show both raw result and calibrated contribution on benchmark detail
pages, and run a public shadow leaderboard. No production score change was made
by this experiment.
