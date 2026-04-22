// ════════════════════════════════════════════════════════════
// ADMIN BOARD — backend.
//
// Powers the in-app admin panel (visible in public/index.html when
// `users:viewer.isAdmin` is true). All mutations here are regular
// `mutation` / `query` because the admin board is a frontend surface.
// Authorisation is a two-layer check:
//
//   1. `assertAdmin(ctx)` — caller has a userRoles row with
//      role === "admin", OR their email equals PRIMARY_ADMIN_EMAIL.
//   2. Tier-sensitive actions further require the caller be the
//      primary admin (promoting/demoting other admins, editing
//      the primary admin's own row).
//
// The single existing server-side admin path (the pre-existing
// `admin:cleanupOrphanAuth` + partners:* CLI mutations) stays
// intact — those run via `npx convex run` with deployment admin
// credentials and don't go through this auth layer.
// ════════════════════════════════════════════════════════════

import {
  mutation,
  query,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id, Doc } from "./_generated/dataModel";

// ──────────────────────────── MAINTENANCE ────────────────────────
// One-off cleanup: removes auth* records pointing to a non-existent
// user. Safe to keep around; idempotent. Run via:
//   npx convex run --prod admin:cleanupOrphanAuth
// Stays an `internalMutation` because it operates on the raw auth*
// tables and we don't want it exposed to the frontend. The admin
// board (below) uses regular `mutation`/`query` gated on `assertAdmin`.
export const cleanupOrphanAuth = internalMutation({
  args: {},
  handler: async (ctx) => {
    const report: Record<string, number> = {};

    const accounts = await ctx.db.query("authAccounts").collect();
    for (const a of accounts) {
      const u = await ctx.db.get(a.userId as any);
      if (!u) {
        await ctx.db.delete(a._id);
        report.accounts = (report.accounts ?? 0) + 1;
      }
    }
    const sessions = await ctx.db.query("authSessions").collect();
    for (const s of sessions) {
      const u = await ctx.db.get(s.userId as any);
      if (!u) {
        await ctx.db.delete(s._id);
        report.sessions = (report.sessions ?? 0) + 1;
      }
    }
    const refresh = await ctx.db.query("authRefreshTokens").collect();
    for (const r of refresh) {
      const s = await ctx.db.get(r.sessionId as any);
      if (!s) {
        await ctx.db.delete(r._id);
        report.refreshTokens = (report.refreshTokens ?? 0) + 1;
      }
    }
    const verifiers = await ctx.db.query("authVerifiers").collect();
    for (const verifier of verifiers) {
      if (Date.now() - verifier._creationTime > 60 * 60 * 1000) {
        await ctx.db.delete(verifier._id);
        report.verifiers = (report.verifiers ?? 0) + 1;
      }
    }
    return report;
  },
});

// The one email that can mint admins. Stays hard-coded here (not an
// env var) because a compromised env var should not let someone lock
// the real operator out of their own project. Change only with a
// deploy.
export const PRIMARY_ADMIN_EMAIL = "flofischer.pfuhl@gmail.com";

const KEY_PREFIX = "sb_live_";

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function generateApiKey(): Promise<{
  plaintext: string;
  hash: string;
  prefix: string;
}> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const tail = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const plaintext = KEY_PREFIX + tail;
  const hash = await sha256Hex(plaintext);
  const prefix = KEY_PREFIX + hash.slice(0, 8);
  return { plaintext, hash, prefix };
}

/** Returns whether the given user has admin privileges (either the
 *  primary admin by email, or has been promoted via grantAdmin). */
