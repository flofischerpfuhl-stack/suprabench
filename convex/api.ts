// ════════════════════════════════════════════════════════════
// Public HTTP API — LIVE on /v1/*.
//
// What this module does:
//   • User-facing mutations / queries on the Profile→API dashboard
//     (`myKeys`, `myKeyUsage`, `createKey`, `revokeKey`).
//   • Internal helpers used by the HTTP auth middleware
//     (`findKeyByHash`, `consumeQuota`, `checkRateLimit`, `logRequest`,
//     `cleanupOldData`).
//   • Internal `publicListModels / publicModelDetail / publicListBenches
//     / publicTagList / publicExport` queries. They're `internalQuery`
//     (not `query`) because the ONLY way to reach them is through the
//     HTTP routes below, which gate on a valid API key. If you expose
//     one of these as a public `query` you bypass the auth / quota
//     layer — don't.
//   • HTTP route registration via `registerApiRoutes(http)`, called
//     from convex/http.ts.
//
// Activation status of the tiers that can reach this module:
//   • partner       → LIVE. Keys minted via `npx convex run
//     partners:createPartnerKey`. Auth skips the Stripe subscription
//     check for this tier (and for enterprise_plus).
//   • starter / pro / enterprise
//                   → the code is wired but `createKey` for these
//     tiers requires an active Stripe subscription, and Stripe is
//     still dormant (convex/stripe.future.ts has not been activated,
//     no webhook is registered, no env secrets set). So until Stripe
//     is flipped on, only partner keys actually exist in `apiKeys`.
//     See ACTIVATION.md for the rest of the sequence.
//
// Roadmap, pricing, design rationale: see docs/api-roadmap.md.
// ════════════════════════════════════════════════════════════

import { v } from "convex/values";
import { internalQuery, internalMutation, mutation, query, httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { httpRouter } from "convex/server";
import { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
// Tier pricing / quotas live in convex/tiers.ts (single source of
// truth — see header comment there for the list of files that must
// be kept in sync, and the lint script that enforces it). We import
// PUBLIC_TIERS separately so createKey() can reject attempts to
// self-mint a partner key (those are CLI-only via convex/partners.ts).
import { TIERS, PUBLIC_TIERS, type Tier } from "./tiers";

const KEY_PREFIX = "sb_live_";
// Cache TTLs (per docs/api-roadmap.md). Sent as Cache-Control headers
// so clients / Cloudflare-in-front can edge-cache responses.
const TTL = {
  rankings: 300,    //  5 min
  detail:   300,
  tags:    3600,    //  1 h
  export: 86400,    // 24 h
};

// Standard JSON response with cache headers and CORS.
function json(data: unknown, opts: { status?: number; ttl?: number } = {}) {
  const { status = 200, ttl = 0 } = opts;
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": ttl > 0 ? `public, max-age=${ttl}` : "no-store",
      "access-control-allow-origin": "*",
      "vary": "authorization",
    },
  });
}

function err(status: number, code: string, message: string, hint?: string) {
  return json({ error: { code, message, hint } }, { status });
}

// ════════════════════════════════════════════════════════════
// ─── 2. KEY GENERATION ─────────────────────────────────────
// ════════════════════════════════════════════════════════════

// Crypto-safe key. 32 bytes → 64 hex chars. Plus a "sb_live_"
// prefix and an 8-char hash-prefix for UI display.
async function generateApiKey(): Promise<{ plaintext: string; hash: string; prefix: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const tail = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  const plaintext = KEY_PREFIX + tail;
  const hash = await sha256Hex(plaintext);
  const prefix = KEY_PREFIX + hash.slice(0, 8);
  return { plaintext, hash, prefix };
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ════════════════════════════════════════════════════════════
// ─── 3. USER-FACING MUTATIONS / QUERIES (settings page) ────
// ════════════════════════════════════════════════════════════

// List a user's keys (no plaintext, ever — only prefixes).
export const myKeys = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", userId))
      .collect();
    return keys.map(k => ({
      _id: k._id,
      prefix: k.prefix,
      name: k.name,
      tier: k.tier,
      monthlyQuota: k.monthlyQuota,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      revoked: !!k.revokedAt,
    }));
  },
});

