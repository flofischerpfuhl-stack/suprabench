# SupraBench

**Community-driven AI model rankings based on benchmark trustworthiness.**

> Not all benchmarks are equal. SupraBench scores each benchmark on five quality
> dimensions, applies an automatic saturation penalty, and weights model scores
> accordingly — so a single number per model respects how trustworthy and how
> informative each underlying benchmark actually is.

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

## Getting Started

### Prerequisites

- Node.js 18+
- A [Convex](https://convex.dev) account
- A Google Cloud project with OAuth 2.0 credentials

### Setup

1. Clone and install:
   ```bash
   git clone https://gitlab.com/florian-fischer-group/suprabench.git
   cd suprabench
   npm install
   ```

2. Provision a Convex deployment:
   ```bash
   npx convex dev
   ```
   The first run links / creates a deployment and writes `CONVEX_DEPLOYMENT`
   into `.env.local`.

3. Create a Google OAuth client at
   [console.cloud.google.com](https://console.cloud.google.com/apis/credentials):
   - Authorized redirect URI:
     `https://<your-convex-deployment>.convex.site/api/auth/callback/google`

4. Set environment variables in `.env.local`:
   ```
   AUTH_GOOGLE_ID=your_google_client_id
   AUTH_GOOGLE_SECRET=your_google_client_secret
   SITE_URL=http://localhost:5173
   JWT_PRIVATE_KEY=your_jwt_key
   ```

5. Serve the frontend (any static server works):
   ```bash
   npx serve public        # or python -m http.server, etc.
   ```
   Keep `npx convex dev` running in another terminal.

### Deploying to production

```bash
npm run deploy                                # = npx convex deploy
npx convex run --prod migrations:backfillAll  # only after schema changes
```

The static `public/` directory can be hosted on Cloudflare Pages, Netlify,
Vercel, or any CDN — there is no build step.

## License

[Business Source License 1.1](LICENSE)

Change Date: 2029-01-01 → Apache License 2.0

Community-driven. No corporate influence.