async function isUserAdmin(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">
): Promise<{ isAdmin: boolean; isPrimary: boolean }> {
  const user = await ctx.db.get(userId);
  if (!user) return { isAdmin: false, isPrimary: false };
  const email = (user as any).email ?? "";
  const isPrimary = email === PRIMARY_ADMIN_EMAIL;
  if (isPrimary) return { isAdmin: true, isPrimary: true };
  const role = await ctx.db
    .query("userRoles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  return { isAdmin: role?.role === "admin", isPrimary: false };
}

/** Throws unless the caller is authenticated AND an admin. Returns
 *  the caller's userId + primary-admin flag for onward checks. */
async function assertAdmin(
  ctx: QueryCtx | MutationCtx
): Promise<{ callerId: Id<"users">; isPrimary: boolean }> {
  const callerId = await getAuthUserId(ctx);
  if (!callerId) throw new Error("unauthorized (not signed in)");
  const { isAdmin, isPrimary } = await isUserAdmin(ctx, callerId);
  if (!isAdmin) throw new Error("forbidden (admin only)");
  return { callerId, isPrimary };
}

// ──────────────────────────── QUERIES ────────────────────────────

/** Search users by substring match on name or email. Case-insensitive.
 *  Returns up to 20 rows, each enriched with their role + grantedTier
 *  and a summary of their API keys. Designed for the admin search box. */
export const searchUsers = query({
  args: { query: v.string() },
  handler: async (ctx, { query: q }) => {
    await assertAdmin(ctx);
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return [];

    // Full-table scan is acceptable here: admin search is rare +
    // interactive, and `users` won't grow past small 5-figure counts
    // for a long time. If it does, we add a searchIndex on name/email.
    const all = await ctx.db.query("users").take(5000);
    const matches = all.filter((u: any) => {
      const name = (u.name ?? "").toLowerCase();
      const email = (u.email ?? "").toLowerCase();
      return name.includes(needle) || email.includes(needle);
    });
    matches.sort((a: any, b: any) =>
      ((a.email ?? "").length + (a.name ?? "").length) -
      ((b.email ?? "").length + (b.name ?? "").length)
    );
    const top = matches.slice(0, 20);

    const out = [];
    for (const u of top) {
      const role = await ctx.db
        .query("userRoles")
        .withIndex("by_user", (q2) => q2.eq("userId", u._id))
        .first();
      const keys = await ctx.db
        .query("apiKeys")
        .withIndex("by_owner", (q2) => q2.eq("ownerUserId", u._id))
        .collect();
      const activeKeyCount = keys.filter((k) => !k.revokedAt).length;
      out.push({
        _id: u._id,
        name: (u as any).name ?? null,
        email: (u as any).email ?? null,
        image: (u as any).image ?? null,
        role: role?.role ?? null,
        grantedTier: role?.grantedTier ?? null,
        isPrimaryAdmin: (u as any).email === PRIMARY_ADMIN_EMAIL,
        activeKeyCount,
        totalKeyCount: keys.length,
      });
    }
    return out;
  },
});

/** Lists every account that already has elevated privileges:
 *  role === "admin", grantedTier === "partner", or
 *  grantedTier === "enterprise_plus". Used by the admin board to
 *  populate the result list when the search box is empty — the
 *  default view should answer "who already has special access?" so
 *  the operator doesn't have to remember and search by name.
 *
 *  Sorted: primary admin first, then admins, then partners, then
 *  enterprise_plus, alphabetised by name within each group.
 *
 *  Same row shape as `searchUsers` so the frontend can render either
 *  result set with one template. */
export const listElevatedAccounts = query({
  args: {},
  handler: async (ctx) => {
    await assertAdmin(ctx);

    // Single full scan of userRoles (small table — only rows for
    // promoted/granted accounts exist). Plus one extra fetch for
    // the primary admin, who never gets a userRoles row.
    const roles = await ctx.db.query("userRoles").collect();
    const elevatedRoles = roles.filter(
      (r) =>
        r.role === "admin" ||
        r.grantedTier === "partner" ||
        r.grantedTier === "enterprise_plus"
    );

    type Row = {
      _id: Id<"users">;
      name: string | null;
      email: string | null;
      image: string | null;
      role: string | null;
      grantedTier: string | null;
      isPrimaryAdmin: boolean;
      activeKeyCount: number;
      totalKeyCount: number;
    };
    const out: Row[] = [];
    const seen = new Set<string>();

    for (const r of elevatedRoles) {
      const u = await ctx.db.get(r.userId);
      if (!u) continue;
      seen.add(r.userId);
      const keys = await ctx.db
        .query("apiKeys")
        .withIndex("by_owner", (q) => q.eq("ownerUserId", r.userId))
        .collect();
      out.push({
        _id: u._id,
        name: (u as any).name ?? null,
        email: (u as any).email ?? null,
        image: (u as any).image ?? null,
        role: r.role ?? null,
        grantedTier: r.grantedTier ?? null,
        isPrimaryAdmin: (u as any).email === PRIMARY_ADMIN_EMAIL,
        activeKeyCount: keys.filter((k) => !k.revokedAt).length,
        totalKeyCount: keys.length,
      });
    }

    // Ensure the primary admin is in the list even if they never got
    // a userRoles row (the by-email check is the source of truth for
    // primary-admin status).
    const all = await ctx.db.query("users").take(5000);
    const primary = all.find(
      (u: any) => (u.email ?? "") === PRIMARY_ADMIN_EMAIL
    );
    if (primary && !seen.has(primary._id)) {
      const keys = await ctx.db
        .query("apiKeys")
        .withIndex("by_owner", (q) => q.eq("ownerUserId", primary._id))
        .collect();
      out.push({
        _id: primary._id,
        name: (primary as any).name ?? null,
        email: (primary as any).email ?? null,
        image: (primary as any).image ?? null,
        role: "admin",
        grantedTier: null,
        isPrimaryAdmin: true,
        activeKeyCount: keys.filter((k) => !k.revokedAt).length,
        totalKeyCount: keys.length,
      });
    }

    // Stable, useful ordering: primary admin → admins → partners →
    // enterprise_plus, alphabetic within each group.
    const rank = (r: Row) => {
      if (r.isPrimaryAdmin) return 0;
      if (r.role === "admin") return 1;
      if (r.grantedTier === "partner") return 2;
      if (r.grantedTier === "enterprise_plus") return 3;
      return 9;
    };
    out.sort((a, b) => {
      const dr = rank(a) - rank(b);
      if (dr !== 0) return dr;
      return (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? "");
    });

    return out;
  },
});

/** Full detail view for one user: profile + role + API keys + the
 *  last 12 months of usage aggregated across their keys. Used by
 *  the admin board's user-detail panel. */
export const getUserDetail = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await assertAdmin(ctx);
    const user = await ctx.db.get(userId);
    if (!user) return null;

    const role = await ctx.db
      .query("userRoles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();

    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", userId))
      .collect();

    // Monthly usage: collect apiUsage rows for all of this user's
    // keys and sum per yyyymm. Keep the last 12 months. Also count
    // how many keys existed in each month (based on createdAt <=
    // end-of-month AND (revokedAt == null OR revokedAt >= start-of-
    // month)) so the admin can see key-count vs call-count trend.
    const usageByMonth: Record<
      string,
      { calls: number; keys: number }
    > = {};
    for (const k of keys) {
      const rows = await ctx.db
        .query("apiUsage")
        .withIndex("by_key_month", (q) => q.eq("apiKeyId", k._id))
        .collect();
      for (const r of rows) {
        if (!usageByMonth[r.yyyymm]) usageByMonth[r.yyyymm] = { calls: 0, keys: 0 };
        usageByMonth[r.yyyymm].calls += r.count;
      }
    }
    // Backfill the key-count column per month using key lifetimes.
    // Months covered: union of (a) months we saw usage in, (b) the
    // current month, (c) each key's creation month.
    const now = new Date();
    const months = new Set<string>(Object.keys(usageByMonth));
    months.add(yyyymm(now));
    for (const k of keys) {
      months.add(yyyymm(new Date(k.createdAt)));
    }
    for (const m of months) {
      if (!usageByMonth[m]) usageByMonth[m] = { calls: 0, keys: 0 };
      const [yy, mm] = m.split("-").map(Number);
      const endOfMonth = new Date(yy, mm, 0, 23, 59, 59).getTime();
      const startOfMonth = new Date(yy, mm - 1, 1).getTime();
      usageByMonth[m].keys = keys.filter((k) => {
        if (k.createdAt > endOfMonth) return false;
        if (k.revokedAt && k.revokedAt < startOfMonth) return false;
        return true;
      }).length;
    }
    const usage = Object.entries(usageByMonth)
      .map(([yyyymm, v]) => ({ yyyymm, ...v }))
      .sort((a, b) => (a.yyyymm < b.yyyymm ? 1 : -1))
      .slice(0, 12);

    const { isPrimary } = await isUserAdmin(ctx, userId);

    return {
      _id: user._id,
      name: (user as any).name ?? null,
      email: (user as any).email ?? null,
      image: (user as any).image ?? null,
      isPrimaryAdmin: isPrimary,
      role: role?.role ?? null,
      grantedTier: role?.grantedTier ?? null,
      grantedLimits: role?.grantedLimits ?? null,
      grantedAt: role?.grantedAt ?? null,
      keys: keys
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((k) => ({
          _id: k._id,
          name: k.name,
          prefix: k.prefix,
          tier: k.tier,
          monthlyQuota: k.monthlyQuota,
          rpmLimit: k.rpmLimit,
          createdAt: k.createdAt,
          lastUsedAt: k.lastUsedAt ?? null,
          revokedAt: k.revokedAt ?? null,
        })),
      usage,
    };
  },
});

