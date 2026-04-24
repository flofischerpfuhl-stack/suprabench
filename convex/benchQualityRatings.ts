import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { enforceDailyActionLimit } from "./abuse";
import { recomputeBenchAggregatesInline } from "./cache";

const RATING_LIMIT_PER_DAY = 100;

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
    difficulty: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await enforceDailyActionLimit(ctx, userId, "bench-rating", RATING_LIMIT_PER_DAY);

    for (const dim of [
      args.relevance,
      args.contamination,
      args.discriminability,
      args.reproducibility,
      args.difficulty,
    ]) {
      if (dim < 1 || dim > 5 || !Number.isInteger(dim)) {
        throw new Error("Each dimension must be an integer between 1 and 5");
      }
    }

    const bench = await ctx.db.get(args.benchId);
    if (!bench) throw new Error("Benchmark not found");
    if (bench.hidden) throw new Error("This benchmark has been removed by the community");

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
        difficulty: args.difficulty,
      });
    } else {
      await ctx.db.insert("benchQualityRatings", {
        benchId: args.benchId,
        userId,
        relevance: args.relevance,
        contamination: args.contamination,
        discriminability: args.discriminability,
        reproducibility: args.reproducibility,
        difficulty: args.difficulty,
      });
    }

    // Quality changed → bench aggregate cache (qualityScore, dimensions,
    // headroom, effectiveWeight, …) is now stale. Recompute it before we
    // touch model rankings so any subsequent listRanked subscribers see
    // the updated bench info immediately.
    await recomputeBenchAggregatesInline(ctx, args.benchId);

    await ctx.scheduler.runAfter(0, internal.rankings.recomputeForBench, {
      benchId: args.benchId,
    });
  },
});
