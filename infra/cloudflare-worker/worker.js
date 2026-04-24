// ════════════════════════════════════════════════════════════
//  SupraBench public-API edge proxy
//
//  api.suprabench.com/v1/*
//      └──── this Worker ────►  upbeat-clam-790.convex.site/v1/*
//
//  Why a Worker and not a Convex Custom Domain:
//    Convex Custom Domains are Pro-plan only ($25/mo). The public
//    API has one Partner key in production today, so we get the
//    same "branded URL + backend hidden" property from a 20-line
//    Cloudflare Worker on the free tier (100k req/day quota).
//
//  Design notes:
//    • We only proxy /v1/*. Anything else returns the same JSON
//      404 envelope the upstream uses for unknown routes — that
//      keeps the contract identical whether the caller hits the
//      proxy or the upstream directly.
//    • Headers are passed through untouched (delete Host so fetch
//      sets the upstream Host correctly). Convex's clientIp()
//      already prefers `cf-connecting-ip`, which Cloudflare sets
//      on every Worker request, so audit logs see the real
//      caller IP, not the Worker's egress IP.
//    • Body is streamed (no .text()/.json() materialisation) so
//      /v1/export.json and any future large response don't
//      double-buffer through Worker memory.
//    • redirect: "manual" surfaces 3xx as-is. Convex doesn't
//      issue redirects today, but if it ever does we want the
//      caller to see them.
// ════════════════════════════════════════════════════════════

const UPSTREAM = "https://upbeat-clam-790.convex.site";

const NOT_FOUND_BODY = JSON.stringify({
  error: {
    code: "not_found",
    message: "Unknown endpoint. The SupraBench public API lives under /v1/.",
    hint: "See https://suprabench.com/docs/api for the route list.",
  },
}, null, 2);

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Hard-fence the proxy to /v1/* so a typo'd subdomain doesn't
    // accidentally hand someone access to internal Convex routes
    // (auth callbacks, file storage, etc.).
    if (!url.pathname.startsWith("/v1/") && url.pathname !== "/v1") {
      return new Response(NOT_FOUND_BODY, {
        status: 404,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      });
    }

    const upstreamUrl = UPSTREAM + url.pathname + url.search;
    const headers = new Headers(request.headers);
    headers.delete("host"); // fetch() rewrites this from upstreamUrl

    return fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });
  },
};