// One-month usage rollup for a key.
export const myKeyUsage = query({
  args: { apiKeyId: v.id("apiKeys") },
  handler: async (ctx, { apiKeyId }) => {
    const userId = await getAuthUserId(ctx);
    const key = await ctx.db.get(apiKeyId);
    if (!key || key.ownerUserId !== userId) throw new Error("not found");
    const yyyymm = new Date().toISOString().slice(0, 7);
    const bucket = await ctx.db.query("apiUsage")
      .withIndex("by_key_month", q => q.eq("apiKeyId", apiKeyId).eq("yyyymm", yyyymm))
      .first();
    return {
      yyyymm,
      used: bucket?.count ?? 0,
      quota: key.monthlyQuota,
    };
  },
});

// Create a new key. Requires an active subscription for the requested tier.
// Non-public tiers (partner, enterprise_plus) are hard-rejected here and
// can only be minted via the CLI — partner via
// `partners:createPartnerKey`, enterprise_plus via a separate admin
// mutation (not yet written).
export const createKey = mutation({
  args: { name: v.string(), tier: v.string() },
  handler: async (ctx, { name, tier }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("not signed in");
    if (!(tier in TIERS)) throw new Error("unknown tier");

    // Block self-mint of non-public tiers. Partner keys live in the
    // same apiKeys table but are exclusively created via the
    // internalMutation partners:createPartnerKey (CLI-only).
    if (!(PUBLIC_TIERS as readonly string[]).includes(tier)) {
      throw new Error(`tier "${tier}" is not publicly subscribable`);
    }

    // Enforce subscription state. All PUBLIC_TIERS require an active
    // Stripe sub — but Stripe is currently dormant (see header of this
    // file), so this branch always throws for now. That's the intended
    // behaviour: paid tiers stay on "Join waitlist" until Stripe is
    // activated. Partner / enterprise_plus bypass this entirely (they
    // were rejected above).
    const sub = await ctx.db.query("stripeSubscriptions")
      .withIndex("by_user", q => q.eq("userId", userId))
      .filter(q => q.eq(q.field("tier"), tier))
      .filter(q => q.eq(q.field("status"), "active"))
      .first();
    if (!sub) throw new Error(`no active ${tier} subscription`);

    // Cap key count per user to the per-tier maxKeys.
    const cfg = TIERS[tier as Tier];
    const existing = await ctx.db.query("apiKeys")
      .withIndex("by_owner", q => q.eq("ownerUserId", userId))
      .filter(q => q.eq(q.field("revokedAt"), undefined))
      .collect();
    if (existing.length >= cfg.maxKeys)
      throw new Error(`max ${cfg.maxKeys} active keys for ${tier} tier`);

    const { plaintext, hash, prefix } = await generateApiKey();
    await ctx.db.insert("apiKeys", {
      hash, prefix, name,
      ownerUserId: userId,
      tier: tier as any,
      monthlyQuota: cfg.monthlyQuota,
      rpmLimit: cfg.rpmLimit,
      createdAt: Date.now(),
    });
    // Plaintext returned here is the ONLY time the user sees it.
    return { plaintext, prefix };
  },
});

// Soft-revoke. We never hard-delete so audit trail survives.
export const revokeKey = mutation({
  args: { apiKeyId: v.id("apiKeys") },
  handler: async (ctx, { apiKeyId }) => {
    const userId = await getAuthUserId(ctx);
    const key = await ctx.db.get(apiKeyId);
    if (!key || key.ownerUserId !== userId) throw new Error("not found");
    await ctx.db.patch(apiKeyId, { revokedAt: Date.now() });
  },
});

// ════════════════════════════════════════════════════════════
// ─── 4. INTERNAL HELPERS USED BY THE HTTP LAYER ───────────
// ════════════════════════════════════════════════════════════

export const findKeyByHash = internalQuery({
  args: { hash: v.string() },
  handler: async (ctx, { hash }) => {
    return await ctx.db.query("apiKeys")
      .withIndex("by_hash", q => q.eq("hash", hash))
      .first();
  },
});

// Atomically increment the monthly quota bucket.
// Returns the post-increment count, or null if the user is over quota.
export const consumeQuota = internalMutation({
  args: { apiKeyId: v.id("apiKeys"), yyyymm: v.string() },
  handler: async (ctx, { apiKeyId, yyyymm }) => {
    const key = await ctx.db.get(apiKeyId);
    if (!key) return null;
    const bucket = await ctx.db.query("apiUsage")
      .withIndex("by_key_month", q => q.eq("apiKeyId", apiKeyId).eq("yyyymm", yyyymm))
      .first();
    const cur = bucket?.count ?? 0;
    if (cur >= key.monthlyQuota) return null;
    if (bucket) await ctx.db.patch(bucket._id, { count: cur + 1, lastIncrementAt: Date.now() });
    else        await ctx.db.insert("apiUsage", { apiKeyId, yyyymm, count: 1, lastIncrementAt: Date.now() });
    await ctx.db.patch(apiKeyId, { lastUsedAt: Date.now() });
    return cur + 1;
  },
});

