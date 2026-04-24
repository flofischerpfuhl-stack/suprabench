# SupraBench API edge proxy (Cloudflare Worker)

Brands the public API as `https://api.suprabench.com/v1/...`
without paying for Convex Pro custom domains.

```
┌──────────────┐      ┌─────────────────────┐      ┌──────────────────────────────┐
│  client      │ ───▶ │  api.suprabench.com │ ───▶ │  upbeat-clam-790.convex.site │
│ (curl, SDK)  │      │   (this Worker)     │      │       (Convex backend)       │
└──────────────┘      └─────────────────────┘      └──────────────────────────────┘
```

## What you have to do (twice, once)

```bash
cd infra/cloudflare-worker
npx wrangler login          # one-time, opens browser, click "Authorize"
npx wrangler deploy         # deploys + creates DNS + issues TLS cert
```

That is the entire ceremony.

The first command caches credentials in `~/.config/.wrangler/`,
so on later deploys you just run the second one.

## Smoke test

About 30 seconds after `wrangler deploy` finishes:

```bash
SB_KEY="sb_live_…"
curl -sS -D - "https://api.suprabench.com/v1/models?limit=1" \
  -H "Authorization: Bearer $SB_KEY" | head -20
```

Expect `HTTP/2 200`, six `X-RateLimit-*` / `X-Quota-*` headers,
and a one-element JSON array.

## Cost

Cloudflare Workers free tier = **100 000 requests / day**. The
public API has one Partner key in production, so this is roughly
3 orders of magnitude of headroom.

## Switching backends

If you ever migrate Convex deployments, edit the `UPSTREAM`
constant at the top of `worker.js` and run `npx wrangler deploy`
again. Customers' code keeps working unchanged — that's the
whole point of the proxy.