function yyyymm(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ──────────────────────────── MUTATIONS ──────────────────────────

/** Promote a user to admin. Only the primary admin (by email) can
 *  call this. Idempotent. */
export const grantAdmin = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const { isPrimary } = await assertAdmin(ctx);
    if (!isPrimary)
      throw new Error("only the primary admin can promote other admins");
    await upsertRole(ctx, userId, (prev) => ({
      ...prev,
      role: "admin" as const,
    }));
    return { ok: true };
  },
});

/** Strip the admin role from a user. Only the primary admin can
 *  call this, AND cannot strip themselves (self-lockout protection). */
export const revokeAdmin = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const { callerId, isPrimary } = await assertAdmin(ctx);
    if (!isPrimary)
      throw new Error("only the primary admin can demote admins");
    const target = await ctx.db.get(userId);
    if ((target as any)?.email === PRIMARY_ADMIN_EMAIL)
      throw new Error("the primary admin's email-based role cannot be revoked");
    if (userId === callerId)
      throw new Error("cannot revoke your own admin role");
    await upsertRole(ctx, userId, (prev) => ({
      ...prev,
      role: undefined,
    }));
    return { ok: true };
  },
});

/** Grant a user partner / enterprise_plus tier with custom limits.
 *  Any admin can call this. Does NOT mint a key — use mintKeyForUser
 *  for that; grant is separate so the admin can set limits first and
 *  mint on a follow-up action. Overwrites existing grant + limits. */
