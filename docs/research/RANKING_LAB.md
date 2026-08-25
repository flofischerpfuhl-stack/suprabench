# Ranking lab

The ranking lab takes one sanitized production snapshot, then evaluates scoring,
rating, family-taxonomy, confidence, and coverage alternatives entirely offline.
It does not write to Convex.

## Capture once

```powershell
npm run ranking:lab -- snapshot --deployment upbeat-clam-790
```

The snapshot command performs two bulk reads: one for models plus benchmarks and
one for scores. It strips submitter identity, records a SHA-256 digest, and writes
`.ranking-lab/snapshot.json`. The directory is ignored by Git.

## Analyze repeatedly

```powershell
npm run ranking:lab -- analyze
```

This command does not contact the database. It reads the snapshot and
`scripts/ranking-lab-scenarios.json`, writes machine-readable results to
`.ranking-lab/analysis.json`, and writes a compact report to
`.ranking-lab/analysis.md`.

The supplied scenarios vary structural decisions rather than fitting arbitrary
constants to a desired leaderboard:

- raw scores versus within-benchmark percentile or robust-z calibration;
- current benchmark ratings versus neutral or Bayesian-shrunk ratings;
- confidence folded into the score versus reported separately;
- median-per-benchmark family synthesis versus one concrete representative;
- database family tags versus a conservative inferred taxonomy;
- an optional minimum-evidence gate that marks sparse entries provisional;
- the existing square-root benchmark-coverage reliability applied to evidence
  only or to both evidence and ability weight;
- representative-only confidence versus family-wide distinct-benchmark
  confidence without mixing configuration performance;
- leave-one-benchmark-out stability for every named scenario.

The grid search is diagnostic. A scenario matching a preferred ordering is not,
by itself, evidence that the method is valid. Production changes should be based
on comparability, resistance to sparse evidence, provider-neutral taxonomy, and
held-out validation.

The current scale-comparability experiment and its recommendation are recorded
in [`BENCHMARK_SCALE_CALIBRATION_EXPERIMENT.md`](BENCHMARK_SCALE_CALIBRATION_EXPERIMENT.md).
It isolates the evidence gate, coverage reliability, empirical percentile, and
robust-z alternatives before combining any of them. The follow-up also audits
direct representative overlap and treats capability and evidence as separate
axes when the matrix cannot identify a total order.

## Family identity policy

A ranking family should represent a provider's generation and product tier.
Reasoning effort, harness, and execution settings remain concrete configurations
inside that family. Therefore GPT-5.6 Sol, Terra, and Luna are separate families,
while GPT-5.5 low/high/xhigh remain configurations of GPT-5.5. Versioned product
tiers such as Muse Spark 1.1 and 1.2 are also separate families.

The inferred-family audit is deliberately a review aid, not an automatic data
migration. Ambiguous names must be confirmed before changing stored family tags.

## Production family representative

Production now selects one concrete family member rather than computing a
median-per-benchmark synthetic family. The preferred member must cover at least
three distinct benchmarks; if none does, the best available member is retained
and marked provisional. The representative name and slug are exposed in the
family leaderboard.

Bayesian rating-prior results are recorded in
`docs/research/BAYESIAN_RATING_PRIOR_EXPERIMENT.md`. The category-mass design is
kept separate in `docs/research/CATEGORY_WEIGHTING_CONCEPT.md` because it remains
a user-control and governance concept, not production math.
