// ════════════════════════════════════════════════════════════
// Denormalized read-side caches.
//
// All hot listing queries used to recompute aggregates on every
// subscription re-run, which made bandwidth and function-call
// usage scale O(rows × subscribers) — bad for the Convex free
// tier under any kind of viral load.
//
// This file owns the recompute-and-patch logic that keeps the
// cached fields on `benches`, `modelRankings`, and `tagCounts`
// in sync. Mutations call into here whenever something changes
// that affects a cached aggregate.
//
// Invariant: every cached value is derived state. The original
// source-of-truth records (benchQualityRatings, modelScores,
// tagVotes, models.hidden) are never inferred from the cache.
// Worst case if a cache row is stale or missing: queries fall
// back to live compute, results are correct but slower.
// ════════════════════════════════════════════════════════════

import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import {
  HEADROOM_TOP_K,
  HEADROOM_MIN_N,
  HEADROOM_FLOOR,
  HEADROOM_PIVOT,
} from "./rankings";

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Bench aggregates ────────────────────────────────────────
//
// Recomputes everything that benches.listRanked / benches.getBySlug
// previously computed inline:
//   - quality dimensions + qualityScore
//   - rater count
//   - distinct model count (only valid scores, only non-hidden models)
//   - frontier mean + headroom + difficulty multiplier + effective weight
//
// O(scores + N db.gets for distinct models). Only runs on mutations,
// so this cost is amortized across many reads.
export async function recomputeBenchAggregatesInline(
  ctx: any,
  benchId: Id<"benches">
): Promise<void> {
  const bench = await ctx.db.get(benchId);
  if (!bench) return;

  const ratings = await ctx.db
    .query("benchQualityRatings")
    .withIndex("by_bench", (q: any) => q.eq("benchId", benchId))
    .collect();

  const dim = {
    relevance: 0,
    contamination: 0,
    discriminability: 0,
    reproducibility: 0,
    difficulty: 0,
  };
  let qualityScore = 50;
  let difficultyAvg = 3;

  if (ratings.length > 0) {
    dim.relevance =
      ratings.reduce((s: number, r: any) => s + r.relevance, 0) / ratings.length;
    dim.contamination =
      ratings.reduce((s: number, r: any) => s + r.contamination, 0) /
      ratings.length;
    dim.discriminability =
      ratings.reduce((s: number, r: any) => s + r.discriminability, 0) /
      ratings.length;
    dim.reproducibility =
      ratings.reduce((s: number, r: any) => s + r.reproducibility, 0) /
      ratings.length;
    const diffs = ratings.map((r: any) =>
      typeof r.difficulty === "number" ? r.difficulty : 3
    );
    dim.difficulty = diffs.reduce((s: number, d: number) => s + d, 0) / diffs.length;

    qualityScore =
      ((dim.relevance +
        dim.contamination +
        dim.discriminability +
        dim.reproducibility) /
        4) *
      20;

    // Median difficulty matches rankings.getBenchWeights() — keep in sync!
    const sorted = [...diffs].sort((a, b) => a - b);
    difficultyAvg =
      sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];
  }

  const difficulty = Math.max(0, Math.min(1, (difficultyAvg - 1) / 4));

  const scores = await ctx.db
    .query("modelScores")
    .withIndex("by_bench", (q: any) => q.eq("benchId", benchId))
    .collect();

  const perModel: Record<string, number[]> = {};
  for (const s of scores) {
    if (s.upvotes > s.downvotes) {
      (perModel[s.modelId as string] ??= []).push(s.normalizedScore);
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
  modelMedians.sort((a, b) => b - a);

  const N = modelMedians.length;
  const K = Math.min(HEADROOM_TOP_K, N);
  const frontierMean =
    K === 0 ? 0 : modelMedians.slice(0, K).reduce((s, v) => s + v, 0) / K;

  let headroom: number;
  if (N < HEADROOM_MIN_N) {
    headroom = 1.0;
  } else {
    const pivoted = Math.max(frontierMean, HEADROOM_PIVOT);
    headroom = Math.max(
      HEADROOM_FLOOR,
      (100 - pivoted) / (100 - HEADROOM_PIVOT)
    );
  }

  const effectiveWeight = qualityScore * difficulty * headroom;

  await ctx.db.patch(benchId, {
    cachedQualityScore: round1(qualityScore),
    cachedDimensions: {
      relevance: round1(dim.relevance),
      contamination: round1(dim.contamination),
      discriminability: round1(dim.discriminability),
      reproducibility: round1(dim.reproducibility),
      difficulty: round1(dim.difficulty),
    },
    cachedRaterCount: ratings.length,
    cachedModelCount: N,
    cachedFrontierMean: round1(frontierMean),
    cachedHeadroom: round2(headroom),
    cachedDifficultyMultiplier: round2(difficulty),
    cachedEffectiveWeight: round1(effectiveWeight),
    cachedTopK: K,
    cachedAggregatesAt: Date.now(),
  });
}

// Scheduler-callable wrapper. Use this from mutations via:
//   ctx.scheduler.runAfter(0, internal.cache.recomputeBenchAggregates, { benchId })
export const recomputeBenchAggregates = internalMutation({
  args: { benchId: v.id("benches") },
  handler: async (ctx, { benchId }) => {
    await recomputeBenchAggregatesInline(ctx, benchId);
  },
});

// Recompute just the net-upvote count for a bench. Cheap; called from
// entityVotes.cast on every vote change. Floored at 0 because a bench
// with negative net is either already hidden by shouldHide() or about
// to be — either way it shouldn't push down the SupraScore math by
// going negative.
export async function recomputeBenchNetUpvotesInline(
  ctx: any,
  benchId: Id<"benches">
): Promise<void> {
  const votes = await ctx.db
    .query("entityVotes")
    .withIndex("by_entity", (q: any) =>
      q.eq("entityType", "bench").eq("entityId", benchId as string)
    )
    .collect();
  let ups = 0;
  let downs = 0;
  for (const v of votes) {
    if (v.value === 1) ups++;
    else downs++;
  }
  const net = Math.max(0, ups - downs);
  await ctx.db.patch(benchId, { cachedNetUpvotes: net });
}

// Bulk recompute for all benches that have at least one score from
// the given model. Used when a model toggles hidden state — its
// scores' contribution to the per-bench frontier mean changes.
export const recomputeBenchAggregatesForModel = internalMutation({
  args: { modelId: v.id("models") },
  handler: async (ctx, { modelId }) => {
    const scores = await ctx.db
      .query("modelScores")
      .withIndex("by_model", (q) => q.eq("modelId", modelId))
      .collect();
    const benchIds = new Set<string>();
    for (const s of scores) benchIds.add(s.benchId as string);
    for (const benchId of benchIds) {
      await recomputeBenchAggregatesInline(ctx, benchId as Id<"benches">);
    }
  },
});

// ── modelRankings.hidden mirror ─────────────────────────────
export async function syncModelRankingHiddenInline(
  ctx: any,
  modelId: Id<"models">,
  hidden: boolean
): Promise<void> {
  const ranking = await ctx.db
    .query("modelRankings")
    .withIndex("by_model", (q: any) => q.eq("modelId", modelId))
    .first();
  if (ranking && (ranking.hidden ?? false) !== hidden) {
    await ctx.db.patch(ranking._id, { hidden });
  }
}

// ── tagCounts cache ─────────────────────────────────────────
//
// Maintained incrementally: each call diffs the previous effective
// tag set against the new one and increments / decrements the
// per-tag counter accordingly. Cheaper than full rebuild but still
// idempotent — running applyTagDelta with oldTags == newTags is a no-op.
export async function applyTagDeltaInline(
  ctx: any,
  entityType: "model" | "bench",
  oldTags: string[],
  newTags: string[]
): Promise<void> {
  const oldSet = new Set(oldTags);
  const newSet = new Set(newTags);
  const added = newTags.filter((t) => !oldSet.has(t));
  const removed = oldTags.filter((t) => !newSet.has(t));

  for (const tag of added) {
    await bumpTag(ctx, tag, entityType, +1);
  }
  for (const tag of removed) {
    await bumpTag(ctx, tag, entityType, -1);
  }
}

async function bumpTag(
  ctx: any,
  tag: string,
  entityType: "model" | "bench",
  delta: number
): Promise<void> {
  const existing = await ctx.db
    .query("tagCounts")
    .withIndex("by_tag", (q: any) => q.eq("tag", tag))
    .first();

  if (!existing) {
    if (delta <= 0) return; // never insert with non-positive count
    await ctx.db.insert("tagCounts", {
      tag,
      benches: entityType === "bench" ? delta : 0,
      models: entityType === "model" ? delta : 0,
    });
    return;
  }

  const benches =
    entityType === "bench" ? Math.max(0, existing.benches + delta) : existing.benches;
  const models =
    entityType === "model" ? Math.max(0, existing.models + delta) : existing.models;

  if (benches === 0 && models === 0) {
    await ctx.db.delete(existing._id);
  } else {
    await ctx.db.patch(existing._id, { benches, models });
  }
}
