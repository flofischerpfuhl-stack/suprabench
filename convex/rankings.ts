import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Id, Doc } from "./_generated/dataModel";

// ── Helper: compute bench quality score ──
async function getBenchQuality(
  ctx: any,
  benchId: Id<"benches">
): Promise<number> {
  const ratings = await ctx.db
    .query("benchQualityRatings")
    .withIndex("by_bench", (q: any) => q.eq("benchId", benchId))
    .collect();
  if (ratings.length === 0) return 50;
  const avg =
    ratings.reduce(
      (sum: number, r: any) =>
        sum +
        (r.relevance + r.contamination + r.discriminability + r.reproducibility) / 4,
      0
    ) / ratings.length;
  return avg * 20;
}

// ── Recompute a single model's SupraScore and write to modelRankings ──
export const recomputeModel = internalMutation({
  args: { modelId: v.id("models") },
  handler: async (ctx, { modelId }) => {
    const model = await ctx.db.get(modelId);
    if (!model) return;

    const scores = await ctx.db
      .query("modelScores")
      .withIndex("by_model", (q: any) => q.eq("modelId", modelId))
      .collect();

    // Group valid scores by bench
    const benchScores: Record<string, number[]> = {};
    for (const s of scores) {
      if (s.upvotes > s.downvotes) {
        const key = s.benchId as string;
        if (!benchScores[key]) benchScores[key] = [];
        benchScores[key].push(s.normalizedScore);
      }
    }

    let weightedSum = 0;
    let weightTotal = 0;
    let benchCount = 0;

    for (const [benchId, vals] of Object.entries(benchScores)) {
      vals.sort((a, b) => a - b);
      const median =
        vals.length % 2 === 0
          ? (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2
          : vals[Math.floor(vals.length / 2)];
      const quality = await getBenchQuality(ctx, benchId as Id<"benches">);
      weightedSum += quality * median;
      weightTotal += quality;
      benchCount++;
    }

    const supraScore = weightTotal > 0 ? weightedSum / weightTotal : 0;

    // Upsert into modelRankings
    const existing = await ctx.db
      .query("modelRankings")
      .withIndex("by_model", (q: any) => q.eq("modelId", modelId))
      .first();

    const data = {
      modelId,
      name: model.name,
      provider: model.provider,
      slug: model.slug,
      familyTag: model.familyTag,
      tags: model.tags,
      supraScore: Math.round(supraScore * 10) / 10,
      benchCount,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, data);
    } else {
      await ctx.db.insert("modelRankings", data);
    }
  },
});

// ── Recompute ALL models (used when bench quality changes) ──
export const recomputeAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    const models = await ctx.db.query("models").collect();
    for (const model of models) {
      const scores = await ctx.db
        .query("modelScores")
        .withIndex("by_model", (q: any) => q.eq("modelId", model._id))
        .collect();

      const benchScores: Record<string, number[]> = {};
      for (const s of scores) {
        if (s.upvotes > s.downvotes) {
          const key = s.benchId as string;
          if (!benchScores[key]) benchScores[key] = [];
          benchScores[key].push(s.normalizedScore);
        }
      }

      let weightedSum = 0;
      let weightTotal = 0;
      let benchCount = 0;

      for (const [benchId, vals] of Object.entries(benchScores)) {
        vals.sort((a, b) => a - b);
        const median =
          vals.length % 2 === 0
            ? (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2
            : vals[Math.floor(vals.length / 2)];
        const quality = await getBenchQuality(ctx, benchId as Id<"benches">);
        weightedSum += quality * median;
        weightTotal += quality;
        benchCount++;
      }

      const supraScore = weightTotal > 0 ? weightedSum / weightTotal : 0;

      const existing = await ctx.db
        .query("modelRankings")
        .withIndex("by_model", (q: any) => q.eq("modelId", model._id))
        .first();

      const data = {
        modelId: model._id,
        name: model.name,
        provider: model.provider,
        slug: model.slug,
        familyTag: model.familyTag,
        tags: model.tags,
        supraScore: Math.round(supraScore * 10) / 10,
        benchCount,
        updatedAt: Date.now(),
      };

      if (existing) {
        await ctx.db.patch(existing._id, data);
      } else {
        await ctx.db.insert("modelRankings", data);
      }
    }
  },
});

// ── Recompute models affected by a specific bench ──
export const recomputeForBench = internalMutation({
  args: { benchId: v.id("benches") },
  handler: async (ctx, { benchId }) => {
    // Find all models that have scores on this bench
    const scores = await ctx.db
      .query("modelScores")
      .withIndex("by_bench", (q: any) => q.eq("benchId", benchId))
      .collect();

    const modelIds = new Set<string>();
    for (const s of scores) {
      modelIds.add(s.modelId as string);
    }

    // Recompute each affected model
    for (const modelId of modelIds) {
      await ctx.scheduler.runAfter(0, "rankings:recomputeModel" as any, {
        modelId: modelId as Id<"models">,
      });
    }
  },
});
