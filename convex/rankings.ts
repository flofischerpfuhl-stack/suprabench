import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

// ── Bench weight = quality × difficulty × headroom ──
//
// quality       : 0-100, mean of the four trust dimensions × 20
// difficulty    : 0-1, (median(difficultyVotes)-1)/4 — community-voted
// headroom      : 0.1-1, automatic saturation penalty
//
// Headroom uses the **top-K frontier-mean** of valid scores (not just top1)
// to be robust against single-model outliers and against premature
// saturation flagging when only one model has been tested:
//
//   N      = # of distinct non-hidden models with ≥1 valid score on this bench
//   K      = min(10, N)            ← only the K best models per bench count
//   front  = mean(top-K medians)   ← per-model bench medians, sorted desc
//
//   if N < 3:           headroom = 1.0    (not enough signal to claim saturation)
//   else:               headroom = max(0.1, (100 − max(front, 50)) / 50)
//
// Floor at 0.1 keeps historical benches in the picture but stops them from
// dominating once everyone solves them — so e.g. ARC-AGI 3 → 4 hand-off
// happens automatically as the new bench's frontier mean is still low.
export const HEADROOM_TOP_K = 10;
export const HEADROOM_MIN_N = 3;
export const HEADROOM_FLOOR = 0.1;
export const HEADROOM_PIVOT = 50;

export async function getBenchWeights(
  ctx: any,
  benchId: Id<"benches">
): Promise<{
  quality: number;
  difficulty: number;
  headroom: number;
  weight: number;
  frontierMean: number;
  modelCount: number;
  topK: number;
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

  // Per-model median of valid scores on this bench (non-hidden models only).
  const scores = await ctx.db
    .query("modelScores")
    .withIndex("by_bench", (q: any) => q.eq("benchId", benchId))
    .collect();
  const perModel: Record<string, number[]> = {};
  for (const s of scores) {
    if (s.upvotes > s.downvotes) {
      const key = s.modelId as string;
      (perModel[key] ??= []).push(s.normalizedScore);
    }
  }
  const modelMedians: number[] = [];
  for (const [modelId, vals] of Object.entries(perModel)) {
    const m = await ctx.db.get(modelId as any);
    if (!m || (m as any).hidden) continue;
    vals.sort((a, b) => a - b);
    const median =
      vals.length % 2 === 0
        ? (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2
        : vals[Math.floor(vals.length / 2)];
    modelMedians.push(median);
  }
  modelMedians.sort((a, b) => b - a); // best first

  const N = modelMedians.length;
  const K = Math.min(HEADROOM_TOP_K, N);
  const topK = K;
  const frontierMean =
    K === 0 ? 0 : modelMedians.slice(0, K).reduce((s, v) => s + v, 0) / K;

  let headroom: number;
  if (N < HEADROOM_MIN_N) {
    headroom = 1.0; // not enough signal yet — don't punish brand-new benches
  } else {
    const pivoted = Math.max(frontierMean, HEADROOM_PIVOT);
    headroom = Math.max(HEADROOM_FLOOR, (100 - pivoted) / (100 - HEADROOM_PIVOT));
  }

  const weight = quality * difficulty * headroom;
  return {
    quality,
    difficulty,
    headroom,
    weight,
    frontierMean,
    modelCount: N,
    topK,
    difficultyAvg,
  };
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
