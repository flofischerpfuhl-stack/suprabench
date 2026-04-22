// Test fixtures: synthetic data + helpers reused across every *.test.ts.
//
// DESIGN NOTE: convex-test gives us the real Convex runtime. We seed
// the fixture data via the test's db-adapter rather than through
// public mutations because public mutations require real authenticated
// users (Google OAuth). The test adapter bypasses auth — we drop rows
// directly into tables, including apiKeys rows whose `hash` we control.
//
// This file assumes the "API activated" state: apiKeys / apiUsage /
// apiRateLimits / stripeSubscriptions tables exist, and the
// api.future.ts / stripe.future.ts / partners.future.ts files have
// been renamed + uncommented. Tests import from the activated paths.
// While the API is dormant these imports will fail — that's the
// signal that activation is pending (see tests/README.md).

import { convexTest } from "convex-test";
import schema from "../../convex/schema";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

const modules = import.meta.glob("../../convex/**/*.*s");

export function setupTestDb() {
  return convexTest(schema, modules);
}

/** SHA-256 hex. Duplicated from api.ts so tests don't depend on
 *  importing module-private helpers. */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface SeededKey {
  plaintext: string;
  hash: string;
  prefix: string;
  apiKeyId: Id<"apiKeys">;
  ownerUserId: Id<"users">;
  tier: string;
  monthlyQuota: number;
  rpmLimit: number;
}

/**
 * Mint a raw apiKeys row directly into the DB for tests. `subStatus`
 * lets a test simulate an `active` / `past_due` / `canceled`
 * subscription by writing to both apiKeys.stripeSubscriptionStatus
 * (the mirror the auth layer reads) and, optionally, a matching
 * stripeSubscriptions row.
 */
export async function seedKey(
  t: ReturnType<typeof convexTest>,
  opts: {
    tier?: "starter" | "pro" | "enterprise" | "enterprise_plus" | "partner";
    monthlyQuota?: number;
    rpmLimit?: number;
    subStatus?: "active" | "trialing" | "past_due" | "canceled";
    name?: string;
    revokedAt?: number;
  } = {}
): Promise<SeededKey> {
  const tier = opts.tier ?? "pro";
  // 64-hex token to match KEY_PREFIX + 64 hex characters format.
  const hexTail = Array.from({ length: 64 }, (_, i) =>
    ((i * 7 + Date.now()) & 15).toString(16)
  ).join("");
  const plaintext = "sb_live_" + hexTail;
  const hash = await sha256Hex(plaintext);
  const prefix = "sb_live_" + hash.slice(0, 8);

  const seeded = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", {
      name: opts.name ?? `Test Owner (${tier})`,
      email: `test-${tier}-${Date.now()}@suprabench.test`,
    } as any);
    const apiKeyId = await ctx.db.insert("apiKeys", {
      hash,
      prefix,
      name: opts.name ?? `test-${tier}`,
      ownerUserId,
      tier,
      monthlyQuota: opts.monthlyQuota ?? 10_000,
      rpmLimit: opts.rpmLimit ?? 60,
      createdAt: Date.now(),
      ...(opts.revokedAt ? { revokedAt: opts.revokedAt } : {}),
      ...(opts.subStatus
        ? { stripeSubscriptionStatus: opts.subStatus }
        : {}),
    } as any);
    return { apiKeyId, ownerUserId };
  });

  return {
    plaintext,
    hash,
    prefix,
    apiKeyId: seeded.apiKeyId,
    ownerUserId: seeded.ownerUserId,
    tier,
    monthlyQuota: opts.monthlyQuota ?? 10_000,
    rpmLimit: opts.rpmLimit ?? 60,
  };
}

/**
 * Seed a minimum viable ranked dataset: one bench, three models,
 * one score per (model, bench). Returns the created IDs so the test
 * can assert against specific slugs / names.
 */
export async function seedBaseDataset(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const serviceUserId = await ctx.db.insert("users", {
      name: "Test Seed User",
      email: "seed@test.internal",
    } as any);

    const benchId = await ctx.db.insert("benches", {
      name: "Test Bench",
      slug: "test-bench",
      description: "For API tests only.",
      url: "https://arxiv.org/abs/9999.99999",
      isOfficial: true,
      tags: ["reasoning"],
      scaleMin: 0,
      scaleMax: 100,
      addedBy: serviceUserId,
      createdAt: Date.now(),
    });

    const models = [
      { name: "Alpha-1", provider: "TestLab", familyTag: "Alpha", score: 85 },
      { name: "Beta-2", provider: "TestLab", familyTag: "Beta", score: 70 },
      { name: "Gamma-3", provider: "OtherLab", familyTag: "Gamma", score: 55 },
    ];
    const modelIds: Array<{ id: Id<"models">; slug: string; score: number }> = [];
    for (const m of models) {
      const slug = m.name.toLowerCase();
      const modelId = await ctx.db.insert("models", {
        name: m.name,
        provider: m.provider,
        slug,
        familyTag: m.familyTag,
        tags: ["reasoning"],
        addedBy: serviceUserId,
        createdAt: Date.now(),
      });
      await ctx.db.insert("modelRankings", {
        modelId,
        name: m.name,
        provider: m.provider,
        slug,
        familyTag: m.familyTag,
        tags: ["reasoning"],
        supraScore: m.score,
        benchCount: 1,
        updatedAt: Date.now(),
        hidden: false,
      });
      await ctx.db.insert("modelScores", {
        modelId,
        benchId,
        rawScore: m.score,
        normalizedScore: m.score,
        sourceUrl: "https://arxiv.org/abs/9999.99999",
        accessedAt: Date.now(),
        submittedBy: serviceUserId,
        createdAt: Date.now(),
        upvotes: 1,
        downvotes: 0,
        submitterName: "Test Seed User",
      });
      modelIds.push({ id: modelId, slug, score: m.score });
    }

    await ctx.db.insert("tagCounts", {
      tag: "reasoning",
      benches: 1,
      models: 3,
    });

    return { serviceUserId, benchId, modelIds };
  });
}

/**
 * Helper to build `[path, init]` tuple for convex-test's
 * `t.fetch(path, init)` signature. Callsite spreads it:
 *     await t.fetch(...buildRequest(`${BASE}/v1/models`, { key }))
 * Full URLs (with `${BASE}`) are accepted; only the pathname+search
 * is forwarded to `t.fetch`.
 */
export function buildRequest(
  url: string,
  opts: {
    key?: SeededKey;
    method?: string;
    headers?: Record<string, string>;
    body?: BodyInit;
  } = {}
): [string, RequestInit] {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key) headers["authorization"] = `Bearer ${opts.key.plaintext}`;
  let path = url;
  if (/^https?:\/\//.test(url)) {
    const u = new URL(url);
    path = u.pathname + u.search;
  }
  return [path, { method: opts.method ?? "GET", headers, body: opts.body }];
}

export { api, internal };
