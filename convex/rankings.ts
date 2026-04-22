import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";

// ── SupraScore: three √-coverage factors stacked ──
//
//   per-bench:  effectiveWeight(b) = Q·D·H · √(u_b/U*) · √(N_b/N*)
//   per-model:  SupraScore(m)      = weightedMean(m)  · √(W_m/W*)
//
// Each √ defends against a distinct, intuitive attack:
//
// • U* = max `cachedNetUpvotes` across non-hidden benches. The
//   upvote-share defends "create a vanity bench, self-rate it
//   5/5/5/5, ranks #1 on the bench leaderboard". Scale-invariant
//   (works on a 5-bench platform exactly as well as on a 500-bench
//   one), so it has to be enforced even at small scale.
//
// • N* = max `cachedModelCount` across non-hidden benches. The
//   model-count-share encodes "how widely is this bench used to
//   evaluate models?" — a bench tested by 1 model gives almost no
//   comparative information; one tested by 30 models gives strong
//   signal. Defends "spawn a community bench and test only your
//   own model on it" without needing any heuristic tuning. Modality
//   asymmetry (image benches naturally cover fewer models than text
//   benches) is intentional: those benches genuinely tell us less
//   about the broader model population.
//
// • W* = max W_m across non-hidden models, where W_m is the model's
//   accumulated bench-weight (already including BOTH per-bench
//   √-factors above). The model-side √ kills the original Sonnet
//   bug where a model tested on a single favourable bench could
//   outrank well-covered competitors.
//
// Properties of the joint formula:
//   • score stays in [0, 100]
//   • zero hyperparameters — U*, N*, W* all come straight from the DB
//   • √-shape mirrors the 1/√N standard-error falloff
//   • monotonic in the model's own scores and coverage
//   • top-covered model always has W_m/W* = 1 (no self-penalty)
//   • top-upvoted bench always has u_b/U* = 1 (no self-penalty)
//   • most-tested bench always has N_b/N* = 1 (no self-penalty)
//   • IIA is intentionally violated on every axis: the table is a
//     relative comparison, so "coverage" only exists in comparison
//     to what else exists.
//
// The catalog of attacks the formula is *meant* to defend against
// is enumerated in tests/convex/adversarial-robustness.test.ts and
// is verified end-to-end on every CI run.
//
// Properties:
//   • score stays in [0, 100]
//   • zero hyperparameters — max totalWeight comes straight from the DB
//   • √-shape mirrors the statistical √N standard-error falloff
//   • monotonic in the model's own scores and coverage
//   • top-covered model always has share=1 (no self-penalty)
//   • IIA is intentionally violated: a new well-tested model moving the
//     max shifts every other model's score proportionally. We accept
//     this because "coverage" is only meaningful relative to the rest
//     of the table.
//
// Everything below is the per-bench weight math — unchanged from before.
//
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

// Per-bench coverage snapshot used by every consumer of the
// SupraScore math (rankings, familyRankings, benches.listRanked,
// benches.getBySlug). Single source of truth — guarantees the bench
// leaderboard's headline number matches what the bench actually
// contributes to a model's SupraScore.
//
// Two axes per bench:
//   • net upvotes u_b  (defends self-rated vanity bench attacks)
//   • distinct model count N_b  (defends single-model vanity bench
//     attacks AND surfaces whether a bench is "actually used")
//
// Both have a max-across-non-hidden-benches denominator (U*, N*),
// which is why this snapshot is built once and reused — otherwise
// different consumers could disagree about U* / N* and the leader
// row could come back inconsistent.
//
// Pre-migration rows fall back to safe defaults:
//   • cachedNetUpvotes  → 1 (the auto-seeded creator vote)
//   • cachedModelCount  → live-counted from modelScores
// so a deployment that hasn't backfilled the bench cache yet still
// gets correct math, just slower.
export interface BenchCoverageIndex {
  upvoteMap: Map<string, number>;
  upvoteMax: number;
  modelCountMap: Map<string, number>;
  modelCountMax: number;
}

