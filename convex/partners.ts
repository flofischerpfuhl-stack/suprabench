// ════════════════════════════════════════════════════════════
// PARTNER-KEY ADMIN — LIVE.
//
// Invite-only, free-of-charge API access for whitelisted partner
// websites (my own other web properties + friendly OSS / research /
// non-profit projects I explicitly approve). Partner keys are
// functionally identical to paid-tier keys except:
//   • no Stripe subscription is required — the auth layer in
//     convex/api.ts skips the subscription-status check when
//     `tier === "partner"`.
//   • they're minted ONLY via the CLI mutations below, never via
//     the public `api.createKey` mutation (which hard-rejects any
//     non-PUBLIC_TIERS tier string — see convex/tiers.ts).
//   • `priceUsd: 0`, rendered as a separate "Negotiated / Apply" card
//     below the paid-tier grid in public/index.html.
//
// Usage (the API is already live — these commands work now):
//   # create
//   npx convex run --prod partners:createPartnerKey \
//       '{"name":"mysite.com","ownerEmail":"me@mysite.com"}'
//   # → prints the plaintext key ONCE. Give it to the partner via a
//   # secure channel (1Password share, Signal, etc). We only ever
//   # store the SHA-256 hash.
//
//   # list
//   npx convex run --prod partners:listPartnerKeys
//
//   # bump quota (e.g. a partner legitimately needs 500k/month)
//   npx convex run --prod partners:updatePartnerQuota \
//       '{"apiKeyId":"<id>","monthlyQuota":500000}'
//
//   # revoke (soft, preserves audit trail)
//   npx convex run --prod partners:revokePartnerKey \
//       '{"apiKeyId":"<id>"}'
//
// SECURITY POSTURE: all mutations here are `internalMutation` /
// `internalQuery`, so they cannot be called from the frontend or the
// public API — only via `npx convex run`, which requires the
// deployment's admin credentials. That's the entire authorization
// model; there is no admin-user flag in the DB. If we ever want a
// web-based partner admin UI, wire a regular `mutation` that checks
// `getAuthUserId` against an explicit allowlist of admin user IDs.
//
// Roadmap: see docs/api-roadmap.md → Partner tier section.
// ════════════════════════════════════════════════════════════

import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { PARTNER_DEFAULTS } from "./tiers";
import type { Id } from "./_generated/dataModel";

const KEY_PREFIX = "sb_live_";

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function generatePartnerKey(): Promise<{
  plaintext: string;
  hash: string;
  prefix: string;
}> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const tail = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const plaintext = KEY_PREFIX + tail;
  const hash = await sha256Hex(plaintext);
  const prefix = KEY_PREFIX + hash.slice(0, 8);
  return { plaintext, hash, prefix };
}

// Find (or create) a synthetic "owner user" row for this partner. We
// need a real users._id because the schema's apiKeys.ownerUserId is
// non-nullable. Partners don't log in — the email is just a label.
async function ensurePartnerOwner(
  ctx: any,
  name: string,
  ownerEmail: string | undefined
): Promise<Id<"users">> {
  const email = ownerEmail?.trim() || `partner+${name}@suprabench.internal`;
  const existing = await ctx.db
    .query("users")
    .filter((q: any) => q.eq(q.field("email"), email))
    .first();
  if (existing) return existing._id as Id<"users">;
  return (await ctx.db.insert("users", {
    name: `Partner: ${name}`,
    email,
  } as any)) as Id<"users">;
}

