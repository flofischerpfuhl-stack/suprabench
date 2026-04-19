# SupraBench

**Community-driven AI model rankings based on benchmark trustworthiness.**

> Not all benchmarks are equal. SupraBench scores each benchmark on five quality
> dimensions, applies an automatic saturation penalty, and weights model scores
> accordingly — so a single number per model respects how trustworthy and how
> informative each underlying benchmark actually is.

> **This repository is open for transparency, not for redeployment.** The full
> codebase is published so anyone can audit the SupraScore math, the
> anti-gaming rules, the official-source whitelist and the moderation logic
> end-to-end. Running your own copy as a competing public service is
> **not permitted** — see [License](#license). If you want to *use* SupraBench,
> visit [suprabench.ai](https://suprabench.ai).

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
SupraScore(m)   = Σ_b μ(m,b) · BenchScore(b)  /  Σ_b BenchScore(b)
BenchScore(b)   = Q(b) · D(b) · H(b)          ∈ [0, 100]
```

- **Bench Score** $\operatorname{BenchScore}(b) \in [0,100]$ — the bench's
  contribution to a model's SupraScore, and the headline number shown for
  each bench in the UI. It's the multiplicative product of the three factors
  below; the natural range is $[0,100]$ because difficulty and headroom are
  both already on $[0,1]$.
- **Quality** $Q(b) \in [0,100]$ — mean of community ratings on relevance,
  contamination resistance, discriminability, reproducibility, then ×20.
- **Difficulty** $D(b) \in [0,1]$ — median rater difficulty, scaled
  $((d-1)/4)$.
- **Headroom** $H(b) \in [0.1,1]$ — automatic saturation penalty: shrinks as
  the top-K models converge on 100 %, with a floor at 0.1 so historic benches
  never disappear.
- **Per-(model, bench) score** $\mu_{m,b}$ — median of all valid (net-positive
  vote) normalised submissions, robust to a single outlier.

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
| Discussion | None yet — planned via Giscus once GitHub integration is possible |

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
  weighted by trust × difficulty × headroom
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

There is **no setup guide** here on purpose. The license permits
non-commercial use (research, audit, local reproduction) but not running
this codebase as a competing public service, so an install script would
mostly steer people toward something they can't ship. If you want to
verify a number, the public dataset is the easier path — see
[Public API](#public-api-planned). For genuine reproducibility questions,
open an issue on the [tracker](https://gitlab.com/florian-fischer-group/suprabench/-/issues).

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

[Business Source License 1.1](LICENSE)

- **Change Date:** 2029-01-01 → converts to Apache License 2.0.
- **Permitted, no permission needed:** reading the code, auditing the
  math, running it locally for verification, using it for evaluating
  AI models or deriving benchmarks, contributing patches, and any
  non-commercial use (copy, modify, create derivative works, redistribute).
- **Requires explicit permission from the Licensor:** commercial use,
  including running this codebase as a competing public service.

> Tip for the curious: the simplest path to verify the SupraScore
> independently is to reproduce the math from
> [`convex/rankings.ts`](convex/rankings.ts) against the public dataset
> exposed by the (planned) HTTP API. No deployment required.

Community-driven. No corporate influence.