export async function getBenchCoverageIndex(
  ctx: any
): Promise<BenchCoverageIndex> {
  const benches = await ctx.db.query("benches").collect();
  const upvoteMap = new Map<string, number>();
  const modelCountMap = new Map<string, number>();
  let upvoteMax = 0;
  let modelCountMax = 0;
  for (const b of benches) {
    const u =
      typeof (b as any).cachedNetUpvotes === "number"
        ? (b as any).cachedNetUpvotes
        : 1;
    let n: number;
    if (typeof (b as any).cachedModelCount === "number") {
      n = (b as any).cachedModelCount;
    } else {
      // Live fallback — count distinct models with net-positive
      // submissions, same definition cache.recomputeBenchAggregates
      // would write. Only triggers on un-backfilled benches.
      const scores = await ctx.db
        .query("modelScores")
        .withIndex("by_bench", (q: any) => q.eq("benchId", b._id))
        .collect();
      const valid = new Set<string>();
      for (const s of scores) {
        if (s.upvotes > s.downvotes) valid.add(s.modelId as string);
      }
      n = valid.size;
    }
    upvoteMap.set(b._id as string, u);
    modelCountMap.set(b._id as string, n);
    if (!(b as any).hidden) {
      if (u > upvoteMax) upvoteMax = u;
      if (n > modelCountMax) modelCountMax = n;
    }
  }
  return { upvoteMap, upvoteMax, modelCountMap, modelCountMax };
}

// Pure fn: per-bench √((u_b/U*) · (N_b/N*)) shrinkage applied to
// the raw Q·D·H weight.
//
// Bootstrap behaviour: if a denominator is 0 (no benches have
// votes / no benches have any scored model) that axis is disabled
// for everybody — otherwise BenchScore would collapse to 0 across
// the board on a brand-new deployment. Each axis is bootstrapped
// independently so a young deployment with votes-but-no-scores
// still gets the upvote defence.
export function effectiveBenchWeight(
  rawWeight: number,
  upvotes: number,
  upvoteMax: number,
  modelCount: number,
  modelCountMax: number
): number {
  const uShare =
    upvoteMax > 0 ? Math.min(1, Math.max(0, upvotes) / upvoteMax) : 1;
  const nShare =
    modelCountMax > 0
      ? Math.min(1, Math.max(0, modelCount) / modelCountMax)
      : 1;
  return rawWeight * Math.sqrt(uShare * nShare);
}

// Compute {weightedMean, totalWeight, benchCount} for ONE model with
// the per-bench √(u_b/U*) shrinkage already folded into the weights.
// Does NOT write anything — caller composes the per-model aggregates
// from every model, finds max totalWeight, then writes modelRankings
// in a second pass.
async function computeAggregate(
  ctx: any,
  modelId: Id<"models">,
  cov: BenchCoverageIndex
) {
  const model = await ctx.db.get(modelId);
  if (!model) return null;

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
    const u = cov.upvoteMap.get(benchId) ?? 1;
    const n = cov.modelCountMap.get(benchId) ?? 0;
    const effective = effectiveBenchWeight(
      w.weight,
      u,
      cov.upvoteMax,
      n,
      cov.modelCountMax
    );
    if (effective <= 0) continue;
    weightedSum += effective * median;
    weightTotal += effective;
    benchCount++;
  }

  const weightedMean = weightTotal > 0 ? weightedSum / weightTotal : 0;

  return {
    modelId,
    model,
    weightedMean,
    totalWeight: weightTotal,
    benchCount,
  };
}