// Mint a new partner key. Prints the plaintext once — operator must
// capture it and forward to the partner. Re-running with the same
// `name` is blocked unless the previous row is revoked (avoids
// accidental duplicate mint).
//
// Quota / rpm defaults come from PARTNER_DEFAULTS in convex/tiers.ts
// (not from TIERS.partner — the display numbers there are fallbacks
// too, but we route through the named constant so intent is clear in
// the tiers.ts comment). Per-partner overrides via the args below are
// expected — this is the "negotiated case-by-case" escape hatch for
// partners whose traffic profile doesn't fit the default.
export const createPartnerKey = internalMutation({
  args: {
    name: v.string(),
    ownerEmail: v.optional(v.string()),
    // Override for partners whose negotiated quota differs from the
    // PARTNER_DEFAULTS. Clamped to [1_000, 1_000_000] — if you need
    // more than 1M/month, the partner should really be on
    // enterprise_plus, bill them at whatever "partner-donated" rate
    // you agreed on.
    monthlyQuota: v.optional(v.number()),
    rpmLimit: v.optional(v.number()),
  },
  handler: async (ctx, { name, ownerEmail, monthlyQuota, rpmLimit }) => {
    if (!name.trim()) throw new Error("name is required");

    // Duplicate-name guard: refuse if an active (not revoked) partner
    // key already exists with this name. Operator must revoke first.
    const existing = await ctx.db
      .query("apiKeys")
      .filter((q: any) => q.eq(q.field("name"), name))
      .filter((q: any) => q.eq(q.field("revokedAt"), undefined))
      .first();
    if (existing && existing.tier === "partner") {
      throw new Error(
        `Active partner key already exists for "${name}" (prefix ${existing.prefix}). ` +
          `Revoke it first with partners:revokePartnerKey.`
      );
    }

    const owner = await ensurePartnerOwner(ctx, name, ownerEmail);
    const { plaintext, hash, prefix } = await generatePartnerKey();

    const quota = Math.min(
      1_000_000,
      Math.max(1_000, monthlyQuota ?? PARTNER_DEFAULTS.monthlyQuota)
    );
    const rpm = Math.min(
      10_000,
      Math.max(10, rpmLimit ?? PARTNER_DEFAULTS.rpmLimit)
    );

    await ctx.db.insert("apiKeys", {
      hash,
      prefix,
      name,
      ownerUserId: owner,
      tier: "partner" as any,
      monthlyQuota: quota,
      rpmLimit: rpm,
      createdAt: Date.now(),
    });

    // CLI output: return plaintext so `npx convex run` prints it.
    // NEVER log it anywhere else. NEVER store plaintext.
    return {
      plaintext,
      prefix,
      name,
      monthlyQuota: quota,
      rpmLimit: rpm,
      instruction:
        "Save the plaintext key NOW — it's shown once. Give it to the partner via a secure channel (1Password share, Signal, etc). We only keep the hash.",
    };
  },
});

// List all partner keys (prefixes + metadata, never plaintext).
export const listPartnerKeys = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("apiKeys").collect();
    return rows
      .filter((r: any) => r.tier === "partner")
      .map((r: any) => ({
        _id: r._id,
        prefix: r.prefix,
        name: r.name,
        monthlyQuota: r.monthlyQuota,
        rpmLimit: r.rpmLimit,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt,
        revoked: !!r.revokedAt,
      }));
  },
});

// Bump a partner's quota/rpm (e.g. because a partner legitimately
// needs more headroom). Ceiling guards remain — if they really need
// >1M/month consider promoting to enterprise_plus instead.
export const updatePartnerQuota = internalMutation({
  args: {
    apiKeyId: v.id("apiKeys"),
    monthlyQuota: v.optional(v.number()),
    rpmLimit: v.optional(v.number()),
  },
  handler: async (ctx, { apiKeyId, monthlyQuota, rpmLimit }) => {
    const key = await ctx.db.get(apiKeyId);
    if (!key) throw new Error("key not found");
    if (key.tier !== "partner")
      throw new Error("refusing to edit non-partner key via partners:* mutations");
    const patch: Record<string, number> = {};
    if (typeof monthlyQuota === "number") {
      patch.monthlyQuota = Math.min(1_000_000, Math.max(1_000, monthlyQuota));
    }
    if (typeof rpmLimit === "number") {
      patch.rpmLimit = Math.min(10_000, Math.max(10, rpmLimit));
    }
    if (Object.keys(patch).length === 0)
      throw new Error("nothing to update");
    await ctx.db.patch(apiKeyId, patch);
    return { ok: true, patch };
  },
});

// Soft-revoke — sets revokedAt. The auth middleware returns 401 for
// any request with a revoked key. Audit log survives.
export const revokePartnerKey = internalMutation({
  args: { apiKeyId: v.id("apiKeys") },
  handler: async (ctx, { apiKeyId }) => {
    const key = await ctx.db.get(apiKeyId);
    if (!key) throw new Error("key not found");
    if (key.tier !== "partner")
      throw new Error("refusing to revoke non-partner key via partners:* mutations");
    if (key.revokedAt) return { ok: true, alreadyRevoked: true };
    await ctx.db.patch(apiKeyId, { revokedAt: Date.now() });
    return { ok: true };
  },
});
