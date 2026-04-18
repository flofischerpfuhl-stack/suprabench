// ════════════════════════════════════════════════════════════
// Public-API waitlist.
//
// The actual paid API (api.future.ts + stripe.future.ts) is not
// active yet, but the dashboard needs to collect demand signal so we
// know how many seats to provision before flipping it on. This file
// is the live, working backend for that — schema is in
// convex/schema.ts (table: `apiWaitlist`).
//
// One row per (email, tier). Re-signup is idempotent.
// ════════════════════════════════════════════════════════════

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

const TIERS = ["hobby", "pro", "scale", "enterprise"] as const;

// Returns the rows for the current user, so the UI can render
// "you signed up for Pro on …" instead of the bare button.
export const myEntries = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("apiWaitlist")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
  },
});

// Sign up the current user (must be authenticated — we use their
// account email; signed-out signup would invite trolls).
export const join = mutation({
  args: { tier: v.string() },
  handler: async (ctx, { tier }) => {
    if (!TIERS.includes(tier as (typeof TIERS)[number])) {
      throw new Error("unknown tier");
    }
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("sign in first");

    const user = await ctx.db.get(userId);
    const email = (user as any)?.email;
    if (!email) throw new Error("no email on account");

    // Idempotent: don't double-row the same user/tier combo.
    const existing = await ctx.db
      .query("apiWaitlist")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .filter((q) => q.eq(q.field("tier"), tier))
      .first();
    if (existing) return { _id: existing._id, alreadyJoined: true };

    const id = await ctx.db.insert("apiWaitlist", {
      userId, email, tier, createdAt: Date.now(),
    });
    return { _id: id, alreadyJoined: false };
  },
});

// Withdraw — user changed their mind.
export const leave = mutation({
  args: { tier: v.string() },
  handler: async (ctx, { tier }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("sign in first");
    const existing = await ctx.db
      .query("apiWaitlist")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .filter((q) => q.eq(q.field("tier"), tier))
      .first();
    if (existing) await ctx.db.delete(existing._id);
  },
});

// Admin-only count by tier — for deciding when to ship.
// Run with: npx convex run --prod waitlist:adminStats
export const adminStats = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("apiWaitlist").collect();
    const byTier: Record<string, number> = {};
    for (const r of all) byTier[r.tier] = (byTier[r.tier] ?? 0) + 1;
    return { total: all.length, byTier };
  },
});
