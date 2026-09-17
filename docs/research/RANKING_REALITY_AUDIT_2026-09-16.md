# Ranking reality audit — 2026-09-16

Status: **deployed on 2026-09-17.** The unified pairwise method runs in
production, and the dense Artificial Analysis backfill of §7.4 was applied
through the normal curation gates (five batches `2026-09-17` … `-e`, 648 rows,
six admitted benchmarks, four new models, insert-only). An earlier version of
this audit recommended retracting six ARC-AGI-3 rows as a harness mix; that
premise was checked at the source and is wrong (see the correction in §3) — no
production data was removed. Sections 0–6 describe production before the
change.

Live family order after deploy + backfill: Claude Fable 5.1 61.6 › GPT-6 Astra
57.0 › Claude Opus 5 46.2 › Muse Spark 1.3 41.3 › GPT-5.6 Sol 39.8 › Claude
Fable 5 38.3 › Grok 4.6 › Kimi K3 › GLM-5.3.

Snapshot: `2026-09-16T21:23:33.638Z`, SHA-256
`86ec9379e37f4d816fed45d54a4ddeb412d42783fa358dff0c7e0ad54ee5a807`
(177 visible models, 22 benches, 704 scores).

## 0. Question

Production shows GPT-6 Astra (xhigh) first on the model table and Claude Opus 5
first on the family table, with Claude Fable 5.1 sixth. The maintainer's
expectation, and the current external consensus (Artificial Analysis v4.3:
Fable 5.1 = Astra 53 > Opus 5 51 > Fable 5 50 > Muse Spark 1.3 48 > Sol 47;
Epoch ECI: Astra #1), is Fable 5.1 ≈ Astra > Sol > (Chinese labs / Grok /
Muse). Is the SupraScore math wrong, or the data?

Short answer: **both, but the data problem is larger than the formula
problem**, and the two production formulas disagree with each other and with
the raw head-to-head record for structural reasons that no reweighting fixes.

## 1. What the raw data actually say

Family-ceiling head-to-head record on shared benchmarks (row beats column,
W-L-T):

| | Fable 5.1 | Opus 5 | Fable 5 | Astra | Sol | Terra | DS V4.1 Flash | Muse 1.3 | Grok 4.6 | Kimi K3 | GLM-5.3 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Fable 5.1** | — | 3-0 | 3-0 | 4-1 | 4-1 | 4-1 | 1-1 | 4-0 | 4-1 | 5-0 | 3-1 |
| **Astra** | 1-4 | 4-1-1 | 2-2 | — | 6-2 | 6-1 | 1-2 | 2-2 | 5-0-1 | 6-2 | 4-1 |
| **Opus 5** | 0-3 | — | 2-2 | 1-4-1 | 4-3 | 6-0 | 1-0 | 2-1 | 3-1 | 5-1 | 3-1 |
| **Sol** | 1-4 | 3-4 | 3-4 | 2-6 | — | 12-1 | 1-1-1 | 3-1 | 5-1 | 7-1 | 3-2 |

The pairwise record supports exactly the expected order: **Fable 5.1 > Astra >
Opus 5 ≈ Sol > the rest.** Fable 5.1 loses only AutomationBench-AA (59.4 vs
Astra 68.5). Production ranks Fable 5.1 sixth (family) and eighth (model).

