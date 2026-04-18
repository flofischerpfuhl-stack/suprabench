// ════════════════════════════════════════════════════════════
// Public HTTP API — PLACEHOLDER, NOT WIRED UP.
//
// This file documents the intended shape of the future paid API.
// All real code is commented out so:
//   - the file passes Convex's "every file in convex/ must be a module"
//     check (single empty `export {};` below),
//   - it doesn't accidentally expose endpoints during development,
//   - it's trivial to copy-paste into convex/http.ts when we ship.
//
// Roadmap, pricing, design rationale: see docs/api-roadmap.md.
// ════════════════════════════════════════════════════════════

export {};

/* ── Schema additions (move into convex/schema.ts when activating) ──

apiKeys: defineTable({
  // First 8 chars of the SHA-256 hash, plus a random 24-char tail.
  // The full key is shown ONCE on creation, never stored unhashed.
  hash: v.string(),
  prefix: v.string(),                  // for UI display ("sk_live_a1b2c3d4…")
  ownerUserId: v.id("users"),
  ownerEmail: v.string(),
  tier: v.union(
    v.literal("hobby"),                // 7 €/mo,  5k req
    v.literal("pro"),                  // 19 €/mo, 50k req
    v.literal("scale"),                // 59 €/mo, 500k req
    v.literal("enterprise")            // negotiated
  ),
  monthlyQuota: v.number(),
  createdAt: v.number(),
  revokedAt: v.optional(v.number()),
  // Lemon Squeezy / Polar identifiers for webhook reconciliation.
  subscriptionId: v.optional(v.string()),
  subscriptionStatus: v.optional(v.string()),
})
  .index("by_hash", ["hash"])
  .index("by_owner", ["ownerUserId"]),

apiUsage: defineTable({
  apiKeyId: v.id("apiKeys"),
  yyyymm: v.string(),                  // "2026-04" — partition key
  count: v.number(),
})
  .index("by_key_month", ["apiKeyId", "yyyymm"]),

apiRequestLog: defineTable({
  apiKeyId: v.id("apiKeys"),
  endpoint: v.string(),
  status: v.number(),                  // HTTP status code
  ms: v.number(),                      // server time
  ts: v.number(),
})
  .index("by_key_ts", ["apiKeyId", "ts"]),

──────────────────────────────────────────────────────────── */

/* ── HTTP routes (move into convex/http.ts when activating) ──

import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

// Shared auth + quota check. Returns null → key is valid; Response → 401/429.
const authenticate = httpAction(async (ctx, request) => {
  const auth = request.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(\S+)$/i);
  if (!match) return new Response("missing bearer token", { status: 401 });
  const token = match[1];

  // Hash the presented key and look it up.
  const enc = new TextEncoder().encode(token);
  const hashBuf = await crypto.subtle.digest("SHA-256", enc);
  const hashHex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  const key = await ctx.runQuery(internal.api.findKeyByHash, { hash: hashHex });
  if (!key || key.revokedAt) return new Response("invalid key", { status: 401 });

  // Quota check + atomic increment (per-month bucket).
  const yyyymm = new Date().toISOString().slice(0, 7);
  const allowed = await ctx.runMutation(internal.api.consumeQuota, {
    apiKeyId: key._id, yyyymm,
  });
  if (!allowed) return new Response("monthly quota exceeded", { status: 429 });

  return null; // ok
});

http.route({
  path: "/v1/models",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const fail = await authenticate.handler(ctx, request);
    if (fail) return fail;
    const data = await ctx.runQuery(internal.api.publicListModels, {});
    return new Response(JSON.stringify(data), {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=300",
      },
    });
  }),
});

// (Identical wrappers for /v1/models/{slug}, /v1/benches, /v1/benches/{slug},
//  /v1/tags, /v1/best?tag=…, /v1/export.json — see docs/api-roadmap.md)

export default http;

──────────────────────────────────────────────────────────── */

/* ── Internal helpers (move into a new convex/api.ts when activating) ──

import { internalQuery, internalMutation, query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

export const findKeyByHash = internalQuery({
  args: { hash: v.string() },
  handler: async (ctx, { hash }) => {
    return await ctx.db
      .query("apiKeys")
      .withIndex("by_hash", (q) => q.eq("hash", hash))
      .first();
  },
});

export const consumeQuota = internalMutation({
  args: { apiKeyId: v.id("apiKeys"), yyyymm: v.string() },
  handler: async (ctx, { apiKeyId, yyyymm }) => {
    const key = await ctx.db.get(apiKeyId);
    if (!key) return false;
    const bucket = await ctx.db
      .query("apiUsage")
      .withIndex("by_key_month", (q) =>
        q.eq("apiKeyId", apiKeyId).eq("yyyymm", yyyymm))
      .first();
    const cur = bucket?.count ?? 0;
    if (cur >= key.monthlyQuota) return false;
    if (bucket) await ctx.db.patch(bucket._id, { count: cur + 1 });
    else await ctx.db.insert("apiUsage", { apiKeyId, yyyymm, count: 1 });
    return true;
  },
});

export const publicListModels = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("modelRankings")
      .withIndex("by_score").order("desc").collect();
    return rows
      .filter((r) => !(r.hidden ?? false))
      .map((r) => ({
        slug: r.slug,
        name: r.name,
        provider: r.provider,
        familyTag: r.familyTag,
        tags: r.tags,
        supraScore: r.supraScore,
        benchCount: r.benchCount,
        updatedAt: r.updatedAt,
      }));
  },
});

// User-facing key management (settings page).
export const createKey = mutation({
  args: { tier: v.string() /* must match active subscription */ },
  handler: async (ctx, { tier }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    // 1. verify the user has an active subscription for `tier`
    //    via the Lemon Squeezy / Polar webhook table
    // 2. generate a random 32-char token
    // 3. hash it, store the hash + prefix
    // 4. return the unhashed token ONCE — frontend displays then forgets
    throw new Error("not yet implemented");
  },
});

──────────────────────────────────────────────────────────── */
