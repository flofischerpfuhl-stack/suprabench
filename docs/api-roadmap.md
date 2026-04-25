# Public API — Roadmap

> **Status (April 2026):** the `/v1/*` HTTP routes in
> [`convex/api.ts`](../convex/api.ts) are **LIVE** and answering
> requests for invited **Partner** keys (minted via
> [`convex/partners.ts`](../convex/partners.ts)). The schema tables
> in [`convex/schema.ts`](../convex/schema.ts) (`apiKeys`, `apiUsage`,
> `apiRateLimits`, `apiRequestLog`) are deployed and live.
>
> **Paid self-serve tiers** (Starter / Pro / Enterprise) are
> **demand-gated** — the implementation is finished, but the Stripe
> billing layer in [`convex/stripe.future.ts`](../convex/stripe.future.ts)
> stays behind a `.future` fence until the waitlist hits launch
> threshold. The waitlist itself
> ([`convex/waitlist.ts`](../convex/waitlist.ts)) is live so we
> measure demand.

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
| `GET /v1/models` | ranked models with `supraScore`, `provider`, tags, `benchCount` | 5 min | starter |
| `GET /v1/models/{slug}` | model detail incl. per-bench scores | 5 min | starter |
| `GET /v1/benches` | benches with `qualityScore`, dimensions, `modelCount` | 5 min | starter |
| `GET /v1/tags` | all known tags with counts | 1 h | starter |
| `GET /v1/best?tag=…` | top-N models filtered by tag | 5 min | starter |
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
**Prices are TBD until launch** — the waitlist is how we figure out
what each tier should actually cost. Quotas, RPM and key counts are
the part of the tier shape that's locked.

> **Single source of truth:** these numbers (and the pending price
> column) are mirrored from [`convex/tiers.ts`](../convex/tiers.ts)
> — that file is the only place to edit them.
> `scripts/check-tier-consistency.mjs` runs in CI and will fail the
> build if this table drifts. When we set real prices we update
> `tiers.ts` and the `TBD` cells here in the same commit.

| Tier | $ / month (USD) | Requests / month | RPM | Max keys | Endpoints | Use-case |
|---|---|---|---|---|---|---|
| **Starter** | TBD | 10 000 | 60 | 1 | all read endpoints, no `/export` | indie router / personal dashboard |
| **Pro** | TBD | 100 000 | 300 | 3 | + `/export.json` daily | small AI startup |
| **Enterprise** | TBD | 1 000 000 | 1 200 | 10 | + priority queue (planned) | observability vendor |
| **Enterprise+** | custom | custom | custom | 50+ | + SLA, on-prem snapshot drops | hyperscaler / lab |
| **Partner** *(invite-only)* | **$0** | Negotiated | Negotiated | 1 | all read endpoints + `/export.json` | my own other web properties, friendly OSS / non-profit / research projects |

Billing currency at launch will be USD (global default for developer APIs).
Stripe Tax adds EU VAT automatically at checkout for B2C / non-VAT-ID
customers; B2B reverse-charge is supported when the buyer provides a
valid VAT-ID.

## Partner tier (invite-only, free)

I run more than one website that integrates SupraBench data, and
friends / OSS maintainers occasionally want read access for a small
dashboard. Paying myself through Stripe just to get at my own API is
silly, and carving out per-IP exceptions at the CDN would drift
quickly. The `partner` tier is the clean solution:

- **Appears in the public tier grid** as a separate "Negotiated /
  Apply" card with a mailto: CTA, *but* `PUBLIC_TIERS` in
  `convex/tiers.ts` excludes it, and the public `createKey` mutation
  hard-rejects requests with `tier === "partner"` (see `convex/api.ts`,
  `isPubliclySubscribable === false`). A signed-in user hitting the
  Apply button gets an email draft, not a self-mint form.
- **Keys are minted only via CLI** — `npx convex run partners:createPartnerKey
  '{"name":"mysite.com"}'` (see `convex/partners.ts`). That requires
  Convex deployment credentials, so nothing on the public internet
  can provision one.