// Sliding-window rate limit. One row per (key, minute-bucket).
// Returns true if request is allowed.
export const checkRateLimit = internalMutation({
  args: { apiKeyId: v.id("apiKeys"), rpmLimit: v.number() },
  handler: async (ctx, { apiKeyId, rpmLimit }) => {
    const minute = Math.floor(Date.now() / 60_000);
    const bucket = await ctx.db.query("apiRateLimits")
      .withIndex("by_key_bucket", q => q.eq("apiKeyId", apiKeyId).eq("minuteBucket", minute))
      .first();
    const cur = bucket?.count ?? 0;
    if (cur >= rpmLimit) return false;
    if (bucket) await ctx.db.patch(bucket._id, { count: cur + 1 });
    else        await ctx.db.insert("apiRateLimits", { apiKeyId, minuteBucket: minute, count: 1 });
    return true;
  },
});

// Audit log entry. Fire-and-forget from the HTTP handler.
export const logRequest = internalMutation({
  args: {
    apiKeyId: v.id("apiKeys"),
    endpoint: v.string(),
    status: v.number(),
    ms: v.number(),
    ip: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("apiRequestLog", { ...args, ts: Date.now() });
  },
});

// Cron target — keep the audit log + rate-limit table small.
// Schedule via convex/crons.ts: cron("api-cleanup", "0 * * * *", ...).
export const cleanupOldData = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoffLog   = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days
    const cutoffRate  = Math.floor(Date.now() / 60_000) - 60;  // 1 hour
    const oldLogs = await ctx.db.query("apiRequestLog")
      .filter(q => q.lt(q.field("ts"), cutoffLog)).take(500);
    for (const r of oldLogs) await ctx.db.delete(r._id);
    const oldBuckets = await ctx.db.query("apiRateLimits")
      .filter(q => q.lt(q.field("minuteBucket"), cutoffRate)).take(500);
    for (const r of oldBuckets) await ctx.db.delete(r._id);
  },
});

// ════════════════════════════════════════════════════════════
// ─── 5. PUBLIC DATA QUERIES (the actual "API responses") ───
// ════════════════════════════════════════════════════════════

export const publicListModels = internalQuery({
  args: { limit: v.optional(v.number()), tag: v.optional(v.string()) },
  handler: async (ctx, { limit = 100, tag }) => {
    let rows = await ctx.db.query("modelRankings")
      .withIndex("by_score").order("desc").collect();
    rows = rows.filter(r => !(r.hidden ?? false));
    if (tag) rows = rows.filter(r => (r.tags ?? []).includes(tag));
    return rows.slice(0, limit).map(r => ({
      slug: r.slug,
      name: r.name,
      provider: r.provider,
      familyTag: r.familyTag,
      tags: r.tags,
      supraScore: Math.round(r.supraScore * 100) / 100,
      benchCount: r.benchCount,
      updatedAt: r.updatedAt,
    }));
  },
});

export const publicModelDetail = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const ranking = await ctx.db.query("modelRankings")
      .filter(q => q.eq(q.field("slug"), slug)).first();
    if (!ranking || ranking.hidden) return null;
    const model = await ctx.db.get(ranking.modelId);
    if (!model || model.hidden) return null;
    const scores = await ctx.db.query("modelScores")
      .withIndex("by_model", q => q.eq("modelId", model._id)).collect();
    const benchIds = [...new Set(scores.map(s => s.benchId))];
    const benches = await Promise.all(benchIds.map(id => ctx.db.get(id)));
    const benchById = new Map(benches.filter(Boolean).map(b => [b!._id, b]));
    return {
      slug: model.slug, name: model.name, provider: model.provider,
      familyTag: model.familyTag, tags: model.tags,
      supraScore: Math.round(ranking.supraScore * 100) / 100,
      benchCount: ranking.benchCount,
      scores: scores
        .filter(s => benchById.has(s.benchId))
        .map(s => ({
          bench: benchById.get(s.benchId)!.slug,
          benchName: benchById.get(s.benchId)!.name,
          rawScore: s.rawScore,
          normalizedScore: Math.round(s.normalizedScore * 10) / 10,
          sourceUrl: s.sourceUrl,
          accessedAt: s.accessedAt,
          upvotes: s.upvotes,
          downvotes: s.downvotes,
        })),
    };
  },
});

