# Public API — Roadmap

> **Status:** designed but not active. Code lives commented-out in
> [`convex/api.future.ts`](../convex/api.future.ts) and
> [`convex/stripe.future.ts`](../convex/stripe.future.ts), with the
> corresponding tables commented in [`convex/schema.ts`](../convex/schema.ts).
> Activate when there's demonstrated demand.

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

| Endpoint | Returns | Cache TTL | Min tier |
|---|---|---|---|
| `GET /v1/models` | ranked models with `supraScore`, `provider`, tags, `benchCount` | 5 min | hobby |
| `GET /v1/models/{slug}` | model detail incl. per-bench scores | 5 min | hobby |
| `GET /v1/benches` | benches with `qualityScore`, dimensions, `modelCount` | 5 min | hobby |
| `GET /v1/tags` | all known tags with counts | 1 h | hobby |
| `GET /v1/best?tag=…` | top-N models filtered by tag | 5 min | hobby |
| `GET /v1/export.json` | full snapshot, JSON | 24 h | **pro** |

Auth: bearer token in `Authorization` header. Tokens look like
`sb_live_<64 hex chars>`, are SHA-256-hashed at rest, shown to the
user exactly once on creation.

Rate-limit per key:
- per-month quota (hard cap, returns 429 `quota_exceeded`)
- per-minute sliding window (returns 429 `rate_limited`, retry after 60s)

Subscription liveness check: every request looks at the cached
`stripeSubscriptionStatus` mirrored from Stripe; non-`active`/`trialing`
subs return 402 `subscription_inactive`.

## Pricing

No free tier (per the original brief). Three paid tiers + custom enterprise.

| Tier | €/month | Requests/month | RPM | Endpoints | Use-case |
|---|---|---|---|---|---|
| **Hobby** | 7 | 5 000 | 60 | all read endpoints, no `/export` | indie router / personal dashboard |
| **Pro** | 19 | 50 000 | 200 | + `/export.json` daily | small AI startup |
| **Scale** | 59 | 500 000 | 600 | + priority queue (planned) | observability vendor |
| **Enterprise** | custom | custom | custom | + SLA, on-prem snapshot drops | hyperscaler / lab |

## Payment: Stripe

Why Stripe over Lemon Squeezy / Polar:
- We're already routing through Cloudflare in front of Convex; Stripe's
  webhook signing + retry semantics integrate cleanly with HTTP actions.
- EU VAT handling: Stripe Tax (toggle `automatic_tax: true` on
  Checkout, ~0.5 % per transaction). Done.
- Customer Billing Portal is a hosted page — no UI to build for
  card updates / cancel / invoice download.
- Wide language SDK support if we add a Python helper later.

Tradeoff: we collect VAT but are the merchant of record (Lemon Squeezy
would absorb that liability). For €7–€60 SaaS this is fine; revisit
if we hit MOSS-relevant volumes.

### Stripe setup checklist (when activating)

1. Stripe dashboard → Products → create three Products: "SupraBench
   API — Hobby / Pro / Scale". Each with one *recurring* monthly Price.
2. Copy the three `price_…` IDs into `PRICE_IDS` in
   `convex/stripe.future.ts`.
3. `npx convex env set STRIPE_SECRET_KEY sk_live_…`
4. Stripe → Developers → Webhooks → add endpoint
   `https://<deployment>.convex.site/stripe/webhook` listening to:
   - `checkout.session.completed`
   - `customer.subscription.{created,updated,deleted}`
   - `invoice.payment_failed`
5. `npx convex env set STRIPE_WEBHOOK_SECRET whsec_…`
6. `npx convex env set STRIPE_RETURN_URL https://suprabench.com/#api`
7. Enable Stripe Tax for EU compliance.

## Activation steps

In order:

1. **Schema** — uncomment the `apiKeys`, `apiUsage`, `apiRateLimits`,
   `apiRequestLog`, `stripeCustomers`, `stripeSubscriptions`,
   `stripeEvents` blocks at the bottom of `convex/schema.ts`.
2. **API code** — uncomment everything inside
   `convex/api.future.ts`, drop the leading `export {};`, and rename
   to `convex/api.ts`.
3. **Stripe code** — same with `convex/stripe.future.ts` →
   `convex/stripe.ts`.
4. **Wire HTTP routes** — in `convex/http.ts`:
   ```ts
   import { registerApiRoutes } from "./api";
   import { registerStripeRoutes } from "./stripe";
   registerApiRoutes(http);
   registerStripeRoutes(http);
   ```
5. **Cron** — add `convex/crons.ts` (if missing) with an hourly call
   to `internal.api.cleanupOldData` so the audit log + rate-limit
   buckets don't grow forever.
6. **Frontend** — add an `/#api` view with:
   - "Subscribe" buttons → call `stripe:createCheckout({tier})`,
     redirect to returned URL
   - "Manage billing" → calls `stripe:createBillingPortalSession`
   - List keys (calls `api:myKeys`), create / revoke buttons
   - Usage chart (calls `api:myKeyUsage`)
7. `npx convex deploy --yes`, then trigger a Stripe test event:
   `stripe trigger customer.subscription.created`.

## Spam / abuse prevention

- Hard rate-limit per API key (sliding window, Convex query)
- Subscription cancellation → keys auto-revoke via webhook cascade
- Keys hashed at rest; revocation = single mutation
- Audit log (last 30 days, capped at ~1000/key) so users can self-debug
- Per-IP fallback rate-limit for unauthenticated requests at the
  Cloudflare layer (out of scope for v1)

## Why no free tier

The user explicitly asked for this and the rationale holds up: the
addressable market is small (a few hundred AI infra teams worldwide),
each user needs few requests (a routing decision once per minute is
plenty), so unit economics demand a higher per-call price. A free
tier would attract scrapers without revenue and inflate Convex
bandwidth costs.

## Convex implementation cost

- **Compute**: cheap. The data is already aggregated in `modelRankings`
  + `benches.cached*` after the perf pass, so endpoints are
  near-zero-work index lookups.
- **Bandwidth**: each `/v1/models` response is ~30 KB JSON. With
  5-minute Cache-Control and clients honoring it, even 100 000
  req/month is < 100 MB of egress.
- **Storage**: API keys + usage buckets + 30-day request log.
  Negligible (< 1 MB until ≫1k active keys).

Build effort: ~2 days for v1 (HTTP actions + key table + Stripe
webhook + dashboard).

## Open questions before building

1. Brand: separate subdomain `api.suprabench.com` (Cloudflare Worker
   in front, edge-cached) or path-based via Convex's `*.convex.site`?
   Edge caching only meaningfully cuts cost on the subdomain route.
2. Versioning policy — break v1, or keep v1 + add v2? Default: keep
   v1 forever, add v2 alongside.
3. Snapshot/export format: JSON (easy) or Parquet (smaller, BI-friendly)?
4. Webhook for "new model added": worth offering, or YAGNI?
5. Bring-your-own Stripe instance for enterprise (private label)? Probably YAGNI.
