# SupraBench

**Community-driven AI model rankings based on benchmark trustworthiness.**

> Not all benchmarks are equal. SupraBench accounts for this by scoring each benchmark on 4 quality dimensions and weighting model scores accordingly.

---

## What is SupraBench?

SupraBench is a platform for ranking AI language models using a **meta-score** (SupraScore) that weights benchmark performance by the **trustworthiness of the benchmark itself**. The core insight: some benchmarks have poor real-world relevance, some are too easy, some are heavily contaminated by training data. SupraBench fixes this with community-driven quality ratings.

**Everything is community-driven**: users add models, add benchmarks, submit scores, and rate benchmark quality. There is no admin curation layer.

## How It Works

### The SupraScore

Each model's ranking is determined by a weighted average:

```
SupraScore(model) = Σ(benchQuality(b) × effectiveScore(model, b)) / Σ(benchQuality(b))
```

- **Bench Quality** (0–100): Average of community ratings across 4 dimensions (relevance, contamination resistance, discriminability, reproducibility), each rated 1–5.
- **Effective Score**: Median of all valid (upvoted > downvoted) normalized submissions for a model+bench pair.
- **Score Normalization**: Raw scores are mapped to 0–100 using each bench's original scale.

### Community Validation

Every submitted score requires a source URL. The community validates submissions via upvote/downvote — only submissions with more upvotes than downvotes count toward rankings.

### Official vs Community Benchmarks

Benchmarks are automatically classified as "Official" or "Community" based on their source URL domain (e.g., `lmsys.org`, `huggingface.co`, `arxiv.org` → Official).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | [Convex](https://convex.dev) — reactive, serverless |
| **Auth** | `@convex-dev/auth` with GitHub OAuth |
| **Frontend** | Vanilla HTML + [Alpine.js](https://alpinejs.dev) v3 (no React, no build step) |
| **Fonts** | [Clash Display](https://www.fontshare.com/fonts/clash-display) via Fontshare CDN |
| **Discussion** | GitHub Issues (no custom comment system) |

## Features

- **Model Rankings** — Global SupraScore leaderboard with tag-based filtering and filtered scores
- **Benchmark Index** — Quality-ranked benchmark directory with community ratings
- **Score Submission** — Single-page form to submit model scores with source verification
- **Benchmark Quality Ratings** — Rate benchmarks on relevance, contamination resistance, discriminability, and reproducibility
- **Community Voting** — Upvote/downvote individual score submissions
- **Tag Filtering** — Filter rankings by benchmark categories (coding, math, reasoning, etc.)
- **Anti-Gaming** — Rate limiting, vote deduplication, score range validation

## Project Structure

```
suprabench/
├── convex/                    # Convex backend
│   ├── schema.ts              # Database schema
│   ├── auth.ts                # GitHub OAuth setup
│   ├── models.ts              # Model queries & mutations
│   ├── benches.ts             # Benchmark queries & mutations
│   ├── submissions.ts         # Score submission logic
│   ├── votes.ts               # Voting system
│   ├── benchQualityRatings.ts # Quality rating system
│   └── tags.ts                # Tag aggregation
├── public/
│   ├── index.html             # Single-page app (all views)
│   ├── css/style.css          # Design system
│   └── js/
│       ├── app.js             # Alpine.js application
│       └── convex.js          # Convex client setup
├── package.json
└── .env.local                 # OAuth credentials
```

## Pages

| Route | Description |
|-------|-------------|
| `#models` (default) | Model ranking table with tag filtering |
| `#model/{slug}` | Model detail with per-bench scores |
| `#benches` | Benchmark quality ranking |
| `#bench/{slug}` | Benchmark detail with quality ratings & model scores |
| `#submit` | Contribute scores, models, and benchmarks |
| `#submission/{id}` | Individual submission detail |

## Getting Started

### Prerequisites

- Node.js 18+
- A [Convex](https://convex.dev) account
- A GitHub OAuth App

### Setup

1. Clone the repo and install dependencies:
   ```bash
   git clone https://github.com/flofischerpfuhl-stack/suprabench.git
   cd suprabench
   npm install
   ```

2. Set up Convex:
   ```bash
   npx convex init
   npx convex dev
   ```

3. Create a GitHub OAuth App:
   - Callback URL: `https://<your-convex-deployment>.convex.site/api/auth/callback/github`

4. Set environment variables in `.env.local`:
   ```
   AUTH_GITHUB_ID=your_github_client_id
   AUTH_GITHUB_SECRET=your_github_client_secret
   SITE_URL=http://localhost:5173
   JWT_PRIVATE_KEY=your_jwt_key
   ```

5. Deploy Convex and serve the frontend:
   ```bash
   npx convex dev
   # Serve public/ with any static server
   ```

## Anti-Gaming Rules

- **1 vote per user per submission** (toggle behavior)
- **1 quality rating per user per benchmark** (upsert)
- **Max 5 score submissions per user per 24 hours**
- **Score range validation** against benchmark scale
- **Source URL required** for all submissions

## License

[Business Source License 1.1](LICENSE)

Change Date: 2029-01-01 → Apache License 2.0

Community-driven. No corporate influence.
