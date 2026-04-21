# API + Billing activation runbook

Everything needed to take the public `/v1/*` API + Stripe billing from
**dormant-but-wired** to **live** on suprabench.com. Intended to be
followed top-to-bottom in one sitting; each step is idempotent enough
to re-run if something fails mid-flight.

## State today

### ✅ Fully written and shipping now

- **Tier grid** (Starter / Pro / Enterprise / Enterprise+) renders at
  `/#profile` → API & Billing tab with `TBD` pricing, `tierAction()`
  dispatcher, and `tierButtonLabel()` that switches between `Join
  waitlist` / `Subscribe` / `Current plan` / `Upgrade` / `Downgrade`
  depending on `apiLive` + `mySubscription`.
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
- **Backend implementations** fully written and code-reviewed — every
  endpoint in `/docs/api/`, the rate limiter, the quota enforcer, the
  auth layer, Checkout, Billing-Portal, webhook signature-verification,
  event fan-out, sub↔key cascade, `mySubscription` query — but sit
  inside `/* ... */` block comments in `convex/api.future.ts` and
  `convex/stripe.future.ts`.
- **Waitlist flow** (backend + frontend) works end-to-end independently
  of `apiLive`.

### ❌ Deliberately not shipping until activation

- **Schema tables**: `apiKeys`, `apiUsage`, `apiRateLimits`,
  `apiRequestLog`, `stripeCustomers`, `stripeSubscriptions`,
  `stripeEvents` are commented out in `convex/schema.ts`. Convex
  therefore cannot store any of this yet.
- **HTTP routes**: `convex/http.ts` only registers `auth`. No `/v1/*`
  endpoints and no `/stripe/webhook` endpoint exist.
- **Webhook registration**: not created in Stripe. No Stripe events
  flow anywhere.
- **`apiLive` flag** in `public/js/app.js` is `false`.
- **Environment**: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
  are not set on prod.

Net effect: nobody can subscribe and nobody can call `/v1/*`. Four
independent locks are closed (frontend flag, commented code, missing
schema, missing webhook). Each must be unlocked deliberately.

## Activation steps

### 1. Uncomment the backend (≈3 min)

Three files, mechanical:

- **`convex/schema.ts`** — uncomment the `apiKeys`, `apiUsage`,
  `apiRateLimits`, `apiRequestLog`, `stripeCustomers`,
  `stripeSubscriptions`, `stripeEvents` tables. Grep for `// API` and
  `// Stripe` section headers.
- **`convex/api.future.ts`** — delete the top `export {};`, delete the
  outer `/* */` fence around the code, rename the file to
  `convex/api.ts`.
- **`convex/stripe.future.ts`** — same, rename to `convex/stripe.ts`.

### 2. Register HTTP routes (≈1 min)

Edit `convex/http.ts`:

```ts
import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { registerApiRoutes } from "./api";
import { registerStripeRoutes } from "./stripe";

const http = httpRouter();
auth.addHttpRoutes(http);
registerApiRoutes(http);
registerStripeRoutes(http);
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
npx convex env set --prod STRIPE_RETURN_URL https://suprabench.ai/#profile
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
