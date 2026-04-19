/* ════════════════════════════════════════════════════════════
   SupraBench service worker.

   Goals:
   1. Make the site installable as a PWA on Android / iOS / Desktop
      (Chrome's installability check requires a SW + manifest + https).
   2. Survive offline: at minimum show the app shell instead of the
      browser's "no internet" page.
   3. Serve repeat visits from cache for instant paint, while still
      picking up new deploys promptly.

   Caching strategy:
   - HTML  → network-first, falls back to cached / offline shell.
     Reason: Cloudflare Pages builds invalidate on every deploy and
     we want the fresh shell that references the new hashed assets.
   - JS / CSS / fonts → stale-while-revalidate.
     Reason: ship-fast UX (cached copy paints immediately), background
     update writes the latest version into cache for the next visit.
   - Images → cache-first with 30-day expiry.
     Reason: nearly-immutable, big bandwidth wins.
   - Convex (`*.convex.cloud`, `*.convex.site`) → network-only,
     never cached (live data + auth tokens).
   - Giscus (`giscus.app`) → network-only, never cached (dynamic).
   - Anything else → network-first, no caching.

   Bump CACHE_VERSION whenever the precache list changes or when you
   want to force every client to drop its old cache after a deploy.
   ════════════════════════════════════════════════════════════ */

const CACHE_VERSION = "v1.12.0";
const CACHE_PREFIX = "suprabench-";
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-${CACHE_VERSION}`;
const PRECACHE = `${CACHE_PREFIX}precache-${CACHE_VERSION}`;
const IMAGE_CACHE = `${CACHE_PREFIX}img-${CACHE_VERSION}`;

// Files baked into the cache on install — minimum to render the app
// shell offline. Keep this list short; everything else is cached
// opportunistically on first request.
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/offline.html",
  "/css/style.css",
  "/js/app.js",
  "/js/convex.js",
  "/site.webmanifest",
  "/img/favicon.ico",
  "/img/icon-192.png",
  "/img/icon-512.png",
  "/img/apple-touch-icon.png",
];

// ── Install ─────────────────────────────────────────────────
// Prefetch the app shell. addAll fails atomically — if any URL is
// 404 / 5xx the whole install fails and we never replace the old SW.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PRECACHE)
      .then((cache) =>
        cache.addAll(
          PRECACHE_URLS.map((url) => new Request(url, { cache: "reload" }))
        )
      )
      .then(() => self.skipWaiting())
  );
});

// ── Activate ────────────────────────────────────────────────
// Drop caches from older SW versions, claim open clients so the new
// SW controls them immediately (without requiring a hard refresh).
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (k) =>
              k.startsWith(CACHE_PREFIX) &&
              ![PRECACHE, RUNTIME_CACHE, IMAGE_CACHE].includes(k)
          )
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// ── Fetch routing ───────────────────────────────────────────

const isHTMLRequest = (req) =>
  req.mode === "navigate" ||
  (req.method === "GET" && req.headers.get("accept")?.includes("text/html"));

const isImage = (url) =>
  /\.(?:png|jpg|jpeg|gif|webp|svg|ico|avif)$/i.test(url.pathname);

const isHashedAsset = (url) =>
  /\.(?:css|js|woff2?|ttf|otf)$/i.test(url.pathname);

const isLiveBackend = (url) =>
  url.hostname.endsWith(".convex.cloud") ||
  url.hostname.endsWith(".convex.site") ||
  url.hostname === "giscus.app" ||
  url.hostname.endsWith(".giscus.app");

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 1. Live backends — always network, never cache.
  if (isLiveBackend(url)) return;

  // 2. App shell / navigation — network-first, fall back to cache,
  //    then to /offline.html if both fail.
  if (isHTMLRequest(req)) {
    event.respondWith(networkFirst(req, PRECACHE));
    return;
  }

  // 3. Images — cache-first.
  if (isImage(url) && url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, IMAGE_CACHE));
    return;
  }

  // 4. Hashed JS/CSS/fonts → stale-while-revalidate.
  if (isHashedAsset(url) && url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    return;
  }

  // 5. Cross-origin static (KaTeX, Fontshare, Alpine, Convex bundle on
  //    unpkg) → stale-while-revalidate so first paint is offline-safe.
  if (req.destination === "style" || req.destination === "script" ||
      req.destination === "font") {
    event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    return;
  }

  // 6. Default: pass through to the network.
});

// ── Strategies ──────────────────────────────────────────────

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
    return fresh;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    // Last resort: serve the precached app shell so SPA boots and
    // can show whatever data lives in localStorage / Convex cache.
    const shell = await cache.match("/offline.html") ?? await cache.match("/");
    if (shell) return shell;
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
    return fresh;
  } catch (e) {
    return new Response("", { status: 504 });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkPromise = fetch(req)
    .then((fresh) => {
      if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
      return fresh;
    })
    .catch(() => null);
  return cached ?? networkPromise.then((r) => r ?? new Response("", { status: 504 }));
}

// ── Manual update channel ───────────────────────────────────
// The page can post {type:"SKIP_WAITING"} after the user clicks
// "Reload to update". Lets us upgrade without a forced reload.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
