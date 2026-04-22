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
> [suprabench.ai](https://suprabench.ai). Licensing terms are in
> [LICENSE](LICENSE).

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
scores, vote on every entity, and rate benchmark quality. There is no admin
curation layer.

## How It Works

### The SupraScore

For a model $m$, with valid normalised per-bench medians $\mu_{m,b}$ over its
evaluated benches $\mathcal{B}_m$:

```
BenchScore(b)   = Q(b) · D(b) · H(b) · √(u(b)/U*) · √(N(b)/N*)
                                  ↑              ↑              ↑
                          quality·diff·headroom  upvote-share   model-count-share
                                              U* = max u over non-hidden benches
                                              N* = max N over non-hidden benches
weightedMean(m) = Σ_b μ(m,b) · BenchScore(b)  /  W(m)
W(m)            = Σ_b BenchScore(b)                   ← accumulated coverage
SupraScore(m)   = weightedMean(m) · √(W(m) / W*)      ← W* = max over non-hidden models
                                              ∈ [0, 100]
```

- **Bench Score** $\operatorname{BenchScore}(b) \in [0,100]$ — the bench's
  contribution to a model's SupraScore, and the headline number shown for
  each bench in the UI. Multiplicative product of the five factors below;
  the natural range is $[0,100]$ because difficulty, headroom, and both
  coverage-share factors are all on $[0,1]$.
- **Quality** $Q(b) \in [0,100]$ — mean of community ratings on relevance,
  contamination resistance, discriminability, reproducibility, then ×20.
- **Difficulty** $D(b) \in [0,1]$ — median rater difficulty, scaled
  $((d-1)/4)$.
- **Headroom** $H(b) \in [0.1,1]$ — automatic saturation penalty: shrinks as
  the top-K models converge on 100 %, with a floor at 0.1 so historic benches
  never disappear.
- **Upvote-coverage share** $\sqrt{u(b)/U^\star}$ — every bench has a net
  entityVote count $u(b) = \max(0, \text{ups} - \text{downs})$, and $U^\star$
  is the maximum across non-hidden benches. The same $\sqrt{\cdot}$ shrinkage
  used on the model side is applied here so a one-account vanity bench can't
  appear at #1 on the bench leaderboard with a self-rated $Q\!=\!100$. The
  most-upvoted bench has share $=1$ (no self-penalty); $U^\star = 0$ disables
  the factor on a fresh deployment.
- **Model-count-coverage share** $\sqrt{N(b)/N^\star}$ — $N(b)$ is the number
  of distinct (non-hidden) models with a net-positive submission on $b$, and
  $N^\star$ is the maximum across non-hidden benches. Encodes "how widely is
  this bench used to rank models?" — a bench tested by 1 model gives almost
  no comparative information; one tested by 30 models gives strong signal.
  Defends "spawn a community bench and test only your own model on it"
  cleanly: such a bench has $N(b)=1$ and so contributes $\sqrt{1/N^\star}$
  of the weight an established bench at the same Q·D·H would. Modality
  asymmetry (image benches naturally cover fewer models than text benches)
  is intentional — those benches genuinely tell us less about the broader
  model population. Most-tested bench has share $=1$; $N^\star = 0$ disables
  the factor on a fresh deployment.
- **Per-(model, bench) score** $\mu_{m,b}$ — median of all valid (net-positive
  vote) normalised submissions, robust to a single outlier.
- **Model coverage share** $W(m)/W^\star$ — the fraction of the best-covered
  model's accumulated Bench-Score weight that $m$ has been evaluated against.
  The $\sqrt{\cdot}$ shape mirrors the $1/\sqrt{N}$ standard-error falloff of
  a sample mean — halving coverage shrinks the score by $\sqrt{2}$, not by 2.
  Zero hyperparameters: $W^\star$ comes from the DB, not a prior. The
  best-covered model has share $=1$ and no self-penalty. Hidden models are
  excluded from $W^\star$.

Worked example, full math, and trajectory tables: [About page on the live site](https://suprabench.ai/#about).

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

Variants of the same release (different sampling / reasoning effort,
context-window SKUs, fine-tune modes) stay in the same family and
disambiguate via a parenthetical suffix on the model's display name:

| Family              | Members                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `Claude Opus 4.7`   | `Claude Opus 4.7`, `Claude Opus 4.7 (max)`                             |
| `GPT-5.3 Codex`     | `GPT-5.3 Codex (low)`, `… (med)`, `… (high)`, `… (xhigh)`              |
| `Gemini 3.1`        | `Gemini 3.1`, `Gemini 3.1 (thinking)`                                  |

Common suffixes: `(low)` / `(med)` / `(high)` / `(xhigh)`,
`(thinking)`, `(max)`, `(128k)` / `(200k)` / `(1M)`, `(instruct)` /
`(chat)` / `(base)`. A one-off release with no variants has
`familyTag == name` and a family ranking with `modelCount: 1`.

Users can edit `familyTag` on any model they have permission for and
the [`familyRankings`](convex/familyRankings.ts) cache refreshes on
the next mutation tick — there is no canonical list and no admin
curation. The full rationale and worked examples live in the About
page Q9b on the live site.

### Official vs Community sources

Submissions from a curated whitelist of academic, lab, and dedicated
leaderboard hosts get an "Official source" badge. Everything else is a
"Community source". Both are accepted — the badge is a transparency signal,
not a gatekeeper. Whitelist lives in [`convex/urls.ts`](convex/urls.ts).

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | [Convex](https://convex.dev) — reactive serverless DB + functions |
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
│   ├── rankings.ts               # SupraScore + headroom math
│   ├── cache.ts                  # Denormalized aggregate recompute helpers
│   ├── migrations.ts             # One-off backfill mutations
│   ├── users.ts                  # Viewer + activity feed
│   ├── admin.ts                  # Internal cleanup utilities
│   ├── urls.ts                   # Official-source whitelist
│   ├── api.future.ts             # Planned paid HTTP API (placeholder)
│   └── stripe.future.ts          # Planned Stripe billing (placeholder)
├── public/
│   ├── index.html                # Single-page app — all views in one file
│   ├── css/style.css             # Design system
│   ├── img/                      # Logos + favicons
│   └── js/
│       ├── app.js                # Alpine.js application
│       └── convex.js             # Convex client + auth bootstrap
├── docs/
│   └── api-roadmap.md            # Public API design + pricing
├── package.json
└── .env.local                    # OAuth + Convex credentials (gitignored)
```

## Pages

| Route | Description |
|---|---|
| `#models` (default) | Model ranking table with tag filtering |
| `#model/{slug}` | Model detail with per-bench scores + tag voting |
| `#benchmarks` | Benchmark quality ranking |
| `#bench/{slug}` | Benchmark detail with quality ratings + per-model scores |
| `#submit` | Submit scores / models / benchmarks (3 modes) |
| `#submission/{id}` | Individual submission detail with vote panel |
| `#about` | Q&A explaining the SupraScore math (rendered with KaTeX) |
| `#profile` | Logged-in user's submissions / votes / ratings |
| `#legal/imprint`, `#legal/privacy`, `#legal/terms` | Legal pages |

## Anti-Gaming Rules

- **One submission can't carry a score** — per-(model, bench) median needs
  multiple submissions to move
- **One bench can't carry a model** — SupraScore averages across all benches
  weighted by trust × difficulty × headroom, then shrinks the result by the
  coverage-share factor $\sqrt{W(m)/W^\star}$. A model with only 1 bench loses
  roughly $\sqrt{1/N^\star}$ of its score versus the best-covered rival;
  bench-maxing via a single vanity bench is mathematically impossible.
- **One user can't carry a bench** — every Bench Score is also multiplied by
  $\sqrt{u(b)/U^\star}$ where $u(b)$ is the bench's net entityVote count and
  $U^\star$ is the leader's. A self-rated 100/100 vanity bench from a single
  account is worth $\sqrt{1/U^\star}$ of an established bench at the same
  Q·D·H — you'd need $U^\star$ separate accounts upvoting your bench just to
  tie. Same defence applies to the bench leaderboard ordering and to the
  bench's contribution to any model's SupraScore, so spawning a custom
  bench to pump one model is also blocked.
- **Single-model vanity benches don't count** — every Bench Score is
  *additionally* multiplied by $\sqrt{N(b)/N^\star}$ where $N(b)$ is the
  number of distinct models scored on the bench. A "community bench" used
  to test only the attacker's own model has $N(b)=1$ and thus contributes
  $\sqrt{1/N^\star}$ of the weight a well-used bench would. Combined with
  the upvote-share, a 1-rater + 1-model vanity bench is worth
  $\sqrt{1/(U^\star \!\cdot\! N^\star)}$ of an established peer — for an
  ecosystem with $U^\star = N^\star = 10$, that's $\approx 10\,\%$ of an
  established bench's weight.
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
The whole suite runs in **~1.5 s on CI** (66 tests total, 14 of them
adversarial). When the math regresses, a named test fails with a
descriptive message — instead of someone discovering the regression
on the production leaderboard.

```bash
npm test -- adversarial-robustness
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
| I3  | The bench at the maximum on **both** axes ($u_b\!=\!U^\star$ and $N_b\!=\!N^\star$) has `effectiveWeight == rawWeight` (no self-penalty) |
| I4  | Rankings table is sorted by `supraScore` (no row outranks the leader)            |
| I5  | Hidden benches do not appear in the public `listRanked` payload                  |
| I6  | Every model with at least one bench has `supraScore > 0`                         |
| I7  | Every BenchScore equals `rawWeight × √((u/U*)·(N/N*))` exactly (formula sanity)  |

### Layer 2 — Attack catalog

Each entry is a **concrete adversarial scenario** with a setup
function (seeds the dataset) and an `expect` predicate (asserts the
attacker's outcome). Every attack scenario also has to satisfy every
Layer-1 invariant — an attack that succeeds *and* breaks an invariant
counts as two regressions, not one.

| ID          | Scenario                                                                           | Status                |
| ----------- | ---------------------------------------------------------------------------------- | --------------------- |
| A1          | Self-rated vanity bench tries to claim **#1 on the bench leaderboard** (1 upvote, single account, $Q\!=\!100$)         | Defended by upvote √-share |
| A2          | Vanity bench used to vault attacker's model into top SupraScore (single self-scored bench)                              | Defended by both √-shares |
| A3          | **3-bench vanity stack** — 3 self-rated benches, all testing only the attacker's model, vs frontier-class legit ecosystem | Defended by combined math |
| A3-extreme  | **8-bench industrial vanity farm** — same shape, scaled up                          | **DOCUMENTED LIMITATION** — pure math overwhelmed; blocked operationally by rate-limit, community downvotes, anti-resurrection, moderation |
| A4          | Sockpuppet upvote attack — 3 fake accounts upvoting a vanity bench against an ecosystem with 8 legit voters per bench    | Defended (sockpuppet count $\ll U^\star$) |
| A5          | Single-bench peak attack — model with one $\mu\!=\!100$ vs a model with three $\mu\!=\!80$                              | Defended by model-side $\sqrt{W_m/W^\star}$ |
| A6          | Hidden vanity bench tries to leak its high `cachedNetUpvotes` into $U^\star$ / $N^\star$                                  | Defended (hidden benches excluded from maxima) |

`A3-extreme` deserves a closer look: the test **asserts the
limitation exists** (i.e. the attacker *does* outscore the top legit
model). If the math is ever strengthened enough to defeat 8-bench
vanity farms, this test fails with a message asking the next engineer
to either delete the case or raise its bench-count threshold and
re-document the new bound. We chose not to over-engineer the math
here because the same attack would require:

1. Creating 8 benches under one account (highly visible to moderation).
2. Submitting 8+ self-scores in 24 h — under the 30/day rate limit
   but still highly visible.
3. Hoping no one notices and downvotes them. As soon as $\geq 5$
   downvotes land, the bench is hidden and excluded from $U^\star$,
   $N^\star$, $W^\star$, and the leaderboard — the attack collapses.
4. Anti-resurrection then prevents re-creating the same benches under
   the same name.

The cost-benefit clearly favours legitimate contribution; the math
just doesn't have to do *all* the work.

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

## Public API (planned)

A paid HTTP API for routers / dashboards / observability tools is sketched
out — schema, endpoints, pricing tiers, Stripe activation steps and
Convex-cost analysis live in [`docs/api-roadmap.md`](docs/api-roadmap.md).
The placeholder implementations are in
[`convex/api.future.ts`](convex/api.future.ts) (HTTP routes, key
generation, rate limiting) and
[`convex/stripe.future.ts`](convex/stripe.future.ts) (Checkout,
billing portal, signed webhook). Not active yet.

**Tier shape lives in exactly one place:**
[`convex/tiers.ts`](convex/tiers.ts). Every other file (the
tier-cards in `public/index.html`, the API docs tables under
`public/docs/api/`, the roadmap markdown) mirrors quotas, RPM and
key counts from that file. **Prices are intentionally `null` /
"TBD" everywhere right now** — the API is finished and Stripe-wired,
but final pricing is collected via the waitlist before launch. The
real numbers will live in the Stripe dashboard (Products → recurring
Prices) and never in this repo: at checkout we send only the Stripe
Price ID and Stripe owns the amount/currency. To prevent drift,
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
the easier path is the public dataset, which the (planned)
[Public API](#public-api-planned) exposes directly. If you're
digging into the math, an install isn't required: `convex/rankings.ts`
is self-contained enough to reproduce against the dataset in any
language. For reproducibility or implementation questions, open an
issue on the [tracker](https://gitlab.com/florian-fischer-group/suprabench/-/issues) —
PRs are welcome too.

## Security model

The frontend, the Convex query/mutation handlers, and the planned HTTP API
are **all** designed to be safe with a fully public codebase:

- **No secrets in the repo.** Every secret (Google OAuth client ID/secret,
  JWT keys, the planned Stripe + webhook secrets) lives in
  `.env.local` (gitignored) for dev and in `npx convex env set` on the
  Convex deployment for production. The repo only references their *names*.
- **Authorization is server-side.** Every mutation re-checks
  `ctx.auth.getUserIdentity()` and the caller's role — the client is treated
  as fully untrusted. Rate limits, vote-once rules and the auto-hide
  thresholds are enforced in Convex, not in the UI.
- **Convex public URL is OK to be public.** The deployment URL in
  `public/js/convex.js` is the same kind of identifier as a Firebase
  project ID. Authentication still has to happen against it; an attacker
  knowing the URL gains nothing they couldn't get by visiting the live site.
- **Planned API.** Once enabled, the API uses hashed bearer keys
  (`sb_live_…`) generated in Convex, validated server-side on every
  request, with per-key tier-based rate limits and Stripe-driven
  subscription gating. See [`convex/api.future.ts`](convex/api.future.ts)
  and [`convex/stripe.future.ts`](convex/stripe.future.ts) — both are
  fully commented-out skeletons. Stripe webhook signatures are verified
  with `STRIPE_WEBHOOK_SECRET` (Convex env var, never in code).

If you spot anything that looks security-sensitive, please report it
privately via the email in [`/legal/imprint`](https://suprabench.ai/legal/imprint).

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
> exposed by the (planned) HTTP API. No deployment required.

Community-driven. No corporate influence.
