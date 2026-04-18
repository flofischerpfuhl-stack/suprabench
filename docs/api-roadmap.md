# Public API — Roadmap

> **Status:** not implemented yet. Sketch + commented placeholder code in
> [`convex/api.future.ts`](../convex/api.future.ts). Activate when there's
> demonstrated demand.

## Why an API at all

Routing/eval/observability tools (helicone, openrouter, traceloop,
laminar, …) and "best LLM today" dashboards regularly need an
authoritative, weighted ranking of models per benchmark / task family.
SupraBench has it, and the data is already aggregated server-side.

A paid API:

1. covers the marginal cost of serving ranking traffic to non-browser clients,
2. funds Convex bandwidth headroom so the public site stays fast,
3. signals seriousness (paid customers > free leeches who churn).

## What it should expose

| Endpoint | Returns | Cache TTL |
|---|---|---|
| `GET /v1/models` | ranked models with `supraScore`, `provider`, tags, `benchCount` | 5 min |
| `GET /v1/models/{slug}` | model detail incl. per-bench effective score | 5 min |
| `GET /v1/benches` | benches with `qualityScore`, dimensions, `modelCount` | 5 min |
| `GET /v1/benches/{slug}` | bench detail incl. all submissions | 5 min |
| `GET /v1/tags` | all known tags with counts | 1 h |
| `GET /v1/best?tag=…` | top-N models filtered by tag (= `listRankedWithFilter`) | 5 min |
| `GET /v1/export.json` | full snapshot (paid tier only) | 24 h |

Auth: bearer token in `Authorization` header. Rate-limit per key in a
sliding window using a small Convex table.

## Pricing

No free tier (per request). Three paid tiers + custom enterprise.

| Tier | €/month | Requests/month | Endpoints | Use-case |
|---|---|---|---|---|
| **Hobby** | 7 | 5 000 | all read endpoints, no `/export` | indie router / personal dashboard |
| **Pro** | 19 | 50 000 | all read endpoints + `/export` daily | small AI startup |
| **Scale** | 59 | 500 000 | + priority queue, 2 keys | observability vendor |
| **Enterprise** | custom | custom | + SLA, on-prem snapshot drops | hyperscaler / lab |

Payment: [Lemon Squeezy](https://www.lemonsqueezy.com/) or
[Polar](https://polar.sh/) (both handle EU MOSS / VAT for you, much
simpler than Stripe direct).

## Spam / abuse prevention

- Hard rate-limit per API key (sliding window, Convex query)
- Per-IP fallback rate-limit for unauthenticated requests (returns 401 with hint)
- No public listing of API keys; revocation is a single mutation
- Logs (last 1000 calls per key) so users can self-debug

## Why no free tier

The user explicitly asked for this and the rationale holds up: the addressable market is small (a few hundred AI infra teams worldwide), each user needs few requests (a routing decision once per minute is plenty), so unit economics demand a higher per-call price. A free tier would attract scrapers without revenue and inflate Convex bandwidth costs.

## Convex implementation cost

- **Compute**: cheap. The data is already aggregated in `modelRankings` + `benches.cached*` after the perf pass.
- **Bandwidth**: each `/v1/models` response is ~30 KB JSON. With 5-minute caching at the edge (or a `tagCounts`-style cache row holding the JSON blob), even 100 000 req/month is < 100 MB of egress.
- **Storage**: API keys table + per-key request log. Negligible (< 1 MB).

Build effort: ~1–2 days for v1 (HTTP actions + key table + Lemon Squeezy webhook).

## Open questions before building

1. Brand: separate subdomain `api.suprabench.ai` or path-based `/api/v1`?
2. Versioning policy — break v1, or keep v1 + add v2?
3. Snapshot/export format: JSON (easy) or Parquet (smaller, BI-friendly)?
4. Webhook for "new model added": worth offering, or YAGNI?
