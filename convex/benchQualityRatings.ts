import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

export const getMyRating = query({
  args: { benchId: v.id("benches") },
  handler: async (ctx, { benchId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const rating = await ctx.db
      .query("benchQualityRatings")
      .withIndex("by_bench_user", (q) =>
        q.eq("benchId", benchId).eq("userId", userId)
      )
      .first();
    return rating;
  },
});

export const rate = mutation({
  args: {
    benchId: v.id("benches"),
    relevance: v.number(),
    contamination: v.number(),
    discriminability: v.number(),
    reproducibility: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Validate dimensions 1-5
    for (const dim of [args.relevance, args.contamination, args.discriminability, args.reproducibility]) {
      if (dim < 1 || dim > 5 || !Number.isInteger(dim)) {
        throw new Error("Each dimension must be an integer between 1 and 5");
      }
    }

    const bench = await ctx.db.get(args.benchId);
    if (!bench) throw new Error("Benchmark not found");

    // Upsert
    const existing = await ctx.db
      .query("benchQualityRatings")
      .withIndex("by_bench_user", (q) =>
        q.eq("benchId", args.benchId).eq("userId", userId)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        relevance: args.relevance,
        contamination: args.contamination,
        discriminability: args.discriminability,
        reproducibility: args.reproducibility,
      });
    } else {
      await ctx.db.insert("benchQualityRatings", {
        benchId: args.benchId,
        userId,
        relevance: args.relevance,
        contamination: args.contamination,
        discriminability: args.discriminability,
        reproducibility: args.reproducibility,
      });
    }
  },
});
