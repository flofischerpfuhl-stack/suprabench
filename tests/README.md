# SupraBench API Test Suite

All-encompassing tests for the public `/v1/*` API documented at
<https://suprabench.com/docs/api/>. The suite covers **every endpoint
shown in the docs**, in **every client language shown in the docs**
(`curl`, Python, JavaScript, Go).

## Layout

```
tests/
├── README.md                        (this file)
├── convex/                          unit-ish tests via convex-test
│   ├── package.json
│   ├── vitest.config.ts
│   └── *.test.ts
└── integration/                     HTTP tests in each supported language
    ├── run-all.sh                   run every language in sequence
    ├── curl/
    │   └── test.sh
    ├── python/
    │   ├── requirements.txt
    │   └── test_api.py              pytest
    ├── javascript/
    │   ├── package.json
    │   └── test.mjs                 node:test (no extra deps)
    └── go/
        ├── go.mod
        └── api_test.go
```

## Two test layers

### 1. `tests/convex/` — unit/integration via `convex-test`

Runs the real Convex runtime in-process, seeds a synthetic dataset,
calls queries / mutations / HTTP actions directly, asserts on the
result. **No live deployment needed.**

Covers:

- Authentication middleware (missing / malformed / revoked / invalid
  tokens, partner-tier Stripe-skip, subscription-inactive).
- Every public HTTP endpoint returns the documented shape + `content-
  type` + `cache-control` headers.
- Tier enforcement (`allowExport`, per-tier quota, per-minute
  sliding window).
- Quota-increment atomicity and month-boundary rollover.
- `publicListModels` tag filtering, limit clamping (1 – 500).
- Error codes match the docs (`missing_token`, `invalid_token`,
  `revoked`, `subscription_inactive`, `rate_limited`, `quota_exceeded`,
  `tier_forbidden`, `not_found`, `bad_request`, `internal`).
- `partners:*` CLI mutations — create / list / update / revoke /
  duplicate-name guard.
- `api:createKey` rejects non-public tiers (partner cannot be
  self-minted).

Run:

```bash
cd tests/convex
npm install
npm test
```

### 2. `tests/integration/` — end-to-end HTTP

Hits a running Convex deployment over real HTTPS. Used for:

- Verifying the docs' copy-paste snippets actually work. If a
  Python snippet in `public/docs/api/quickstart.html` says
  `requests.get(...)`, a near-identical call appears in
  `tests/integration/python/test_api.py`.
- Smoke-testing after production deploys.
- Benchmarking latency per endpoint (the Python + Go suites print
  timings).

Each language suite reads two env vars:

| Env var | Default | Meaning |
|---|---|---|
| `SUPRABENCH_API_BASE` | (required) | `https://<deployment>.convex.site` |
| `SUPRABENCH_API_KEY`  | (required) | a valid `sb_live_…` token |

Optionally:

| Env var | Default | Meaning |
|---|---|---|
| `SUPRABENCH_API_EXPORT_KEY` | falls back to `SUPRABENCH_API_KEY` | A Pro+ key that can hit `/v1/export.json` |
| `SUPRABENCH_API_SKIP_RATE_LIMIT` | `false` | Skip the rate-limit flood test (takes ~30 s) |

Run everything:

```bash
export SUPRABENCH_API_BASE=https://<deployment>.convex.site
export SUPRABENCH_API_KEY=sb_live_xxxxx…
bash tests/integration/run-all.sh
```

Run one language:

```bash
bash tests/integration/curl/test.sh
pytest tests/integration/python
node --test tests/integration/javascript
go test ./tests/integration/go/...
```

## What's NOT tested here

- Stripe webhook / subscription lifecycle: has its own dedicated test
  flow in Stripe's CLI (`stripe trigger customer.subscription.created`),
  not in this HTTP suite.
- Frontend Alpine / HTML: this suite is public-API only.
- Submission mutations (`submitOne`, `submitForBench`, `submitForModel`):
  those are gated by Google OAuth sessions, not API keys, and have
  their own human-QA pass.

## Requirements when the API isn't activated yet

If `apiLive=false` in `public/js/app.js` and the schema's `apiKeys`
table is still commented out (see `ACTIVATION.md`), **these tests
will fail to even start** — the imports target code that doesn't
exist in the deployed runtime. They are designed to run **after**
the activation steps.

During the dormant period, the suite is still useful as an
executable specification: reviewers can read
`tests/convex/endpoints.test.ts` to understand exactly what the API
promises to do.
