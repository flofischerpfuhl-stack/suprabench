# API + Billing activation runbook

Everything needed to take the public `/v1/*` API + Stripe billing from
**dormant-but-wired** to **live** on suprabench.com. Intended to be
followed top-to-bottom in one sitting; each step is idempotent enough
to re-run if something fails mid-flight.

## State today

- ✅ **Tier grid** (Starter / Pro / Enterprise / Enterprise+) renders at
  `/#profile` → API & Billing tab with `TBD` pricing and waitlist
  join/leave wired end-to-end (frontend + Convex `waitlist.ts`).
- ✅ **Stripe Products + Prices** exist in Stripe (live mode). Their
  recurring Price IDs are already embedded in
  [`convex/stripe.future.ts`](convex/stripe.future.ts) under
  `PRICE_IDS`.
- ✅ **Full API implementation** is written and code-reviewed — every
  endpoint in `/docs/api/`, the rate limiter, the quota enforcer, the
  auth layer — but sits inside one big block comment in
  [`convex/api.future.ts`](convex/api.future.ts).
- ✅ **Full Stripe implementation** (Checkout, Billing-Portal, webhook
  signature-verification, event fan-out, sub↔key cascade) sits
  block-commented in [`convex/stripe.future.ts`](convex/stripe.future.ts).
- ✅ **Subscription / API-keys UI** (dashboard panel with the
  "Subscribe", "Manage billing", "Create key", "Revoke" controls) is
  HTML-commented inside `public/index.html` around line 2150. Alpine
  stubs are in `public/js/app.js` (they just toast "API not yet live").
- ❌ **Schema tables** (`apiKeys`, `apiUsage`, `apiRateLimits`,
  `apiRequestLog`, `stripeCustomers`, `stripeSubscriptions`,
  `stripeEvents`) are commented out in `convex/schema.ts` — Convex
  therefore cannot store any of this yet.
- ❌ **HTTP routes** — `convex/http.ts` only registers `auth`. No
  `/v1/*` endpoints and no `/stripe/webhook` endpoint exist.
- ❌ **Webhook** not registered in Stripe. No Stripe events flow
  anywhere.
- ❌ **Environment**: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
  are **not** set on prod (dev was cleared after we rolled a key).

Net effect: nobody can subscribe and nobody can call `/v1/*`, because
three independent locks are closed (commented code, missing schema,
missing webhook). Each must be unlocked deliberately — no single
misclick flips billing on.

## Activation steps

### 1. Uncomment the backend (≈5 min)

Three files, all mechanical:

- **`convex/schema.ts`** — uncomment the `apiKeys`, `apiUsage`,
  `apiRateLimits`, `apiRequestLog`, `stripeCustomers`,
  `stripeSubscriptions`, `stripeEvents` tables. Grep for `// API` and
  `// Stripe` section headers.
- **`convex/api.future.ts`** — delete the top `export {};`, delete the
  outer `/* */` fence around the code, then rename the file to
  `convex/api.ts`.
- **`convex/stripe.future.ts`** — same dance, rename to
  `convex/stripe.ts`.

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

### 3. Uncomment the frontend UI (≈2 min)

- **`public/index.html`** — remove the `<!-- ... -->` fence around the
  SUBSCRIPTION PANEL block (search for `SUBSCRIPTION PANEL — disabled
  until api.future.ts ships`). Change the tier-card buttons from
  `@click="toggleWaitlist('starter')"` to call a new
  `subscribe('starter')` method (or make them dual: waitlist if not
  signed in / signed in but no sub, Subscribe otherwise — up to you).
- **`public/js/app.js`** — replace the three stub methods near the
  `Disabled API actions` header with real implementations that call
  `api.stripe.createCheckout`, `api.stripe.createBillingPortalSession`,
  `api.api.createKey`, `api.api.revokeKey`, and add a `subscribe(tier)`
  method. Also add a subscription to `api.api.listMyKeys` +
  `api.stripe.mySubscription` in `fetchProfileData()` so
  `myApiKeys`/`mySubscription` actually populate.

### 4. Set production secrets (≈1 min)

```bash
# Stripe live secret key (full or restricted with scopes for checkout,
# customers, billing portal, webhooks). DO NOT type this interactively
# in a Cursor-tracked terminal; use stdin or the Stripe CLI:
pbpaste | npx convex env set --prod STRIPE_SECRET_KEY --from-stdin

# Placeholder for now — real value comes from step 5.
npx convex env set --prod STRIPE_WEBHOOK_SECRET whsec_placeholder

# The URL Stripe redirects users back to after checkout / billing portal.
npx convex env set --prod STRIPE_RETURN_URL https://suprabench.com/#api
```

### 5. Deploy the code (≈2 min)

```bash
npm run check:tiers          # sanity: no drifted numbers
npx convex deploy --prod -y  # pushes code + schema together; both tables and functions become live atomically
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

### 7. Smoke test (≈5 min)

1. Log in with a test account, go to Profile → API & Billing, click
   **Subscribe** on Starter, complete checkout with a **real card** on
   the first run (use a cheap tier — Stripe will charge the real price)
   OR flip the whole flow to test-mode keys first and use
   `4242 4242 4242 4242`. Check the `stripeSubscriptions` table in
   Convex dashboard fills in.
2. Create a key. `curl` an endpoint:
   ```bash
   curl -H "authorization: Bearer sb_live_..." \
        https://api.suprabench.com/v1/models
   ```
3. Cancel via **Manage billing** → confirm `cancelAtPeriodEnd: true`
   lands in the row, key keeps working until period end.

### 8. Update the public docs (≈2 min)

- `public/docs/api/changelog.html` — drop the "waitlist" line, add an
  "API live" entry.
- `public/index.html`'s "Not yet" paragraph — replace with "Live: see
  [docs →](/docs/api/)".
- Optionally: bump real prices into `convex/tiers.ts`
  (`priceUsd: null` → actual numbers) and the TBD cells in the tier
  grid + `docs/api-roadmap.md` + `public/docs/api/index.html`.
  `npm run check:tiers` will fail until all four are consistent.

## Rollback

If something's on fire:

```bash
git revert HEAD                # undo the activation commit
npx convex deploy --prod -y    # re-deploys the commented-out code
```

Stripe webhook endpoint can stay registered — it'll just get 404s from
Convex, Stripe retries for ~3 days, then gives up. No money moves
because `stripe.createCheckout` no longer exists to create new
sessions.

Existing subscribers' cards are NOT charged again during a revert —
Stripe's billing engine is independent of our code. They'll get emails
from Stripe (invoices) even if our `/v1/*` is down. Refund from the
Stripe dashboard if needed.
