# Contributing to SupraBench

## How to Contribute

SupraBench is fully community-driven. There are several ways to contribute:

### 1. Submit Model Scores

The primary way to contribute is by submitting benchmark scores for AI models:

1. Go to the **Contribute** page
2. Log in with your GitHub account
3. Select or create a benchmark
4. Select or create a model
5. Enter the score with a source URL
6. Submit — the community will validate through voting

### 2. Rate Benchmarks

Help the community assess benchmark quality by rating benchmarks on 4 dimensions:

- **Relevance**: How well does this benchmark reflect real-world capability?
- **Contamination Resistance**: How resistant is this benchmark to training data contamination?
- **Discriminability**: How well does this benchmark separate good models from bad ones?
- **Reproducibility**: Can this benchmark be run independently?

Each dimension is rated 1–5 on the benchmark detail page.

### 3. Vote on Submissions

Every score submission can be upvoted or downvoted. Submissions with more downvotes than upvotes are marked as "disputed" and excluded from ranking calculations.

### 4. Add Tags

Help categorize benchmarks by adding tags on benchmark detail pages.

## Anti-Gaming Rules

- Max 5 score submissions per user per 24 hours
- One vote per user per submission
- One quality rating per user per benchmark
- Source URL is required for all submissions
- Scores must be within the benchmark's defined scale range

## Tech Stack

- **Backend**: Convex (serverless, reactive)
- **Auth**: GitHub OAuth via `@convex-dev/auth`
- **Frontend**: HTML + Alpine.js (no React, no build step)

## Development Setup

```bash
npm install
npx convex dev
# Serve public/ with any static file server
```

## License

BSL 1.1 — see [LICENSE](LICENSE) for details.
