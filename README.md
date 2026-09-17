# SupraBench

**Community-driven AI model rankings based on benchmark trustworthiness.**

> Not all benchmarks are equal. SupraBench scores each benchmark on five quality
> dimensions, applies an automatic saturation penalty, and weights model scores
> accordingly — so a single number per model respects how trustworthy and how
> informative each underlying benchmark actually is.

> The full codebase is published so anyone can audit the SupraScore
> math, the anti-gaming rules, the official-source whitelist and the
> moderation logic end-to-end. Read the code, reproduce the numbers,
> fork for research and learning, open issues and PRs. If you want
> to *use* SupraBench day-to-day, visit
> [suprabench.com](https://suprabench.com). Licensing terms are in
> [LICENSE](LICENSE) — the BSL is **source-available**, not OSI
> open-source until the Change Date of 2029-01-01.

---

## What is SupraBench?

SupraBench is a platform for ranking AI language models using a **meta-score**
(SupraScore) that weights benchmark performance by the trustworthiness,
difficulty, and remaining headroom of each underlying benchmark. It exists to
fix three failure modes of public leaderboards:

- **Contamination** — test set leaked into training data.
- **Saturation** — every frontier model scores 99 %, no resolving power left.
- **Bench-maxing** — a model is tuned for a small set of popular benches.

**Everything is community-driven**: users add models, add benchmarks, submit
scores, vote on every entity, and rate benchmark quality. There is no
*editorial* curation of scores — admins exist only to enforce abuse rules
(spam removal, account bans, partner-key minting) and never edit, weight,
or reorder community submissions.

## How It Works

### The SupraScore

Two numbers, one method:

```
BenchScore(b)  = Q(b) · D(b) · H(b) · (u(b)/U*)          ← how much a bench counts
                  ↑      ↑      ↑       ↑
             quality  difficulty headroom  net-upvote share (linear)

cell(m,b)      = median of valid normalised submissions   ← one number per (model, bench)
duel           = every pair of models on every bench: higher cell wins, equal ties
w_duel(b)      = BenchWeight(b) / mean(BenchWeight) / (n_b − 1)
ability a_m    = regularised Bradley-Terry fit over all duels (λ = 0.15)
                 P(m beats k) = 1 / (1 + e^−(a_m − a_k))
SupraScore(m)  = 100 · mean over the current top-10 of P(m beats k)     ∈ [0, 100]
family         = score of its best configuration from the same fit
```

**Why duels and not an average of percentages.** A point does not mean the
same thing on every benchmark: 5 % leads ARC-AGI-3 while 98 % is ordinary on a
saturated bench, and first of 90 models is not first of 8. Duels are
scale-free, and because models share opponents the fit joins all benches
together — beating a strong field counts for more than beating a weak one.

- **Bench Score** $\operatorname{BenchScore}(b) \in [0,100]$ — the headline
  number shown for each bench and the weight of every duel fought on it.
- **Quality** $Q(b) \in [0,100]$ — mean of community ratings on relevance,
  contamination resistance, discriminability, reproducibility, then ×20.
- **Difficulty** $D(b) \in [0,1]$ — median rater difficulty, scaled
  $((d-1)/4)$. Difficulty 1/5 means weight 0: no duels at all.
- **Headroom** $H(b) \in [0.1,1]$ — automatic saturation penalty: shrinks as
  the top-K models converge on 100 %, with a floor at 0.1 so historic benches
  never disappear.
- **Net-upvote share** $u(b)/U^\star$ — the **user-trust** signal, **linear on
  purpose**: a bench the community strongly endorses out-weighs one it does
  not, and a one-account vanity bench at a self-rated $Q\!=\!100$ is worth
  only $1/U^\star$ of an established peer. $U^\star = 0$ disables the factor on
  a fresh deployment.
- **Small-rater prior** — inside the ranking, while a bench has few raters
  each 1–5 rating is pulled toward the neutral 3 with a three-rater prior, so
  one enthusiastic rater is not treated as consensus. The displayed Bench
  Score is the unshrunk product.
- **Equal mass per bench** — dividing by $n_b - 1$ gives every model the same
  total weight from a bench no matter how many others ran it.
- **Untested is not negative evidence** — a bench only one model ran produces
  no duel. Nothing is shrunk toward an arbitrary midpoint any more.
- **Regularisation** $\lambda = 0.15$ — pulls thinly tested models toward the
  middle so one spectacular result cannot outrank models that won across the
  board. Chosen by held-out benchmark prediction, not by a desired order.
- **Displayed score** — expected win rate against the ten strongest
  configurations right now (a member counts a tie against itself). 50 = as
  good as the average frontier model. It is relative by design: when a
  stronger model arrives, everyone else's score drops.
- **Families** — a family shows the score of its best configuration from the
  same fit, so the Model and Model-Family views always agree. A configuration
  may represent its family only if it covers ≥ 50 % of the family's bench
  weight; one that lists only the benches it wins cannot speak for the family.

The whole calculation is one dependency-free file,
[`public/js/supra-rank-core.js`](public/js/supra-rank-core.js). The Convex
rebuild imports it, and the browser loads the very same file for tag-filtered
views and the simulator — there is no second implementation to drift.

Why this replaced the weighted mean of raw percentages (September 2026), which
alternatives were rejected, and how every original design goal was re-tested:
[`docs/research/RANKING_REALITY_AUDIT_2026-09-16.md`](docs/research/RANKING_REALITY_AUDIT_2026-09-16.md).
Worked example and full walkthrough: [About page](https://suprabench.com/#about).

### Community validation (five layers)

1. **Submission votes** — each individual score is up/downvoted; only
   net-positive submissions count.
2. **Quality + difficulty ratings** — anyone signed in rates a bench on five
   1–5 dimensions (mean for quality, median for difficulty).
3. **Tag votes** — each tag on a model or bench is voted independently.
4. **Existence votes** — fakes and duplicates can be downvoted into a hidden
   state. Engagement-aware threshold:
   `down ≥ max(5, ⌈0.6 · (up + down)⌉) ∧ down > up`.
5. **Anti-resurrection** — re-submitting your own community-removed entries
   under the same name is blocked.

### Model families

A **family** is one specific lab release — not a vendor, not a
generation. `Claude Opus 4.6` and `Claude Opus 4.7` are separate
families, `Claude` on its own is not a family.

Variants of the same release and product tier (different sampling / reasoning
effort, context-window SKUs, fine-tune modes) stay in the same family and
disambiguate via a parenthetical suffix on the model's display name:

| Family              | Members                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `Claude Opus 4.7`   | `Claude Opus 4.7`, `Claude Opus 4.7 (max)`                             |
| `GPT-5.3 Codex`     | `GPT-5.3 Codex (low)`, `… (med)`, `… (high)`, `… (xhigh)`              |
| `GPT-5.6 Sol`       | `GPT-5.6 Sol`, `GPT-5.6 Sol (medium)`, `… (xhigh)`, `… (max)`           |
| `Gemini 3.1`        | `Gemini 3.1`, `Gemini 3.1 (thinking)`                                  |

Common suffixes: `(low)` / `(med)` / `(high)` / `(xhigh)`,
`(thinking)`, `(max)`, `(128k)` / `(200k)` / `(1M)`, `(instruct)` /
`(chat)` / `(base)`. A one-off release with no variants has
`familyTag == name` and a family ranking with `modelCount: 1`.

Product tiers and versioned releases remain distinct: `GPT-5.6 Sol`, `Terra`,
and `Luna` are separate families, as are `Muse Spark 1.1` and `1.2`. The shared
[`modelFamilies.ts`](convex/modelFamilies.ts) helper enforces only these reviewed,
unambiguous mappings; unknown provider taxonomies keep the submitted family tag
instead of being guessed automatically.

The family leaderboard is not a second formula. Every concrete configuration
is ranked by the pairwise fit above, and a family shows **the score of its best
configuration** (the row names it). A configuration may represent its family
only if it covers at least half of the family's total bench weight; if none
does, the most broadly tested one is used. Families with fewer than **three
distinct benchmarks** remain visible but are marked **provisional**.

Ranking research tools and decisions are documented in
[`docs/research/RANKING_LAB.md`](docs/research/RANKING_LAB.md), including the
offline [Bayesian rating-prior experiment](docs/research/BAYESIAN_RATING_PRIOR_EXPERIMENT.md)
and the proposed [user-controlled category weighting](docs/research/CATEGORY_WEIGHTING_CONCEPT.md).
The [ranking reality audit](docs/research/RANKING_REALITY_AUDIT_2026-09-16.md)
reproduces both leaderboards from a live snapshot, checks them against the
frontier head-to-head record and ten alternative aggregations, and lists the
data and formula changes recommended next.
The [benchmark-scale calibration experiment](docs/research/BENCHMARK_SCALE_CALIBRATION_EXPERIMENT.md)
tests raw, empirical-percentile, robust-z, coverage-reliability, and evidence-gate
variants. Its percentile recommendation was superseded after participant-field
bias made Gemini 3.5 Flash rank first. The follow-up
[opponent-adjusted experiment](docs/research/OPPONENT_ADJUSTED_FAMILY_RANKING.md)
adds strength of schedule and held-out predictive validation.

### Official vs Community sources

Benchmarks linked to a reviewed first-party/original source — an academic or
lab publisher, the benchmark's own project site, or an exact author-owned
repository — get an "Official source" badge. Third-party mirrors, videos,
roundups, social posts, and unreviewed repositories are "Community sources".
Both are accepted. The badge describes provenance, not benchmark quality or
ranking weight; those remain community-controlled. Domain and exact-repository
rules live in [`convex/urls.ts`](convex/urls.ts), and a regression test keeps
the browser preview aligned with the server.

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | [Convex](https://convex.dev) — reactive serverless DB + functions (rankings, votes, ratings, auth, HTTP API) |
| Score store (hot path) | [Cloudflare D1](https://developers.cloudflare.com/d1/) SQLite, fronted by a Cloudflare Worker — see [`infra/scores-worker/`](infra/scores-worker/) and [Score storage and rebuild path](#score-storage-and-rebuild-path) below |
| Edge proxy | Cloudflare Worker in front of `/v1/*` for caching + custom headers — see [`infra/cloudflare-worker/`](infra/cloudflare-worker/) |
| Hosting | [Cloudflare Pages](https://pages.cloudflare.com/) for the static site, deployed on every push to `main` |
| Auth | [`@convex-dev/auth`](https://labs.convex.dev/auth) with Google OAuth |
| Frontend | Vanilla HTML + [Alpine.js](https://alpinejs.dev) v3 (no React, no build step) |
| Math rendering | [KaTeX](https://katex.org/) (About page only) |
| Fonts | [Clash Display](https://www.fontshare.com/fonts/clash-display) via Fontshare CDN |
| Discussion | [Giscus](https://giscus.app) on every bench and submission page, themed to match the site ([`public/css/giscus-theme.css`](public/css/giscus-theme.css)) |

## Features

- **Model Rankings** — global SupraScore leaderboard with tag-based filtering
  and per-tag filtered scores
- **Benchmark Index** — Bench-Score-ranked benchmark directory with five-dimension
  community ratings
- **Score Submission** — three modes: single score, "fill row" (one bench, many
  models), "fill column" (one model, many benches)
- **Quality Ratings** — five dimensions per bench (1–5 scale): relevance,
  contamination resistance, discriminability, reproducibility, difficulty
- **Voting** — submissions, tags, and entity existence are all separately
  votable
- **Tag Filtering** — filter models / benches by tags; rankings recompute
  per active tag set
- **User Profiles** — per-user submission, vote, rating, and tag-vote history

## Project Structure

```
suprabench/
├── convex/                       # Convex backend
│   ├── schema.ts                 # Database schema (incl. denormalized caches)
│   ├── auth.ts                   # Google OAuth setup
│   ├── models.ts                 # Model queries + mutations
│   ├── benches.ts                # Benchmark queries + mutations
│   ├── submissions.ts            # Score submission logic + rate limiting
│   ├── votes.ts                  # Per-submission voting
│   ├── tagVotes.ts               # Per-tag voting + effective-tag recompute
│   ├── entityVotes.ts            # Entity-existence voting + auto-hide logic
│   ├── benchQualityRatings.ts    # 5-dimension quality ratings
│   ├── tags.ts                   # Tag aggregation (cached)
│   ├── rankings.ts               # Bench weights, headroom, rebuild drivers (math: public/js/supra-rank-core.js)
│   ├── familyRankings.ts         # Family ranking cache entry points (same fit as models)
│   ├── modelFamilies.ts          # Conservative cross-provider family normalization
│   ├── cache.ts                  # Denormalized aggregate recompute helpers
│   ├── migrations.ts             # One-off backfill mutations
│   ├── users.ts                  # Viewer + activity feed
│   ├── admin.ts                  # Internal cleanup utilities
│   ├── urls.ts                   # Official-source whitelist
│   ├── api.ts                    # Live public HTTP API (/v1/* read endpoints, Partner-keyed)
│   ├── tiers.ts                  # Single source of truth for API tier shapes
│   ├── partners.ts               # Partner-key issuance + management
│   ├── waitlist.ts               # Demand-gate waitlist for paid tiers
│   ├── scoresWorker.ts           # Internal actions that talk to the Cloudflare D1 scores worker
│   └── stripe.future.ts          # Stripe billing skeleton — activates when paid tiers ship
├── infra/
│   ├── cloudflare-worker/        # Edge cache + header rewriter in front of /v1/*
│   └── scores-worker/            # D1-backed mirror of modelScores; see README in that folder
├── public/
│   ├── index.html                # Single-page app — all views in one file
│   ├── _headers                  # Cloudflare Pages CSP + cache headers
│   ├── sw.js                     # Service worker (PWA, offline shell)
│   ├── sitemap.xml               # SEO sitemap
│   ├── docs/api/                 # Static API docs (mirrored from convex/api.ts)
│   ├── legal/                    # Imprint, privacy, terms
│   ├── css/style.css             # Design system
│   ├── img/                      # Logos + favicons
│   └── js/
│       ├── supra-rank-core.js    # THE ranking math — shared by server, tag filter and simulator
│       ├── app.js                # Alpine.js application
│       └── convex.js             # Convex client + auth bootstrap
├── docs/
│   └── api-roadmap.md            # Public API design + pricing rationale (paid tiers)
├── tests/                        # Vitest + convex-test suite (unit + adversarial + integration)
├── package.json
└── .env.local                    # OAuth + Convex credentials (gitignored)
```

## Pages

| Route | Description |
|---|---|
| `#models` (default) | Model ranking table with tag filtering |
| `#model/{slug}` | Model detail with per-bench scores + tag voting |
| `#benches` | Benchmark quality ranking |
| `#bench/{slug}` | Benchmark detail with quality ratings + per-model scores |
| `#submit` | Submit scores / models / benchmarks (3 modes) |
| `#submission/{id}` | Individual submission detail with vote panel |
| `#about` | Q&A explaining the SupraScore math (rendered with KaTeX) |
| `#profile` | Logged-in user's submissions / votes / ratings |
| `#legal/imprint`, `#legal/privacy`, `#legal/terms` | Legal pages |

## Anti-Gaming Rules

- **One submission can't anchor a score** — the per-(model, bench) median
  becomes robust to outliers as soon as $n \ge 2$ submissions exist; a
  single attacker submission is replaced by the community median the
  moment a second honest submission lands
- **One bench can't carry a model** — scores become weighted duels and the
  fit is regularised: a model with one spectacular result is pulled toward the
  middle and cannot outrank models that won across many trusted benches.
- **One user can't carry a bench** — every bench's weight is multiplied by the
  **linear** upvote-share $u(b)/U^\star$. A self-rated 100/100 vanity bench from
  a single account is worth $1/U^\star$ of an established bench at the same
  Q·D·H — you'd need $U^\star$ separate accounts upvoting your bench just to
  tie. The same factor orders the bench leaderboard. This defence is only as
  strong as real voting: while every bench sits at one vote, $U^\star = 1$.
- **A bench only you ran is worth nothing** — a duel needs an opponent. A
  one-model vanity bench produces no duel, so a self-reported 100 on it moves
  no ranking until other models are measured there.
- **A flattering configuration can't speak for its family** — see the 50 %
  coverage rule above.
- **Verifiable robustness** — every defensive claim above is encoded
  as an executable test in
  [`tests/convex/adversarial-robustness.test.ts`](tests/convex/adversarial-robustness.test.ts);
  see [Adversarial robustness harness](#adversarial-robustness-harness)
  below for the full invariant + attack catalog and what each one
  defends against.
- **Difficulty uses median** — single inflated rater can't fake difficulty
- **Saturation auto-detected** — pumping a saturated bench gives diminishing
  returns by construction
- **Engagement-aware hide threshold** — small voting cliques can't take down
  established entries (5-downvote floor + 60 % ratio)
- **Anti-resurrection** — re-submitting your own removed entries blocked
- **Rate limiting** — max **30** individual scores per 24 h per user
- **One vote per user per submission** (toggle behavior)
- **One quality rating per user per benchmark** (upsert)
- **Score range validation** against the bench's declared scale
- **Source URL required** for every submission

## Adversarial robustness harness

Every claim in [Anti-Gaming Rules](#anti-gaming-rules) is encoded as an
executable test in
[`tests/convex/adversarial-robustness.test.ts`](tests/convex/adversarial-robustness.test.ts).
The suite includes **146 tests across 14 files** (14 adversarial at the time of
this methodology update). When the math regresses, a named test fails with a
descriptive message — instead of someone discovering the regression
on the production leaderboard.

The Vitest suite lives in `tests/convex/` with its own `package.json`.
You can run it from the repo root via the proxy script in `package.json`,
or directly:

```bash
# from repo root (one-time install of test deps):
npm run test:install
npm test                                   # full suite

# or from tests/convex/ for a file filter:
cd tests/convex
npx vitest run adversarial-robustness
```

The harness has three layers, each adding a different kind of
guarantee:

### Layer 1 — Invariants

Properties that **must hold for every valid ecosystem, ever**. They
get checked on a hand-crafted baseline, after every attack scenario,
and against every fuzz seed. If a new feature ever breaks one, the
exact invariant id + the data that violates it is reported.

| ID  | Invariant                                                                        |
| --- | -------------------------------------------------------------------------------- |
| I1  | Every SupraScore is a finite number in $[0, 100]$                                |
| I2  | Every BenchScore (`effectiveWeight`) is finite in $[0, 100]$                     |
| I3  | The bench at the maximum upvote axis ($u_b\!=\!U^\star$) has `effectiveWeight == rawWeight` (no self-penalty; model count does not enter the weight) |
| I4  | Rankings table is sorted by `supraScore` (no row outranks the leader)            |
| I5  | Hidden benches do not appear in the public `listRanked` payload                  |
| I6  | Every model with at least one bench has `supraScore > 0` (unless its ability mean is genuinely 0) |
| I7  | Every BenchScore equals `rawWeight × (u/U*)` exactly — the linear upvote-share (formula sanity) |

### Layer 2 — Attack catalog

Each entry is a **concrete adversarial scenario** with a setup
function (seeds the dataset) and an `expect` predicate (asserts the
attacker's outcome). Every attack scenario also has to satisfy every
Layer-1 invariant — an attack that succeeds *and* breaks an invariant
counts as two regressions, not one.

| ID          | Scenario                                                                           | Status                |
| ----------- | ---------------------------------------------------------------------------------- | --------------------- |
| A1          | Self-rated vanity bench tries to claim **#1 on the bench leaderboard** (1 upvote, single account, $Q\!=\!100$)         | Defended by linear upvote-share |
| A2          | Vanity bench used to vault attacker's model into top SupraScore (single self-scored bench)                              | Defended: a solo bench produces no duel |
| A3          | **3-bench vanity stack** — 3 self-rated benches, all testing only the attacker's model, vs frontier-class legit ecosystem | Defended by combined math |
| A3-extreme  | **8-bench industrial vanity farm** — same shape, scaled up                          | Defended by the linear upvote-share; operational defenses (rate-limit, downvotes, anti-resurrection, moderation) back it up |
| A4          | Sockpuppet upvote attack — 3 fake accounts upvoting a vanity bench against an ecosystem with 8 legit voters per bench    | Defended (sockpuppet count $\ll U^\star$) |
| A5          | Single-bench peak attack — model with one $\mu\!=\!100$ vs a model with three $\mu\!=\!80$                              | Defended by the regularised fit |
| A6          | Hidden vanity bench tries to leak its high `cachedNetUpvotes` into $U^\star$ / $N^\star$                                  | Defended (hidden benches excluded from maxima) |

`A3-extreme` used to be a **documented limitation** — under the old
$\sqrt{u/U^\star}$ upvote-share, the pure math was overwhelmed once an
attacker stacked 8 self-rated vanity benches. Switching the upvote-share
to **linear** $u/U^\star$ tightened the bound enough that the test now
**asserts the attacker stays below the legit frontier**: each vanity bench
contributes only $1/U^\star$ of duel weight, and a farm on which only the
attacker's model appears produces no duels at all. The variant the pure math
does **not** stop — a farm where the attacker also submits low scores for
rival models, while real benches have no vote lead — is documented with
numbers in the ranking audit and is left to the operational rules below. If a
future change ever lets an 8-bench farm break through again, this test
fails with a message asking the next engineer to either restore the
documented-limitation framing or raise the bench-count threshold.

Even so, the math doesn't have to do *all* the work — the same attack is
independently defeated operationally, because it would require:

1. Creating 8 benches under one account (highly visible to moderation).
2. Submitting 8+ self-scores in 24 h — under the 30/day rate limit
   but still highly visible.
3. Hoping no one notices and downvotes them. As soon as $\geq 5$
   downvotes land, the bench is hidden and excluded from $U^\star$, every
   duel and the leaderboard — the attack collapses.
4. Anti-resurrection then prevents re-creating the same benches under
   the same name.

The cost-benefit clearly favours legitimate contribution.

### Layer 3 — Seeded fuzz

A deterministic [`mulberry32`](https://en.wikipedia.org/wiki/Permuted_congruential_generator) PRNG generates
random ecosystems (2–4 owners, 3–10 voters, 2–6 benches, 3–8 models,
random ratings + upvote subsets + score subsets), runs the full
recompute pipeline, and verifies **every Layer-1 invariant** holds.
Six pinned seeds (`1, 7, 42, 100, 314, 9001`) are checked on every
CI run; failures report the exact seed so the failing ecosystem can
be reproduced locally with one line of code.

Adding a new pinned seed is a one-line change. If a future fuzz seed
ever exposes a regression, **never delete the seed** — leave it in
the suite as a permanent guard against that class of bug.

### Adding a new attack or invariant

The harness is structured to make defensive claims **cheap to add and
hard to lose**. To document a new attack you suspect:

1. Add an entry to `ATTACKS` in `adversarial-robustness.test.ts` with
   a `setup` that seeds the scenario and an `expect` predicate that
   formalises "the attacker doesn't win".
2. Run the suite. Either the math defends it (great, you have a new
   regression test) or the math doesn't (now you know — either
   strengthen the math or document the limitation like `A3-extreme`).

Same for invariants: a new entry in `INVARIANTS` is automatically
checked on the baseline, every attack scenario, and every fuzz seed.

## PWA

The site is installable as a native-feeling app on Android, iOS and
Desktop. Components:

- [`public/site.webmanifest`](public/site.webmanifest) — name, scope,
  shortcuts (Models / Benchmarks / Submit / About), icons in `any` and
  `maskable` purposes.
- [`public/sw.js`](public/sw.js) — service worker with
  network-first for HTML, stale-while-revalidate for JS/CSS,
  cache-first for images. Convex and giscus traffic is never cached.
- [`public/offline.html`](public/offline.html) — fallback shown when
  the network is gone.
- iOS-specific meta tags in `public/index.html` so Safari treats
  Add-to-Home-Screen launches as a chromeless app with the dark
  status bar style. The manifest's `display: standalone` covers
  Android and Desktop Chromium.
- Service worker is skipped on `localhost` to keep dev iterations
  cache-free.

After deploying changes, the SW picks them up on the next navigation
(it `postMessage`s `SKIP_WAITING` once the new SW is installed).
Force a reload in DevTools → Application → Service Workers if you
want to test more aggressively.

## Performance / cost notes

The hot listing queries (`models.listRanked`, `models.listRankedWithFilter`,
`benches.listRanked`, `benches.getBySlug`, `tags.listAll`) read from
denormalized caches kept in sync by mutations — see
[`convex/cache.ts`](convex/cache.ts). After deploying schema changes, run the
backfill once:

```bash
npx convex run --prod migrations:backfillAll
```

Idempotent. The frontend opens subscriptions lazily per active view, so an
idle session running on a model detail page costs ~1 long-lived subscription
instead of 6.

### Score storage and rebuild path

The single biggest read source on Convex used to be the ranking
recompute, which scans the entire `modelScores` table on every
submission and every vote. That made Convex bandwidth (1 GB/mo on
the free plan) the binding constraint long before we'd hit any
other quota.

To break the dependency we mirror every score row to a Cloudflare
D1 SQLite database fronted by a small Worker (see
[`infra/scores-worker/`](infra/scores-worker/) for the full code,
schema, deploy commands and pricing math). The architecture is:

```
   Browser          Convex                    Cloudflare D1
  (mutation) ─▶  modelScores  ─runAfter(0)─▶  suprabench-scores
                    ↑ (primary store)              ↑ (read replica)
                    │                              │
                    ╰─────  rebuild reads from ────╯
                            D1, writes rankings
                            back to Convex
```

* **Writes** still hit Convex first inside the user-facing
  mutation — so the user sees a strongly-consistent response.
* A scheduled action (`scoresWorker.mirrorScoresAndRebuild`)
  immediately POSTs the new row to the D1 worker and then triggers
  the unified ranking rebuild.
* **Rankings** (`rankings.recomputeFromD1`) read the entire score
  set from D1 over a single HTTP `GET /scores`, compute model and
  family rankings in memory, and write the (much smaller) rankings
  tables back to Convex.

Net effect: the per-submission Convex bandwidth bill collapses
from "rescan 10–100 k score rows" to "fetch a few hundred bytes
of cached aggregates and write back two ranking rows per affected
model/family", which lets the free tier comfortably absorb the
projected launch traffic. Cost analysis and the upgrade thresholds
live in [`infra/scores-worker/README.md`](infra/scores-worker/README.md).

The Convex `modelScores` table stays as the primary store and a
rollback safety net during phase-1 of the migration. Once D1 is
proven as the source of truth, we'll cut over the remaining read
paths (detail pages, simulator, API listings) and drop the Convex
copy. None of this is observable to end users.

## Public HTTP API

`/v1/*` is **live today** for invited Partner keys — read
endpoints for models, benchmarks, rankings, tags, and submissions.
The full developer-facing documentation is published under
[`/docs/api/`](public/docs/api/) and the implementation lives in
[`convex/api.ts`](convex/api.ts) (HTTP routes, key validation,
per-key rate limiting + quotas, edge-cache headers).

| Tier | Status | Notes |
|---|---|---|
| Partner | **Live, free, invite-only** | Manual issuance via [`convex/partners.ts`](convex/partners.ts); used to seed the ecosystem. |
| Starter / Pro / Enterprise | **Demand-gated** | All implementation is shipped — Stripe wiring lives in [`convex/stripe.future.ts`](convex/stripe.future.ts) and only flips on once the waitlist hits launch threshold. |
| Enterprise+ | Custom contracts | Direct conversation, not self-serve. |

Schema, endpoint catalog, pricing rationale, Stripe activation
steps and the Convex-cost analysis that drove the demand-gating
policy all live in [`docs/api-roadmap.md`](docs/api-roadmap.md).

**Tier shape lives in exactly one place:**
[`convex/tiers.ts`](convex/tiers.ts). Every other file — the
tier-cards in [`public/index.html`](public/index.html), the API
docs tables under [`public/docs/api/`](public/docs/api/), the
roadmap markdown — mirrors quotas, RPM and key counts from that
file. **Paid-tier prices are intentionally `null` / "TBD"
everywhere right now**: final pricing is collected via the
waitlist before launch. The real numbers will live in the Stripe
dashboard (Products → recurring Prices) and never in this repo —
at checkout we send only the Stripe Price ID and Stripe owns the
amount/currency. To prevent drift,
`npm run check:tiers` runs
[`scripts/check-tier-consistency.mjs`](scripts/check-tier-consistency.mjs)
which parses `tiers.ts` and grep-validates every other place — it
fails with a non-zero exit code if any document disagrees. Run it
before merging any tier change (or wire it into CI).

## Reading the code

This repo is intentionally simple to read end-to-end:

- **SupraScore math** — [`convex/rankings.ts`](convex/rankings.ts)
- **Bench Score (quality × difficulty × headroom)** — same file, plus
  [`convex/benches.ts`](convex/benches.ts) for the cached field.
- **Anti-gaming rules** — [`convex/submissions.ts`](convex/submissions.ts),
  [`convex/entityVotes.ts`](convex/entityVotes.ts).
- **Official-source whitelist** — [`convex/urls.ts`](convex/urls.ts).
- **Schema (incl. denormalised caches)** — [`convex/schema.ts`](convex/schema.ts).
- **Frontend** — single-page app, vanilla HTML + Alpine.js, no build step:
  [`public/index.html`](public/index.html), [`public/js/app.js`](public/js/app.js).

There is **no setup guide** here on purpose — for most questions
("what does bench X score?", "how is model Y's SupraScore computed?")
the easier path is the public dataset, which the
[Public HTTP API](#public-http-api) exposes directly (request a
free Partner key while paid tiers are still demand-gated). If
you're digging into the math, an install isn't required:
`convex/rankings.ts` is self-contained enough to reproduce against
the dataset in any language. For reproducibility or implementation
questions, open an issue on the
[tracker](https://gitlab.com/florian-fischer-group/suprabench/-/issues) —
PRs are welcome too.

## Security model

The frontend, the Convex query/mutation handlers, and the planned HTTP API
are **all** designed to be safe with a fully public codebase:

- **No secrets in the repo.** Every secret (Google OAuth client ID/secret,
  JWT keys, the D1 scores-worker bearer, the planned Stripe + webhook
  secrets) lives in `.env.local` (gitignored) for dev and in
  `npx convex env set` / `npx wrangler secret put` for production.
  The repo only references their *names*.
- **Authorization is server-side.** Every mutation re-checks
  `ctx.auth.getUserIdentity()` and the caller's role — the client is treated
  as fully untrusted. Rate limits, vote-once rules and the auto-hide
  thresholds are enforced in Convex, not in the UI.
- **Convex public URL is OK to be public.** The deployment URL in
  `public/js/convex.js` is the same kind of identifier as a Firebase
  project ID. Authentication still has to happen against it; an attacker
  knowing the URL gains nothing they couldn't get by visiting the live site.
- **Cloudflare D1 scores worker.** Server-to-server only. Every
  request carries `Authorization: Bearer <SCORES_WORKER_SECRET>`;
  the browser never touches that URL. The worker also writes the
  `Access-Control-Allow-Origin` only on the `/health` ping.
- **Public HTTP API.** Live for Partner keys today, paid tiers
  demand-gated. Bearer keys (`sb_live_…`) are generated and stored
  hashed in Convex, validated server-side on every request, with
  per-key tier-based rate limits + monthly quotas. Every `/v1/*`
  response sends `Access-Control-Allow-Origin: *` so browsers can
  call us directly, but **putting an API key into client-side code
  is unsafe regardless of CORS** — wrap every browser call in a
  server-side proxy that holds the key. See
  [`convex/api.ts`](convex/api.ts), [`convex/partners.ts`](convex/partners.ts),
  and [`convex/tiers.ts`](convex/tiers.ts). Stripe billing for paid
  tiers will activate via [`convex/stripe.future.ts`](convex/stripe.future.ts);
  webhook signatures are verified with `STRIPE_WEBHOOK_SECRET`
  (Convex env var, never in code).

If you spot anything that looks security-sensitive, please report it
privately via the email in [`/legal/imprint`](https://suprabench.com/legal/imprint).

## License

[Business Source License 1.1](LICENSE) — see the [`LICENSE`](LICENSE)
file for the exact terms. The short version: read, fork, study,
patch, redistribute, and use non-commercially; commercial use has a
standard BSL carve-out until the **Change Date of 2029-01-01**, when
the whole codebase auto-converts to Apache License 2.0. If you're
unsure whether your use case fits, the LICENSE text is short and
covers it; open an issue if you'd like clarification.

> Tip for the curious: the simplest path to verify the SupraScore
> independently is to reproduce the math from
> [`convex/rankings.ts`](convex/rankings.ts) against the public dataset
> exposed by the [HTTP API](#public-http-api) (Partner keys are free
> while paid tiers are demand-gated). No deployment required.

Community-driven. No corporate influence.
