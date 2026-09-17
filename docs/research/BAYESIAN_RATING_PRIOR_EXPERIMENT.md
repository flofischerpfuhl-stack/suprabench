# Bayesian benchmark-rating prior experiment

Status: original raw-score test superseded. Since 2026-09-17 the three-rater
prior applies to the single pairwise fit that ranks both configurations and
families.

Snapshot: `2026-08-25T15:56:04.732Z`, SHA-256
`821103117329dc002039ee9c2db0b016bd0a89502a6678e4acb6b121b33ceb7c`.

All 20 production benchmarks in the snapshot had one quality rater and one net
upvote. The experiment therefore tests the most prior-sensitive possible state.

## Method

Each observed 1-5 rating dimension was combined with a neutral value of 3:

```text
shrunk = (observed * raterCount + 3 * priorRaters)
         / (raterCount + priorRaters)
```

Prior strengths 1, 3, 5, and 10 were compared against current ratings. All
other choices stayed fixed: raw benchmark percentages, current trust and
confidence math, corrected family taxonomy, and the best concrete family
representative with a three-benchmark preference.

## Results

| Neutral prior raters | Desired-order pair agreement | Desired top-7 recall | Mean absolute family-rank move | Largest rank move | Largest score move |
|---:|---:|---:|---:|---:|---:|
| 1 | 76.2% | 57.1% | 1.80 | 46 | 11.72 |
| 3 | 76.2% | 42.9% | 2.31 | 44 | 10.29 |
| 5 | 71.4% | 42.9% | 2.60 | 42 | 9.70 |
| 10 | 71.4% | 42.9% | 2.91 | 40 | 9.10 |

The one-rater prior changes some tail families dramatically and does not
consistently improve the target top seven. A prior of 1 is the least disruptive
tested choice and slightly improves pair agreement, but that is not sufficient
validation: every benchmark currently has the same tiny rater count, there is
no held-out period, and choosing the prior from the desired ranking would be
target fitting.

## Decision

This raw-score experiment did not justify a production change. The later
opponent-adjusted experiment supplied the missing held-out test: complete
benchmarks were removed and predicted from the remainder. In that family model,
a prior of 3 performed at least as well as 1, 10, or 30 on quality-weighted
held-out order and is enabled for family weights. Concrete-model SupraScore V1
still uses its existing production rating path. See
[`OPPONENT_ADJUSTED_FAMILY_RANKING.md`](OPPONENT_ADJUSTED_FAMILY_RANKING.md).
