import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

// ── Bench weight = quality × difficulty × headroom ──
// quality       : 0-100, mean of the four trust dimensions × 20
// difficulty    : 0-1, (median(difficulty)-1)/4 — community-voted
// headroom      : 0-1, soft penalty as the bench saturates
//                 - SOTA ≤ 50 → 1.0  (lots of headroom left)
//                 - SOTA = 75 → 0.5
//                 - SOTA ≥ 100 → 0.1 (floor — never zero out completely)
//
// The two extra factors solve "old benches drown out new ones" without
// requiring users to retroactively rate older benches down. As frontier
// models saturate a bench, headroom collapses → bench naturally loses
// weight → newer/harder benches dominate.
export async function getBenchWeights(
  ctx: any,
  benchId: Id<"benches">
): Promise<{
  quality: number;
  difficulty: number;
  headroom: number;
  weight: number;
  top1: number;
  difficultyAvg: number;
}> {
  const ratings = await ctx.db
    .query("benchQualityRatings")
    .withIndex("by_bench", (q: any) => q.eq("benchId", benchId))
    .collect();

  let quality = 50; // default neutral until anyone rates
  let difficultyAvg = 3; // default mid until anyone rates
  if (ratings.length > 0) {
    quality =
      (ratings.reduce(
        (sum: number, r: any) =>
          sum +
          (r.relevance + r.contamination + r.discriminability + r.reproducibility) /
            4,
        0
      ) /
        ratings.length) *
      20;
    const diffs = ratings
      .map((r: any) => (typeof r.difficulty === "number" ? r.difficulty : 3))
      .sort((a: number, b: number) => a - b);
    difficultyAvg =
      diffs.length % 2 === 0
        ? (diffs[diffs.length / 2 - 1] + diffs[diffs.length / 2]) / 2
        : diffs[Math.floor(diffs.length / 2)];
  }
  const difficulty = Math.max(0, Math.min(1, (difficultyAvg - 1) / 4));

  // SOTA on this bench across all valid scores from non-hidden models.
  const scores = await ctx.db
    .query("modelScores")
    .withIndex("by_bench", (q: any) => q.eq("benchId", benchId))
    .collect();
  let top1 = 0;
  for (const s of scores) {
    if (s.upvotes > s.downvotes) {
      const m = await ctx.db.get(s.modelId);
      if (m && !(m as any).hidden && s.normalizedScore > top1) {
        top1 = s.normalizedScore;
      }
    }
  }
  const sota = Math.max(top1, 50);
  const headroom = Math.max(0.1, (100 - sota) / 50);

  const weight = quality * difficulty * headroom;
  return { quality, difficulty, headroom, weight, top1, difficultyAvg };
}

async function recomputeOne(ctx: any, modelId: Id<"models">) {
  const model = await ctx.db.get(modelId);
  if (!model) return;

  const scores = await ctx.db
    .query("modelScores")
    .withIndex("by_model", (q: any) => q.eq("modelId", modelId))
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
    const w = await getBenchWeights(ctx, benchId as Id<"benches">);
    weightedSum += w.weight * median;
    weightTotal += w.weight;
    benchCount++;
  }

  const supraScore = weightTotal > 0 ? weightedSum / weightTotal : 0;

  const existing = await ctx.db
    .query("modelRankings")
    .withIndex("by_model", (q: any) => q.eq("modelId", modelId))
    .first();

  const data = {
    modelId,
    name: (model as any).name,
    provider: (model as any).provider,
    slug: (model as any).slug,
    familyTag: (model as any).familyTag,
    tags: (model as any).tags,
    supraScore: Math.round(supraScore * 10) / 10,
    benchCount,
    updatedAt: Date.now(),
  };

  if (existing) await ctx.db.patch(existing._id, data);
  else await ctx.db.insert("modelRankings", data);
}

export const recomputeModel = internalMutation({
  args: { modelId: v.id("models") },
  handler: async (ctx, { modelId }) => {
    await recomputeOne(ctx, modelId);
  },
});

export const recomputeAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    const models = await ctx.db.query("models").collect();
    for (const m of models) {
      await recomputeOne(ctx, m._id);
    }
  },
});

export const recomputeForBench = internalMutation({
  args: { benchId: v.id("benches") },
  handler: async (ctx, { benchId }) => {
    const scores = await ctx.db
      .query("modelScores")
      .withIndex("by_bench", (q: any) => q.eq("benchId", benchId))
      .collect();
    const seen = new Set<string>();
    for (const s of scores) seen.add(s.modelId as string);
    for (const id of seen) await recomputeOne(ctx, id as Id<"models">);
  },
});