export const publicListBenches = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 100 }) => {
    const rows = await ctx.db.query("benches").collect();
    return rows
      .filter(b => !(b.hidden ?? false))
      .map(b => ({
        slug: b.slug, name: b.name, description: b.description, url: b.url,
        isOfficial: b.isOfficial, tags: b.tags,
        scaleMin: b.scaleMin, scaleMax: b.scaleMax,
        qualityScore: b.cachedQualityScore,
        dimensions: b.cachedDimensions,
        modelCount: b.cachedModelCount,
        raterCount: b.cachedRaterCount,
        effectiveWeight: b.cachedEffectiveWeight,
      }))
      .sort((a, b) => (b.effectiveWeight ?? 0) - (a.effectiveWeight ?? 0))
      .slice(0, limit);
  },
});

export const publicTagList = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("tagCounts").collect();
    return rows.map(r => ({ tag: r.tag, models: r.models, benches: r.benches }));
  },
});

// Heavy: full DB snapshot. Pro tier and above only.
// Cap response at ~5MB; if larger, return 413 + S3 download link
// (out of scope for v1).
export const publicExport = internalQuery({
  args: {},
  handler: async (ctx) => {
    const [models, benches, tags] = await Promise.all([
      ctx.db.query("modelRankings").collect(),
      ctx.db.query("benches").collect(),
      ctx.db.query("tagCounts").collect(),
    ]);
    return {
      generatedAt: Date.now(),
      models: models.filter(m => !m.hidden),
      benches: benches.filter(b => !b.hidden),
      tags,
    };
  },
});

// ════════════════════════════════════════════════════════════
// ─── 6. HTTP ROUTES (register from convex/http.ts) ─────────
// ════════════════════════════════════════════════════════════

// Shared auth middleware. Returns the validated apiKey doc on success
// or a Response on failure (caller short-circuits with `return`).
async function authenticate(ctx: any, request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  if (!m) return { resp: err(401, "missing_token", "Bearer token required",
                              "Add 'Authorization: Bearer sb_live_…' header.") };
  const token = m[1];
  if (!token.startsWith(KEY_PREFIX))
    return { resp: err(401, "invalid_token_format", "Token must start with sb_live_") };

  const hash = await sha256Hex(token);
  const key = await ctx.runQuery(internal.api.findKeyByHash, { hash });
  if (!key) return { resp: err(401, "invalid_token", "Unknown or revoked key") };
  if (key.revokedAt) return { resp: err(401, "revoked", "This key was revoked") };
  // Partner-tier and enterprise_plus keys are minted manually and
  // deliberately have no Stripe subscription attached. Skip the
  // subscription liveness check for them — everything else (rate
  // limit, monthly quota, audit log) still applies.
  const needsSubCheck = key.tier !== "partner" && key.tier !== "enterprise_plus";
  if (needsSubCheck && key.stripeSubscriptionStatus &&
      !["active", "trialing"].includes(key.stripeSubscriptionStatus)) {
    return { resp: err(402, "subscription_inactive",
                       `Subscription is ${key.stripeSubscriptionStatus}`,
                       "Update payment method at https://suprabench.com/#api") };
  }

  const allowed = await ctx.runMutation(internal.api.checkRateLimit, {
    apiKeyId: key._id, rpmLimit: key.rpmLimit,
  });
  if (!allowed) return { resp: err(429, "rate_limited",
                                   `> ${key.rpmLimit} req/min`, "Slow down or upgrade tier.") };

  const yyyymm = new Date().toISOString().slice(0, 7);
  const used = await ctx.runMutation(internal.api.consumeQuota, { apiKeyId: key._id, yyyymm });
  if (used === null) return { resp: err(429, "quota_exceeded",
                                        `Monthly quota of ${key.monthlyQuota} reached`,
                                        "Upgrade tier or wait until next month.") };

  return { key, used };
}

function clientIp(request: Request) {
  return request.headers.get("cf-connecting-ip")
      ?? request.headers.get("x-forwarded-for")?.split(",")[0].trim()
      ?? undefined;
}