// Upsert the modelRankings row for ONE model given the pre-computed
// aggregate + the global maxTotalWeight. coverageShare = 1 when the
// model IS the max — no self-penalty at the top.
async function writeRanking(
  ctx: any,
  agg: {
    modelId: Id<"models">;
    model: any;
    weightedMean: number;
    totalWeight: number;
    benchCount: number;
  },
  maxTotalWeight: number
) {
  const share =
    maxTotalWeight > 0 ? Math.min(1, agg.totalWeight / maxTotalWeight) : 0;
  const supraScore = agg.weightedMean * Math.sqrt(share);

  const existing = await ctx.db
    .query("modelRankings")
    .withIndex("by_model", (q: any) => q.eq("modelId", agg.modelId))
    .first();

  const data = {
    modelId: agg.modelId,
    name: agg.model.name,
    provider: agg.model.provider,
    slug: agg.model.slug,
    familyTag: agg.model.familyTag,
    tags: agg.model.tags,
    supraScore: Math.round(supraScore * 10) / 10,
    benchCount: agg.benchCount,
    updatedAt: Date.now(),
    // Mirror models.hidden so listRanked never has to do an N×db.get loop.
    hidden: agg.model.hidden ?? false,
  };

  if (existing) await ctx.db.patch(existing._id, data);
  else await ctx.db.insert("modelRankings", data);
}

// The one function that actually re-ranks everything. Called by
// recomputeAll, recomputeModel, and recomputeForBench because every
// score / bench change potentially shifts maxTotalWeight, and
// maxTotalWeight appears in every model's SupraScore — so a fully
// correct update requires a full-table pass.
//
// For the scales we're at (< 1k models, < 100 benches) this is fine;
// if we ever outgrow it, the right optimisation is to cache the
// aggregate per model and only re-aggregate the changed ones.
async function recomputeAllImpl(ctx: any) {
  const models = await ctx.db.query("models").collect();

  // U*, N* and per-bench coverage maps — single snapshot used by
  // every per-model aggregate so the math is internally consistent
  // (no chance of one model seeing a different U* than another).
  const cov = await getBenchCoverageIndex(ctx);

  const aggregates: Awaited<ReturnType<typeof computeAggregate>>[] = [];
  for (const m of models) {
    const agg = await computeAggregate(ctx, m._id, cov);
    if (agg) aggregates.push(agg);
  }

  // Hidden models don't influence the coverage denominator — otherwise
  // a single mothballed flagship with huge coverage would permanently
  // squash every real entrant.
  let maxTotalWeight = 0;
  for (const a of aggregates) {
    if (a!.model.hidden) continue;
    if (a!.totalWeight > maxTotalWeight) maxTotalWeight = a!.totalWeight;
  }

  for (const a of aggregates) {
    await writeRanking(ctx, a!, maxTotalWeight);
  }
}

export const recomputeModel = internalMutation({
  args: { modelId: v.id("models") },
  handler: async (ctx) => {
    // Coverage-share couples every model's score to every other
    // model's totalWeight, so even a single-model update triggers a
    // full re-rank. Cheaper than you'd think at current scale.
    await recomputeAllImpl(ctx);
    // Cascade to family rankings. We intentionally schedule rather
    // than run inline so the mutation's transaction stays small.
    await ctx.scheduler.runAfter(0, internal.familyRankings.recomputeAll, {});
  },
});

export const recomputeAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    await recomputeAllImpl(ctx);
    // Inline (not scheduled) so a single recomputeAll call leaves the
    // DB in a fully consistent state on return — migrations rely on it.
    await ctx.runMutation(internal.familyRankings.recomputeAll, {});
  },
});

export const recomputeForBench = internalMutation({
  args: { benchId: v.id("benches") },
  handler: async (ctx) => {
    // Bench-weight changes (quality ratings, headroom recomputation,
    // etc.) shift totalWeight for every model that's been tested on
    // that bench — so again we do a full re-rank, same as recomputeAll.
    await recomputeAllImpl(ctx);
    await ctx.scheduler.runAfter(0, internal.familyRankings.recomputeAll, {});
  },
});
