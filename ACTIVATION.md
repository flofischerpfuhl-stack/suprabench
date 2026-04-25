# API + Billing activation runbook

Everything needed to take **Stripe-backed paid tiers** of the public
`/v1/*` API from dormant to live. The `/v1/*` endpoints themselves and
the invite-only Partner tier are **already live** (as of the "partner
tier activation" commit) — see *State today* below. Intended to be
followed top-to-bottom in one sitting; each step is idempotent enough
to re-run if something fails mid-flight.

## State today

### ✅ Already live

- **`/v1/*` endpoints** all answer requests on the production
  deployment (list models, model detail, benches, tags, best-by-tag,
  export). Routes registered in `convex/http.ts` via
  `registerApiRoutes`.
- **Partner tier** fully operational. Keys are minted via
  `npx convex run --prod partners:createPartnerKey` and work
  identically to paid-tier keys except that the auth middleware
  skips the Stripe subscription-liveness check for them. Partner
  tier is rendered on `/#profile` → API & Billing as a "Negotiated /
  Apply" card that opens a mailto: application.
- **Schema tables** `apiKeys`, `apiUsage`, `apiRateLimits`,
  `apiRequestLog`, `stripeCustomers`, `stripeSubscriptions`,
  `stripeEvents` are all uncommented in `convex/schema.ts`. The
  Stripe ones are empty because Stripe is still dormant, but they
  exist so `api.ts`'s `createKey` mutation (which references
  `stripeSubscriptions`) typechecks. Storage cost of empty tables
  is negligible.
- **Tier grid** (Starter / Pro / Enterprise / Enterprise+ / Partner)
  renders at `/#profile` → API & Billing tab with `TBD` pricing,
  `tierAction()` dispatcher, and `tierButtonLabel()` that switches
  between `Join waitlist` / `Subscribe` / `Current plan` / `Upgrade`
  / `Downgrade` depending on `apiLive` + `mySubscription`.
- **Frontend subscription dashboard** (HTML in `public/index.html`,
  gated behind `x-show="apiLive"`): "Your subscription" card, cancel-at-
  period-end banner, "Manage billing →" button, API-key list with
  revoke, "Create new key" button with browser-`prompt()` name input,
  and the one-time plaintext-reveal modal. CSS already ships in
  `public/css/style.css`; mobile-breakpoint rules at `max-width: 600px`
  handle row-wrapping + word-break on the key string.
- **Frontend Alpine methods** (all in `public/js/app.js`):
  `subscribe(tier)`, `manageBilling()`, `openCreateKeyModal()`,
  `revokeApiKey(id)`, `copyNewKey()`, `tierAction(tier)`,
  `tierButtonLabel(tier)`, `tierButtonDisabled(tier)`,
  `_handleStripeReturn()` (runs in `init()` — toasts + refetches on
  `?stripe=success|cancel`). All short-circuit when `apiLive=false`.
- **Frontend state loading**: `_loadProfile()` fetches
  `api.stripe.mySubscription` + `api.api.myKeys` in parallel when
  `apiLive=true`; auto-syncs `apiKeyLimit` to the subscribed tier's cap
  via `TIER_MAX_KEYS`.
- **Stripe Products + Prices** exist in Stripe (live mode). Their
  recurring Price IDs are already embedded in
  [`convex/stripe.future.ts`](convex/stripe.future.ts) under
  `PRICE_IDS`.
- **Stripe-backed paid-tier flow** fully written and code-reviewed —
  Checkout, Billing-Portal, webhook signature-verification,
  event fan-out, sub↔key cascade, `mySubscription` query — but sits
  inside a `/* ... */` block comment in `convex/stripe.future.ts`.
- **Waitlist flow** (backend + frontend) works end-to-end independently
  of `apiLive`. Paid-tier cards show "Join waitlist" until `apiLive`
  is flipped true (step 3 below).

### ❌ Deliberately not shipping until paid-tier activation