// Simple wrapper that handles auth, logging, errors uniformly.
function endpoint(name: string, ttl: number, handler: (ctx: any, request: Request, key: any) => Promise<Response>) {
  // Explicit Promise<Response> return annotation — httpAction's
  // parameter type is strict about never returning undefined, and
  // TS can't always narrow a try/catch+let-var pattern tightly
  // enough without the hint.
  return httpAction(async (ctx, request): Promise<Response> => {
    const t0 = Date.now();
    const auth = await authenticate(ctx, request);
    if ("resp" in auth) {
      // Don't log unauthenticated traffic — would let attackers fill the log.
      return auth.resp as Response;
    }
    let resp: Response;
    try {
      resp = await handler(ctx, request, auth.key);
    } catch (e: any) {
      console.error(`[api] ${name} threw:`, e);
      resp = err(500, "internal", "Something blew up on our side");
    }
    const ms = Date.now() - t0;
    // Fire-and-forget logging (don't block the response).
    ctx.runMutation(internal.api.logRequest, {
      apiKeyId: auth.key._id,
      endpoint: name,
      status: resp.status,
      ms,
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent") ?? undefined,
    }).catch(() => {});
    return resp;
  });
}

// Call this from convex/http.ts so the routes get registered.
export function registerApiRoutes(http: ReturnType<typeof httpRouter>) {
  // CORS preflight — needed because some clients (browser fetch from
  // notebooks etc.) will OPTIONS before the GET.
  http.route({
    pathPrefix: "/v1/", method: "OPTIONS",
    handler: httpAction(async () => new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "86400",
      },
    })),
  });

  http.route({
    path: "/v1/models", method: "GET",
    handler: endpoint("listModels", TTL.rankings, async (ctx, req) => {
      const u = new URL(req.url);
      const data = await ctx.runQuery(internal.api.publicListModels, {
        limit: clampInt(u.searchParams.get("limit"), 1, 500, 100),
        tag: u.searchParams.get("tag") ?? undefined,
      });
      return json(data, { ttl: TTL.rankings });
    }),
  });

  http.route({
    pathPrefix: "/v1/models/", method: "GET",
    handler: endpoint("modelDetail", TTL.detail, async (ctx, req) => {
      const slug = new URL(req.url).pathname.replace(/^\/v1\/models\//, "").replace(/\/$/, "");
      if (!slug) return err(400, "bad_request", "missing model slug");
      const data = await ctx.runQuery(internal.api.publicModelDetail, { slug });
      if (!data) return err(404, "not_found", `model '${slug}' not found`);
      return json(data, { ttl: TTL.detail });
    }),
  });

  http.route({
    path: "/v1/benches", method: "GET",
    handler: endpoint("listBenches", TTL.rankings, async (ctx, req) => {
      const u = new URL(req.url);
      const data = await ctx.runQuery(internal.api.publicListBenches, {
        limit: clampInt(u.searchParams.get("limit"), 1, 500, 100),
      });
      return json(data, { ttl: TTL.rankings });
    }),
  });

  http.route({
    path: "/v1/tags", method: "GET",
    handler: endpoint("listTags", TTL.tags, async (ctx) => {
      const data = await ctx.runQuery(internal.api.publicTagList, {});
      return json(data, { ttl: TTL.tags });
    }),
  });

  http.route({
    path: "/v1/best", method: "GET",
    handler: endpoint("bestByTag", TTL.rankings, async (ctx, req) => {
      const u = new URL(req.url);
      const tag = u.searchParams.get("tag");
      if (!tag) return err(400, "bad_request", "?tag= required");
      const data = await ctx.runQuery(internal.api.publicListModels, {
        tag, limit: clampInt(u.searchParams.get("limit"), 1, 100, 10),
      });
      return json(data, { ttl: TTL.rankings });
    }),
  });

  http.route({
    path: "/v1/export.json", method: "GET",
    handler: endpoint("export", TTL.export, async (ctx, req, key) => {
      if (!TIERS[key.tier as Tier].allowExport)
        return err(403, "tier_forbidden", "Export is Pro+ only");
      const data = await ctx.runQuery(internal.api.publicExport, {});
      return json(data, { ttl: TTL.export });
    }),
  });
}

function clampInt(s: string | null, min: number, max: number, dflt: number): number {
  if (!s) return dflt;
  const n = parseInt(s, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