export const grantTier = mutation({
  args: {
    userId: v.id("users"),
    tier: v.union(v.literal("partner"), v.literal("enterprise_plus")),
    limits: v.object({
      monthlyQuota: v.number(),
      rpmLimit: v.number(),
      maxKeys: v.number(),
      allowExport: v.boolean(),
    }),
  },
  handler: async (ctx, { userId, tier, limits }) => {
    await assertAdmin(ctx);

    // Defensive clamps — UI-level validation belongs in the frontend,
    // but the backend is the authoritative boundary.
    const clamped = {
      monthlyQuota: Math.max(1_000, Math.min(100_000_000, limits.monthlyQuota)),
      rpmLimit: Math.max(10, Math.min(100_000, limits.rpmLimit)),
      maxKeys: Math.max(1, Math.min(50, limits.maxKeys)),
      allowExport: !!limits.allowExport,
    };
    await upsertRole(ctx, userId, (prev) => ({
      ...prev,
      grantedTier: tier,
      grantedLimits: clamped,
    }));
    return { ok: true, limits: clamped };
  },
});

/** Strip the granted tier from a user AND auto-revoke all of their
 *  active API keys (so they can't keep using the API past the
 *  revocation timestamp). The revoked keys stay in the DB for audit. */
export const revokeTier = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await assertAdmin(ctx);

    await upsertRole(ctx, userId, (prev) => ({
      ...prev,
      grantedTier: undefined,
      grantedLimits: undefined,
    }));

    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", userId))
      .collect();
    let revoked = 0;
    for (const k of keys) {
      if (k.revokedAt) continue;
      if (k.tier !== "partner" && k.tier !== "enterprise_plus") continue;
      await ctx.db.patch(k._id, { revokedAt: Date.now() });
      revoked += 1;
    }
    return { ok: true, revokedKeys: revoked };
  },
});