- **`convex/stripe.future.ts`** still dormant (export is `{}`, code
  inside block comment). No Stripe module loads.
- **Stripe HTTP routes**: `convex/http.ts` registers auth + API but
  not `registerStripeRoutes`. No `/stripe/webhook` endpoint exists,
  no `/stripe/checkout` HTTP action.
- **Webhook registration**: not created in Stripe. No Stripe events
  flow anywhere.
- **`apiLive` flag** in `public/js/app.js` is `false`. While this is
  false, `_loadProfile()` does not fetch `api.stripe.mySubscription`
  (which doesn't exist yet anyway), paid-tier cards show "Join
  waitlist" instead of "Subscribe", and the subscription dashboard
  is hidden. Partner keys still work end-to-end and **partners with
  `grantedTier` set on their user record can self-serve via
  `/#profile` → API & Billing** (the key list, "Create new key",
  copy/revoke flows are gated on `user.grantedTier`, not on
  `apiLive`). The CLI flow (`partners:createPartnerKey`) is still
  the supported provisioning path; the UI is the supported
  day-to-day-use path once a partner is granted.
- **Environment**: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
  are not set on prod.

Net effect: `/v1/*` answers authenticated partner requests, but
nobody can self-subscribe to Starter / Pro / Enterprise — three
independent locks remain (stripe.future.ts dormant, frontend flag
off, Stripe webhook unregistered). Each must be unlocked
deliberately for the paid-tier launch.

## Activation steps (paid tiers only; `/v1/*` and partner tier are already live)

### 1. Uncomment Stripe (≈2 min)

Only one file left:

- **`convex/stripe.future.ts`** — delete the top `export {};`, delete
  the outer `/* */` fence around the code, rename the file to
  `convex/stripe.ts`.

(`convex/api.ts` and `convex/partners.ts` are already live and have
no `.future.ts` counterpart anymore.)

### 2. Register Stripe HTTP routes (≈1 min)

Edit `convex/http.ts` — add the stripe import + call:

```ts
import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { registerApiRoutes } from "./api";
import { registerStripeRoutes } from "./stripe";

const http = httpRouter();
auth.addHttpRoutes(http);
registerApiRoutes(http);
registerStripeRoutes(http);   // ← add this line
export default http;
```

### 3. Flip the frontend flag (≈5 seconds)

In `public/js/app.js`, search for `apiLive: false,` and change to
`apiLive: true,`. That's it — the tier-card buttons, subscription
dashboard (it's not HTML-commented anymore, just `x-show="apiLive"`-
gated), `_loadProfile`'s subscription fetch, and all Stripe action
methods activate automatically. No other frontend changes required.

### 4. Set production secrets (≈2 min)

```bash
# Stripe live secret key (full or restricted with scopes for
# checkout.sessions.create, customers, billing_portal, webhook).
# DO NOT type this interactively in a Cursor-tracked terminal —
# pipe via stdin or use the clipboard + file trick. Better yet,
# run from a separate plain terminal that's not in an IDE session.
printf '%s\n' "$STRIPE_SK" | xclip -selection clipboard
# then:
npx convex env set --prod STRIPE_SECRET_KEY  # paste when prompted

# Placeholder — real value comes from step 6.
npx convex env set --prod STRIPE_WEBHOOK_SECRET whsec_placeholder

# The URL Stripe redirects users back to after Checkout / Billing-Portal.
npx convex env set --prod STRIPE_RETURN_URL https://suprabench.com/#profile
```

### 5. Deploy (≈2 min)

```bash
npm run check:tiers          # sanity: no drifted numbers
npx convex deploy --prod -y  # code + schema go live atomically
```

### 6. Register the Stripe webhook (≈2 min)

Stripe dashboard → **Developers** → **Webhooks** → **Add endpoint**:

- Endpoint URL: `https://<prod-deployment>.convex.site/stripe/webhook`
  (find exact subdomain in `npx convex env list --prod` — it's the
  `CONVEX_SITE_URL`).
- Events to send:
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_failed`
- Copy the signing secret (`whsec_...`) Stripe shows **once**, then
  replace the placeholder:
  ```bash
  npx convex env set --prod STRIPE_WEBHOOK_SECRET whsec_real_value
  ```

### 7. Smoke test (≈10 min)

1. Log in with a test account, go to Profile → API & Billing. The
   tier-card buttons should now read `Subscribe` instead of
   `Join waitlist` (except Enterprise+ which stays waitlist-only).
2. Click **Subscribe** on Starter. Verify:
   - browser redirects to `checkout.stripe.com`
   - Stripe shows the correct tier + live price
   - after completing checkout (cheap real-card payment OR
     test-mode `4242 4242 4242 4242`) you land on `/#profile?stripe=success`
   - a toast appears: "Subscription activated…"
   - the URL cleans up to `/#profile`
   - the "Your subscription" card shows `starter / active`
   - Convex dashboard → `stripeSubscriptions` has a new row
3. Click **Create new key**, give it a name. Verify:
   - plaintext modal appears with a fresh `sb_live_...` string
   - clicking "I've saved it" dismisses the modal
   - key list shows the new key with its `sb_live_xxxxxxxx` prefix
4. `curl` an endpoint:
   ```bash
   curl -H "authorization: Bearer sb_live_<the-plaintext>" \
        https://<deployment>.convex.site/v1/models | head
   ```
5. Click **Manage billing →**. Verify Stripe's portal opens. Cancel
   the sub inside the portal; return to the site; within ~5 s the
   dashboard should show `cancelAtPeriodEnd: true`.
6. Click **Revoke** on the key — confirms, then moves to `Revoked`.
7. Enterprise+ button should still say `Join waitlist`.
8. **Partner tier smoke test** (optional, only if you have another
   site to plug in):

   ```bash
   # Mint a partner key for your own dashboard:
   npx convex run --prod partners:createPartnerKey \
     '{"name":"mysite.com","ownerEmail":"me@mysite.com"}'

   # Copy the printed `plaintext`, save it in the partner site's
   # env (e.g. SUPRABENCH_API_KEY), then:
   curl -H "authorization: Bearer <that-key>" \
        https://<deployment>.convex.site/v1/models | head

   # Partner keys have no Stripe sub — should return 200 without
   # ever touching Stripe. If you see a 402 "subscription_inactive"
   # something is wrong with the partner-tier branch in convex/api.ts.

   # Revoke when done testing:
   npx convex run --prod partners:listPartnerKeys
   npx convex run --prod partners:revokePartnerKey '{"apiKeyId":"<id>"}'
   ```

### 8. Update the public docs (≈2 min)

- `public/docs/api/changelog.html` — add an "API live" entry at the
  top of the timeline.
- `public/index.html` ("Not yet" Q&A on the About page) — change the
  answer from "Not yet…" to "Live: see [docs →](/docs/api/)".
- Optionally: bump real prices into `convex/tiers.ts` (`priceUsd: null`
  → actual numbers) and the TBD cells in the tier grid,
  `docs/api-roadmap.md`, and `public/docs/api/index.html`.
  `npm run check:tiers` will fail until all are consistent.

## Rollback

If something's on fire:

```bash
# Flip the frontend flag off first — cheapest, instant.
# In public/js/app.js: apiLive: true → false
git commit -am "emergency: apiLive off"

# Revert the full activation commit if more is broken.
git revert HEAD~1
npx convex deploy --prod -y
```

Existing subscribers' cards are NOT charged again during a revert —
Stripe's billing engine is independent of our code. They'll get emails
from Stripe (invoices) even if our `/v1/*` is down. Refund from the
Stripe dashboard if needed. The webhook endpoint can stay registered
— Convex will 404 it and Stripe stops retrying after ~3 days.