Why the record is thin: Fable 5.1 has 5 benchmark cells, Mythos 5 has 1,
Opus 5 has 7, Astra 8, Sol 15. The three highest-weighted benches
(ARC-AGI-3, Agents' Last Exam, APEX-Agents-AA) contain no Fable 5.1, no
Astra, and no Mythos result at all.

## 2. Why the model table puts Astra (xhigh) first and Mythos second

Model SupraScore = 50 + √(E/E*) · (μ − 50). E* is set by the most-covered
model (Gemini 3.1 Pro Preview, 18 benches). Every frontier model has 5–8
benches, so confidence is 0.3–0.6 and every score is squeezed toward 50:

| Model | ability mean μ | confidence | SupraScore | benches |
|---|---:|---:|---:|---:|
| GPT-6 Astra (xhigh) | 68.4 | 0.58 | 60.7 | 5 |
| Claude Mythos 5 | 80.3 | 0.33 | 60.0 | 1 |
| Claude Opus 5 (Max) | 64.2 | 0.62 | 58.9 | 5 |
| Claude Fable 5.1 (max) | 63.8 | 0.58 | 58.1 | 5 |
| GPT-5.6 Sol (max) | 61.7 | 0.67 | 57.8 | 8 |

Three defects, all visible in this table:

1. **The ability mean averages raw percentages across benches with incompatible
   scales.** Astra's mean is high because it sits on ARC-AGI-2 (95) and
   MMMU-Pro (87), both near-saturated (headroom 0.33 / 0.30) and therefore
   low-weight, but still 90+ points; Fable 5.1's mean is dragged by HLE (59)
   and SciCode (63), benches where 59 and 63 are the best results in the
   world. Ranked by ability mean alone, the top five are single-bench
   Tau2-Telecom entries at 97–99. This is the scale artifact already
   documented in `BENCHMARK_SCALE_CALIBRATION_EXPERIMENT.md`; it was fixed
   for families but never for the model table.
2. **A one-bench model can rank second.** Mythos 5 at 80.3 on SWE-Bench Pro
   (15 points above #2) is worth 60.0 after shrinkage — still ahead of every
   5-bench frontier configuration. Shrinkage toward 50 is too weak for
   n = 1 and too strong for n = 5.
3. **The displayed number is uninterpretable.** 60.7 is neither a win rate nor
   a percentage; it is mostly a coverage measure. The leaderboard is
   effectively ordered by coverage × (μ − 50).

## 3. Why the family table puts Opus 5 first and Fable 5.1 sixth

The family table uses a different formula (family ceiling + Bradley-Terry with
L2 regularization 0.15, displayed as 100·logistic(ability)). Three separate
effects:

1. **ARC-AGI-3 alone decides first place.** It is the highest-weighted bench
   (Q 95, difficulty 5, headroom 1.0 because the frontier mean is 5%) and the
   only bench with 2 net upvotes while every other bench has 1. Because the
   trust factor is linear u/U* with U* = 2, that single extra upvote doubles
   its weight: 3.31× the mean bench weight. Opus 5 (High) scores 30.2 there
   against Sol 7.8, Opus 4.8 1.5, everything else < 1. Drop ARC-AGI-3 and the
   family order becomes Sol, Fable 5, Astra, DS V4.1 Flash, Opus 5, Fable 5.1.
   Neutralize the upvote factor and Sol is first.
2. **Correction (2026-09-17): the ARC-AGI-3 rows are comparable.** An earlier
   version of this audit claimed the six rows sourced from OpenAI's GPT-5.6
   launch post were a different harness from the two ARC-Prize-verified rows.
   ARC Prize's own results page lists GPT-5.6 Sol 7.78 %, Terra 0.80 % and
   Luna 0.18 % as *ARC Prize Verified* on the semi-private set — the same
   numbers. Opus 5 (High) at 30.2 % is verified too. The gap is real evidence,
   not a data artifact. (The Opus 4.8, GPT-5.5 and Gemini 3.1 rows could not
   be checked against ARC Prize directly.) What remains true is the weight:
   one extra upvote makes this eight-model bench count 3.3× the average.
3. **L2 regularization rewards coverage.** With λ = 0.15 the fitted ability of
   an (almost) undefeated family grows roughly with log(comparison mass / λ).
   Fable 5.1 has comparison mass 4.4 (five benches, two of them saturated and
   worth 0.30 and 0.38), Opus 5 has 8.1 (3.3 of it ARC-AGI-3), Sol has 16.
   So Fable 5.1 can beat Opus 5 3-0 and Sol 4-1 head-to-head and still rank
   below both. Standard errors from the Fisher information are ±1.0 on
   abilities that differ by 0.8 — the top six are statistically
   indistinguishable, which the 90.9–95.9 display hides.
4. **100·logistic(ability) compresses the top into 90–96.** The number reads
   like a percentage but is "probability of beating the average family",
   which is ~0.95 for every frontier family.

## 4. Why the two tables disagree

They use different math on the same data. Model: raw-percentage weighted mean
with evidence shrinkage. Family: pairwise wins with L2 shrinkage. Astra is
first under the first because it happens to be on two near-saturated benches
where it scores 87–95 raw; Opus 5 is first under the second because it wins
the one bench that carries a third of the total weight. There is no bug; the
two formulas measure different things.

## 5. Method comparison on the frozen snapshot

Every family-level candidate was evaluated on (a) agreement with the
head-to-head majority over all 1,621 family pairs sharing ≥ 2 benches,
(b) held-out benchmark prediction (drop one bench, refit, predict pairwise
order on the dropped bench; weighted by bench weight), (c) leave-one-bench-out
rank stability of the top 20, and (d) — as a diagnostic only — agreement with
the expected order {Fable 5.1 > Astra > Sol > tier-2}.

| Method | h2h agreement | held-out acc | LOBO stability | expected-order | Fable 5.1 | Astra | Sol | Opus 5 | Mythos |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Production family BT** (λ .15, binary) | 94.0% | 75.95% | 97.0% | 78% | 6 | 4 | 2 | 1 | 16 |
| BT λ .02 binary | 94.9% | 74.81% | 96.9% | 67% | 7 | 4 | 5 | 1 | 8 |
| BT λ .15 margin-of-victory | 93.6% | 74.03% | 96.5% | 78% | 6 | 3 | 2 | 1 | 11 |
| BT, upvote factor neutralized | 94.2% | 75.85% | 97.0% | 78% | 6 | 4 | 1 | 2 | 14 |
| Additive two-way, logit scale | 93.4% | 75.84% | 97.8% | 83% | 10 | 8 | 7 | 1 | 3 |
| Additive two-way, z-scale | 94.6% | 75.07% | 97.6% | 72% | 5 | 4 | 8 | 1 | 3 |
| Additive two-way, raw scale | 94.0% | 75.33% | 96.6% | 94% | 4 | 3 | 6 | 2 | 1 |
| IRT (per-bench slope), logit | 94.4% | 77.32% | 97.7% | 94% | 8 | 7 | 10 | 6 | 9 |
| Frontier-relative raw, shrink | 91.4% | 74.44% | 98.1% | 83% | 6 | 5 | 3 | 1 | 2 |
| Frontier-relative z, shrink | 91.2% | 74.58% | 96.2% | 100% | 3 | 10 | 11 | 2 | 1 |

Readings:

- **No formula is a clear winner on predictive accuracy.** All candidates sit
  in 74–77% held-out accuracy; the differences are inside the bootstrap noise
  reported in `OPPONENT_ADJUSTED_FAMILY_RANKING.md` (±2 pp). The production
  BT is at the top of that band and has the best head-to-head agreement.
- **Every formula that reproduces the expected order does so by accident.**
  The additive-raw and frontier-relative-z variants put Fable 5.1 in the top
  four, but they also put Mythos (1 bench) first and lift single-bench
  Tau2-Telecom entries (JT-35B, GLM-4.7 Flash) into the top ten, because a
  per-model weighted mean cancels the bench weight when a model has one
  bench. Logit-scale variants amplify Astra's 95 on ARC-AGI-2 (β = −1.22, a
  weak field) into a 4-logit residual. Selecting one of these because it
  matches a preferred order would be target fitting.
- **Bench-bootstrap (300 resamples, additive-logit):** Opus 5 P(rank 1) = 60%,
  Mythos 23%, Astra 4%, Fable 5.1 1%. The 5–95% rank range of Fable 5.1 is
  3–14, of Astra 2–11, of Sol 2–12. The matrix cannot identify a top-3 order.
- **Unified BT on concrete configurations** (same math as families) gives:
  Opus 5 (High) 2.98 ± 1.23, Sol 2.68 ± 0.97, Astra (xhigh) 2.43 ± 1.24,
  Fable 5.1 (xhigh) 2.43 ± 1.42, Fable 5 2.16 ± 1.19. Family rank and
  best-member rank then agree within one position for every frontier family
  (Astra family #4 / best config #3; Fable 5.1 #6 / #4; Opus 5 #1 / #1).
  Leave-one-bench-out rank of Opus 5 (High) spans 1–29: its first place is one
  bench.

## 6. What Artificial Analysis did, and why it matters here

AA moved from an equal-weighted mean (v1–v3) to category weights (v4.0, Jan
2026), then within one week in September 2026 shipped v4.2 and v4.3 after
GPT-6 Astra scored 61 under v4.1 (tied with Sol, behind Fable 5.1 at 66) while
Epoch ECI and ARC-AGI-3 showed a clear Astra lead. AA's CEO: *"Fable 5.1 and
GPT-6 Astra demonstrated capabilities that we believed Index v4.1 wasn't
adequately capturing, in part because earlier models had already saturated
several of the benchmarks used in Index v4.1."* Their fix was not a new
formula: they **swapped saturated benches for harder private ones**
(TB 2.1 → TB 4.0, τ³-Banking → AutomationBench-AA, added AA-Briefcase and
GDP.pdf, dropped GPQA) and raised the private-test-set share to 45%. AA still
lists every reasoning-effort configuration as its own row, does not collapse
to a family ceiling, and normalizes Elo benches as clamp((Elo − 500)/2000).

Epoch's ECI is the closest published analogue to what SupraBench needs: a
joint IRT fit σ(α_b (C_m − D_b)) over a sparse 59 × 266 matrix, ridge
regularized, best-of-settings per model, a minimum of 4 benchmark results
before a model is scored, and bootstrap CIs shown next to every score. The
IRT-slope row above is that model on our data; it is the best held-out
predictor here (77.3%) but unstable at the top for the same one-bench reason.

The lesson that transfers: **the frontier is decided by whichever hard,
unsaturated benches the frontier models have actually been run on.**
SupraBench's frontier rows are missing on exactly those benches.

## 7. Recommendations, in order of leverage

### 7.1 Data (largest effect, no formula risk)

1. **ARC-AGI-3: nothing to clean.** Withdrawn — the rows are verified and
   comparable (see the correction in section 3). Whether one upvote should
   be able to double a bench's weight is a governance question, not a data
   fix.
2. **Admit the benches AA now uses for the frontier.** GDPval-AA v2 (Fable 5.1
   1764, Opus 5 1735, Muse 1.3 1703, Astra 1580), Terminal-Bench 4.0 (Astra
   59.6, Fable 5.1 55.1), AA-Briefcase, GDP.pdf, CritPt, AA-Omniscience. The
   curation log has deferred all of them for "private-data reproducibility,
   redundancy, grading, identity, or weighting" reasons. Private test sets are
   exactly what the community quality rating (contamination, reproducibility
   dimensions) exists to price in; deferring them removes the only benches on
   which Fable 5.1, Astra, Opus 5 and Mythos have all been measured.
   Elo benches need a declared scale (AA uses 500–2500).
3. **Fill the frontier × top-weight cells first.** Priority list of missing
   cells, all publicly available: Fable 5.1 and Astra on Terminal-Bench Hard,
   APEX-Agents-AA, SWE-Bench Pro, DeepSWE (Fable 5.1), EnigmaEval, TextQuests;
   Mythos 5 on anything besides SWE-Bench Pro; Opus 5 on SWE-Bench Pro and
   Terminal-Bench Hard. Every such cell adds a direct comparison; the
   bootstrap shows that ~5 more cells for Fable 5.1 would move its 5–95%
   range from 3–14 to roughly 1–5.
4. **Retire or split near-duplicates.** Terminal-Bench Hard and Terminal-Bench
   v2.1 (AA Terminus 2) are the same task family; SWE-bench Verified,
   SWE-Bench Pro and DeepSWE are three coding benches. This is the category
   weighting concern in `CATEGORY_WEIGHTING_CONCEPT.md`; coding currently
   holds 5 of 22 benches and ~28% of total weight.

### 7.2 Formula — what the tables would actually look like

Scenario grid computed with `scripts/ranking-deepdive/scenarios.mjs` and
`rank-bestconfig.mjs` (data: current / ARC-AGI-3 cleaned; formula: production /
unified Bradley-Terry on configurations with family = best configuration under
the same fit; display = win rate against the current top-10 field).

**With the real, unmodified data** the unified method (unified BT, family =
best configuration with the 50 % rule, win rate vs the top-10 field) gives:

| # | Model table | score | | Family table | score |
|---:|---|---:|---:|---|---:|
| 1 | Claude Opus 5 (High) | 67.8 | 1 | Claude Opus 5 | 67.8 |
| 2 | GPT-5.6 Sol | 61.3 | 2 | GPT-5.6 Sol | 61.3 |
| 3 | GPT-6 Astra (xhigh) | 55.6 | 3 | GPT-6 Astra | 55.6 |
| 4 | Claude Fable 5.1 (xhigh) | 55.5 | 4 | Claude Fable 5.1 | 55.5 |
| 5 | Claude Fable 5 (adaptive max) | 49.0 | 5 | Claude Fable 5 | 49.0 |
| 6 | GPT-5.6 Sol (xhigh) | 43.8 | 6 | DeepSeek V4.1 Flash | 40.1 |
| 7 | GPT-6 Astra (max) | 43.2 | 7 | Gemini 3.5 Flash | 38.6 |
| 8 | Claude Fable 5.1 (high) | 42.8 | 8 | GPT-5.6 Terra | 36.4 |

Opus 5 (High) leads on three benches, one of which is ARC-AGI-3; its
leave-one-bench-out rank range is 1–29. The table that an earlier version of
this audit presented (Fable 5.1 60.8, Astra 60.5, Sol 57.7) required deleting
the ARC-AGI-3 rows and is **not** a legitimate result.

What the same grid rules out:

- **Family ceiling (current production semantics) under unified BT:** Sol,
  Fable 5, Astra, DS V4.1 Flash, Opus 5, Fable 5.1. The ceiling adds the max
  configuration's AutomationBench loss to the family, and the family row then
  ranks below its own best configuration. Family = best configuration is what
  AA does and is the only variant where both tables agree.
- **Softening the upvote factor to (u+1)/(U*+1):** changes nothing once
  ARC-AGI-3 is cleaned (it was the only bench with two votes). Withdrawn.
- **Adding GDPval-AA v2 and AA-Briefcase now:** Fable 5.1 first, Opus 5 second,
  Muse Spark 1.3 third, Astra ninth or tenth. Those are the two AA benches
  Anthropic and Meta dominate; Astra leads the four AA benches we could not
  fetch in full (Terminal-Bench 4.0, CritPt, GDP.pdf, Omniscience). Admitting
  two of six would be selection, not evidence. Admit all six or none; the full
  tables need an AA data-API key.
- **Standard-error columns / provisional block:** withdrawn as UI clutter. The
  BT regularization already keeps one-bench rows (Mythos 5) out of the top 25
  without any UI change.

### 7.2b Does the proposed math keep every original motivation?

Motivations were collected from the formula's git history (`ebb386e` headroom,
`53e80a7` top-K frontier mean, `1c32e3e` sparse-coverage loophole, `ec78daa`
vanity-bench guards + attack catalog, `4fef84b` ability/evidence split,
`a4396bf` opponent adjustment) and the About page. Each was rebuilt as a
scenario on the cleaned snapshot (`attacks.mjs`, `attack-report.mjs`) and run
under the current production math (OLD) and the proposed unified BT (NEW).

| Motivation (origin) | Scenario | OLD | NEW |
|---|---|---|---|
| Saturated benches must stop counting (`ebb386e`) | attacker scores 100 on the three most saturated benches | model #8 | model #17 |
| … while hard benches still count | same three wins on HLE, SciCode, APEX | #1 | #1 |
| Automatic hand-off when a bench saturates | ARC-AGI-2 top-15 moved to 97–99 | weight → floor, order stable | weight → floor, order stable |
| One bench can't carry a model (`1c32e3e`) | new model, only HLE = 100 | **model #1 (70.7)** | model #14 |
| Self-rated vanity bench, own model only (`ec78daa` A2) | Q 100 bench, one model | model #11 | model #93 |
| Vanity bench + low scores submitted for rivals, real benches endorsed (6 votes) | | #25 | #22 |
| Same, but nobody has upvoted real benches (U* = 1, today's production state) | | **#1 (62.5)** | **#1 (76.5)** |
| Eight-bench vanity farm with rival smearing (A3-extreme) | | **#1 (63.6)** | **#1 (83.7)** |
| One outlier submission can't anchor a cell (median) | 5 submitted next to 58.7, 58.7 | unchanged | unchanged |
| Monotone in own scores | Fable 5.1 (max) AutomationBench 59 → 70 | #8 → #6 | #8 → #1 |
| Untested ≠ bad; specialist bench not buried (`4fef84b`) | — | shrink to 50 | no comparison, no effect |
| Flooding a bench with junk rows | 200 junk models on HLE | top-5 reshuffles | **top-3 reorders (Sol, Astra, Fable 5.1)** |
| Splitting results into a flattering configuration | Kimi K3 config listing only its two best benches | model #83, family #12 | **model #5, family #5** |
| Zero tuning hyperparameters (`1c32e3e`) | — | true for models | false: λ 0.15, 3-rater prior, top-10 display field |
| Hand-computable worked example (About) | — | yes | no |

Reading: NEW is strictly stronger on saturation, single-bench peaks and solo
vanity benches — the production model table currently fails its own
"one bench can't carry a model" test (the June midpoint-50 change lets a lone
100 on HLE reach 70.7). Rival-smearing vanity benches beat both formulas
whenever real benches have no vote lead; that is a participation problem, not
a formula property, and NEW punishes it harder in score terms. Two real
regressions: junk flooding and cherry-picked configurations.

Mitigations tested (`variants.mjs`, `validate-variants.mjs`, `repr-rule.mjs`):

- **Representative-coverage rule** — a configuration may represent its family
  only if it covers ≥ 50% of the family's total bench weight. Blocks the cherry
  configuration on the family table (Kimi K3 back to #13), no change to the
  baseline table (Fable 5.1 (xhigh) covers 68%). The per-configuration table
  still lists the cherry row; that is inherent to listing configurations.
- **Nearest-10-neighbour pairing** (flood-proof, and it puts Fable 5.1 first
  even with a cherry-proof family ceiling) — **rejected**: a one-bench
  HLE = 100 entry becomes #1, the saturation pump rises to #6, and held-out
  accuracy on configurations drops from 79.1% to 70.3%.
- **Re-adding √(N/N*) to the bench weight** — pushes the vanity farm from #1 to
  #2 but distorts the baseline (Fable 5.1 72, Astra 43) and reverses the
  June decision not to bury specialist benches. Rejected.
- **Stronger regularization** (λ 0.3 / 0.6) — lowers sparse configurations
  across the board; Fable 5.1 (xhigh, 3 benches) drops to #3 behind Sol and
  Astra. λ stays at the held-out-validated 0.15.
- Junk flooding has no clean formula fix; it is covered by the same operational
  rules as today (30 scores/day, source URL required, downvotes hide rows).

### 7.3 "Rankable SupraScore methods" (the user-voted-formula idea)

Feasible: the ranking lab already treats a method as a parameter set, and
this audit added a second library with five more. A public "Methods" tab
could expose every versioned method as a shareable profile (current, unified
BT, category-balanced, custom category sliders) with the same validation
table as section 5 next to each one.

Recommendation: let users **vote on which validated method is the default**,
but require every candidate to clear a published bar first (held-out
pairwise accuracy within 2 pp of the best method; LOBO stability ≥ 95%;
no single bench able to move the leader). Without the bar, a method vote is a
fan vote and the score stops reflecting reality — the opposite of the goal.
Governance and the profile switcher are the work; the math already exists.

## 7.4 The decisive experiment: density, not formula (2026-09-17)

Artificial Analysis embeds its full result matrix in its public pages
(`self.__next_f` payload: `models` with 652 rows on `/leaderboards/models`,
`initialModels` with every evaluation field for the 30 default frontier models
on each `/evaluations/*` page). Two experiments with that data
(`scripts/ranking-deepdive/aa-dense.mjs`, `aa-merge.mjs`):

**A. Our unified method on AA's own dense matrix** (their ten v4.3 index
components, equal bench weights, 30 frontier models):

Fable 5.1 68.3 › GPT-6 Astra 56.6 › GPT-5.6 Sol 45.7 › Muse Spark 1.3 42.6 ›
Fable 5 42.3 › Opus 5 36.9 › Kimi K3 32.5 › Grok 4.6 30.7 › GLM-5.3 27.0.

That is the order the maintainer expects and AA publishes. **The method
captures it as soon as the frontier is measured on the same hard benches.**

**B. Production snapshot + dense AA backfill, nothing removed** (410 cells: 165
missing cells on eight benches we already track, 245 cells on six benches we
do not track — AA-Briefcase, GDPval-AA v2, Terminal-Bench 4.0, AA-Omniscience,
GDP.pdf, CritPt; ARC-AGI-3 and every existing rating untouched):

| # | Model table | score | benches | | Family table | score |
|---:|---|---:|---:|---:|---|---:|
| 1 | Claude Fable 5.1 (max) | 61.9 | 11 | 1 | Claude Fable 5.1 | 61.9 |
| 2 | Claude Fable 5.1 (xhigh) | 58.4 | 11 | 2 | GPT-6 Astra | 56.9 |
| 3 | GPT-6 Astra (max) | 56.9 | 13 | 3 | Claude Opus 5 | 43.4 |
| 4 | GPT-6 Astra (xhigh) | 53.6 | 14 | 4 | GPT-5.6 Sol | 39.7 |
| 5 | Claude Fable 5.1 (high) | 49.6 | 11 | 5 | Muse Spark 1.3 | 37.8 |
| 6 | GPT-5.6 Sol | 48.8 | 8 | 6 | Claude Fable 5 | 36.4 |
| 7 | Claude Fable 5 (adaptive max) | 44.0 | 5 | 7 | Gemini 3.5 Flash | 28.9 |
| 8 | Claude Opus 5 (High) | 43.4 | 10 | 8 | Grok 4.6 | 25.7 |

Leave-one-bench-out family ranks over all 28 benches: Fable 5.1 1–2, Astra
1–2, Opus 5 3, Sol 4–6, Muse Spark 1.3 4–6. Rating the six new benches a
neutral 3/3/3/3/3 or giving ARC-AGI-3 one upvote like every other bench does
not change the top six. The three-bench "Opus 5 (High)" row that led the
sparse table drops to #8 once its other ten results are present — sparse
configurations were the artifact, not ARC-AGI-3.

**Control:** the *old* production math on the same dense data gives a sane
family table (Fable 5.1, Astra, Opus 5, Sol) but still a broken model table
(Mythos 5 first on one bench, Grok 4.6 (xhigh) third on two). Dense data fixes
the family view under either formula; only the unified fit fixes both.

Conclusion: SupraBench needs (1) the unified fit and (2) a curation policy that
keeps the frontier × hard-bench block dense. (2) is implemented by `scripts/curation-aa-backfill.mjs` and the revised
`docs/curation/SCHEDULED_TASK_PROMPT.md`.

## 8. Reproduction

```bash
npm run ranking:lab -- snapshot --deployment upbeat-clam-790
node scripts/ranking-deepdive/part1.mjs   # reproduce production + head-to-head matrix
node scripts/ranking-deepdive/part2.mjs   # method comparison, held-out, bootstrap, concrete-model additive
node scripts/ranking-deepdive/part3.mjs   # frontier-relative variants, sensitivity (drop ARC-AGI-3 / Tau2)
node scripts/ranking-deepdive/part4.mjs   # unified BT on configurations, Fisher SE, win-rate display
```

`SUPRABENCH_SNAPSHOT=/path/to/snapshot.json` overrides the snapshot location.
Part 2 takes about one minute.