- **Auth middleware skips the Stripe check** for partner keys (the
  tier has no subscription attached). Rate limiting + monthly quota
  + audit log all still apply — a leaked partner key can't run away
  because it hits the per-minute sliding window.
- **Quota and rate limit are negotiated case-by-case**, not
  advertised. The tier card deliberately prints "Negotiated" instead
  of numbers. `PARTNER_DEFAULTS` in `convex/tiers.ts` (100 k/month,
  300 rpm, 1 key) is only a fallback used when the CLI mints a key
  without explicit `--quota` / `--rpm` flags. Hard cap is 1 M/month;
  beyond that the partner should apply for `enterprise_plus`
  instead.
- **Revocation** is the same soft-revoke as paid keys:
  `partners:revokePartnerKey`. The apiKeys row is kept with
  `revokedAt` set, so the audit log still points back to a real row.

This deliberately does NOT implement origin binding (i.e. "key only
works when Referer matches partner.example.com"). Origin spoofing is
trivial from any non-browser client, so enforcing it would give a
false sense of security without slowing down real abuse. If a key
gets leaked, we revoke and re-issue — same response as for paid keys.

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
would absorb that liability). For the per-seat SaaS price points we're
targeting this is fine; revisit if we hit MOSS-relevant volumes.

### Stripe setup checklist (when activating)

1. Stripe dashboard → Products → create three Products: "SupraBench
   API — Starter / Pro / Enterprise". Each with one *recurring*
   monthly Price. (Enterprise+ is manual invoicing, no Stripe Product.)
2. Copy the three `price_…` IDs into `PRICE_IDS` in
   `convex/stripe.future.ts`.
3. `npx convex env set STRIPE_SECRET_KEY sk_live_…`
4. Stripe → Developers → Webhooks → add endpoint
   `https://<deployment>.convex.site/stripe/webhook` listening to:
   - `checkout.session.completed`
   - `customer.subscription.{created,updated,deleted}`
   - `invoice.payment_failed`
5. `npx convex env set STRIPE_WEBHOOK_SECRET whsec_…`
6. `npx convex env set STRIPE_RETURN_URL https://suprabench.com/#profile`
7. Enable Stripe Tax for EU compliance.

## Activation steps

The schema tables, HTTP routes, key validation, rate limiting,
quota tracking, audit logging and the cron-based cleanup are all
**already live in production** for Partner keys. The only piece
that still needs to be activated is **Stripe-backed billing** for
the paid Starter / Pro / Enterprise tiers. To flip those on:

1. **Stripe code** — un-fence the file: rename
   [`convex/stripe.future.ts`](../convex/stripe.future.ts) →
   `convex/stripe.ts`, drop the leading `export {};`, and uncomment
   the body. The TIERS / Tier imports already match
   [`convex/tiers.ts`](../convex/tiers.ts) so no rewiring needed.
2. **Stripe dashboard** — create three recurring monthly Products
   (Starter / Pro / Enterprise), each with one Price. Copy the
   `price_…` IDs into `PRICE_IDS` in `convex/stripe.ts`.
3. **Convex env** —
   ```bash
   npx convex env set STRIPE_SECRET_KEY sk_live_…
   npx convex env set STRIPE_WEBHOOK_SECRET whsec_…
   npx convex env set STRIPE_RETURN_URL https://suprabench.com/#profile
   ```
4. **Stripe webhook** — add endpoint
   `https://<deployment>.convex.site/stripe/webhook` listening to
   `checkout.session.completed`,
   `customer.subscription.{created,updated,deleted}`,
   `invoice.payment_failed`.
5. **Wire HTTP routes** — in `convex/http.ts` add:
   ```ts
   import { registerStripeRoutes } from "./stripe";
   registerStripeRoutes(http);
   ```
6. **Frontend** — the `/#profile` → API tab already renders the
   tier-grid + key dashboard. Wire the per-tier "Subscribe" buttons
   to `stripe:createCheckout({tier})` and the "Manage billing"
   button to `stripe:createBillingPortalSession`.
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