/** Mint a fresh API key for a user who has been granted a tier.
 *  Uses the user's grantedLimits for quota/rpm. Returns plaintext
 *  ONCE — admin must copy and give to the user (we only store the
 *  hash). Refuses if the user has no grant or has reached maxKeys. */
export const mintKeyForUser = mutation({
  args: {
    userId: v.id("users"),
    name: v.string(),
  },
  handler: async (ctx, { userId, name }) => {
    await assertAdmin(ctx);

    if (!name.trim()) throw new Error("name is required");

    const role = await ctx.db
      .query("userRoles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!role?.grantedTier || !role.grantedLimits)
      throw new Error("user has no granted tier; run grantTier first");

    const existing = await ctx.db
      .query("apiKeys")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", userId))
      .collect();
    const activeCount = existing.filter((k) => !k.revokedAt).length;
    if (activeCount >= role.grantedLimits.maxKeys) {
      throw new Error(
        `user already has ${activeCount} active keys (maxKeys=${role.grantedLimits.maxKeys})`
      );
    }

    const { plaintext, hash, prefix } = await generateApiKey();
    await ctx.db.insert("apiKeys", {
      hash,
      prefix,
      name,
      ownerUserId: userId,
      tier: role.grantedTier,
      monthlyQuota: role.grantedLimits.monthlyQuota,
      rpmLimit: role.grantedLimits.rpmLimit,
      createdAt: Date.now(),
    });
    return {
      plaintext,
      prefix,
      name,
      tier: role.grantedTier,
      monthlyQuota: role.grantedLimits.monthlyQuota,
      rpmLimit: role.grantedLimits.rpmLimit,
      instruction:
        "Save the plaintext key NOW — shown once. Give it to the user via a secure channel. We only keep the hash.",
    };
  },
});

/** Revoke a single key (soft — sets revokedAt). Admin-callable
 *  counterpart to the user-level revokeKey in api.ts. */
export const revokeKey = mutation({
  args: { apiKeyId: v.id("apiKeys") },
  handler: async (ctx, { apiKeyId }) => {
    await assertAdmin(ctx);
    const key = await ctx.db.get(apiKeyId);
    if (!key) throw new Error("key not found");
    if (key.revokedAt) return { ok: true, alreadyRevoked: true };
    await ctx.db.patch(apiKeyId, { revokedAt: Date.now() });
    return { ok: true };
  },
});

// ──────────────────────────── INTERNAL ───────────────────────────

async function upsertRole(
  ctx: MutationCtx,
  userId: Id<"users">,
  patch: (prev: Partial<Doc<"userRoles">>) => Partial<Doc<"userRoles">>
): Promise<void> {
  const existing = await ctx.db
    .query("userRoles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  const next = patch(existing ?? {});
  const now = Date.now();

  // "Empty" row cleanup: if we've just unset both role and grantedTier,
  // delete the row rather than leave a ghost.
  const hasRole = !!next.role;
  const hasTier = !!next.grantedTier;
  if (existing && !hasRole && !hasTier) {
    await ctx.db.delete(existing._id);
    return;
  }

  if (existing) {
    await ctx.db.patch(existing._id, {
      role: hasRole ? next.role : undefined,
      grantedTier: hasTier ? next.grantedTier : undefined,
      grantedLimits: hasTier ? next.grantedLimits : undefined,
      grantedBy: (await getAuthUserId(ctx)) ?? undefined,
      grantedAt: hasTier ? (existing.grantedAt ?? now) : undefined,
      updatedAt: now,
    });
  } else if (hasRole || hasTier) {
    await ctx.db.insert("userRoles", {
      userId,
      role: hasRole ? next.role : undefined,
      grantedTier: hasTier ? next.grantedTier : undefined,
      grantedLimits: hasTier ? next.grantedLimits : undefined,
      grantedBy: (await getAuthUserId(ctx)) ?? undefined,
      grantedAt: hasTier ? now : undefined,
      updatedAt: now,
    });
  }
}
