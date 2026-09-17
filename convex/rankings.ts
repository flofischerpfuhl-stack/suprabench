import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { fetchAllScoresFromD1, D1ScoreRow } from "./scoresWorker";
import { recomputeBenchAggregatesInline } from "./cache";
// Side-effect import: the shared core attaches itself to globalThis so the
// exact same file can be served to browsers from public/js/.
import "../public/js/supra-rank-core.js";

const supraRankCore = (globalThis as any).SupraRankCore as {
  rank: (input: unknown) => unknown;
  benchWeight: (bench: unknown, upvoteMax: number) => number;
  canonicalFamilyTag: (name: string, tag?: string | null) => string | undefined;
  constants: Record<string, number | string>;
};

// ── SupraScore: one pairwise fit for configurations and families ──
//
// The ranking math itself lives in public/js/supra-rank-core.js — plain
// JavaScript that this module, the browser's tag-filtered leaderboard and
// the what-if simulator all load, so the three can never drift apart.
// This file owns everything around it: per-bench weight inputs (quality,
// difficulty, headroom, upvote share), loading, persisting, and the two
// rebuild drivers.
//
//   cell(m,b)   = median of valid submissions
//   w(b)        = Q·D·H · (u_b/U*)        ratings shrunk toward neutral with
//                                         a 3-rater prior while raters are few
//   duels       = every pair of configurations on every bench, each duel
//                 weighted w(b)/mean(w)/(n_b − 1)
//   ability     = regularized Bradley-Terry fit over all duels (λ = 0.15)
//   SupraScore  = 100 · mean P(beat k) over the current top-10 configurations
//   family      = its best configuration from the same fit, provided that
//                 configuration covers ≥ 50 % of the family's bench weight
//
// Why pairwise instead of a weighted mean of raw percentages: a point does
// not mean the same thing on every bench (5 % leads ARC-AGI-3, 98 % is
// ordinary on Tau2), and "first of 90" is not "first of 8". Duels are
// scale-free, and the global fit prices in how strong each field was.
//
// What is unchanged: community quality ratings, median difficulty, the
// automatic saturation headroom, the linear net-upvote share, the median
// per (model, bench) cell, and hidden-entity exclusion. A saturated bench
// still fades out through H; a bench the community endorses still
// outweighs one it does not through u_b/U*.
//
// The attack catalog this is meant to withstand is executable:
// tests/convex/adversarial-robustness.test.ts.
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
// Families with fewer distinct benchmarks than this stay visible but are
// flagged provisional. Mirrors PROVISIONAL_MIN_BENCHES in the shared core.
export const FAMILY_REPRESENTATIVE_MIN_BENCHES = 3;

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

// Per-bench trust/evidence snapshot used by every consumer of the
// SupraScore math (rankings, familyRankings, benches.listRanked,
// benches.getBySlug). Single source of truth — guarantees the bench
// leaderboard's headline number matches what the bench actually
// contributes to a model's ability mean, while the evidence path uses
// the same denominators for confidence.
//
// Two axes per bench:
//   • net upvotes u_b  (community trust and bench ability weight)
//   • distinct model count N_b  (evidence breadth / confidence only)
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

// Pure fn: per-bench u_b/U* trust multiplier applied to the raw
// Q·D·H weight. This is the central ability weight used in weighted
// means and displayed as Bench Weight.
//
// Bootstrap behaviour: if a denominator is 0 (no benches have
// votes anywhere) this axis is disabled for everybody — otherwise
// BenchWeight would collapse to 0 across the board on a brand-new
// deployment.
export function effectiveBenchWeight(
  rawWeight: number,
  upvotes: number,
  upvoteMax: number,
  modelCount: number,
  modelCountMax: number
): number {
  const uShare =
    upvoteMax > 0 ? Math.min(1, Math.max(0, upvotes) / upvoteMax) : 1;
  void modelCount;
  void modelCountMax;
  return rawWeight * uShare;
}

// ════════════════════════════════════════════════════════════
// UNIFIED REBUILD
//
// Loads every model, every bench, and every modelScore EXACTLY
// ONCE and uses that snapshot to rebuild BOTH `modelRankings`
// and `familyRankings` in a single pass.
//
// Two drivers, one compute kernel:
//   • Convex-db driver  — recomputeAllUnifiedImpl, used by tests
//                         + seed + migrations. Reads from the
//                         Convex modelScores table.
//   • D1 action driver  — recomputeFromD1*, used in production.
//                         Fetches scores from the Cloudflare
//                         worker so the per-event Convex
//                         bandwidth stays flat as score volume
//                         grows. See scoresWorker.ts.
//
// Both drivers feed the same buildRankingsFromInputs() pure
// function, so SupraScores, family aggregates, hidden flags,
// and idempotency are identical regardless of which path runs.
// ════════════════════════════════════════════════════════════

// ── Score-shape adapter ─────────────────────────────────────
// Scores come from two places:
//   • Convex modelScores (tests / seed / migrations)
//   • Cloudflare D1 via the scores worker (production rebuild)
// The compute below treats them structurally so either source works.
export type ScoreLike = {
  modelId: string;
  benchId: string;
  normalizedScore: number;
  upvotes: number;
  downvotes: number;
};

type ModelRankingData = {
  modelId: Id<"models">;
  name: string;
  provider: string;
  slug: string;
  familyTag?: string;
  tags: string[];
  supraScore: number;
  benchCount: number;
  hidden: boolean;
};

export type FamilyAggregationMethod =
  | "family-ceiling-pairwise" // rows written before the unified fit
  | "best-configuration-pairwise";

type FamilyRankingData = {
  familyTag: string;
  provider: string;
  supraScore: number;
  benchCount: number;
  modelCount: number;
  representativeModelId?: Id<"models">;
  representativeName?: string;
  representativeSlug?: string;
  aggregationMethod: "best-configuration-pairwise";
  provisional: boolean;
  tags: string[];
  hidden: boolean;
};

export type CoreRanking = {
  configs: Array<{
    modelId: string;
    ability: number | null;
    supraScore: number;
    benchCount: number;
  }>;
  families: Array<{
    familyKey: string;
    familyTag: string;
    provider: string;
    supraScore: number;
    ability: number | null;
    benchCount: number;
    modelCount: number;
    representativeModelId?: string;
    representativeName?: string;
    representativeSlug?: string;
    provisional: boolean;
    tags: string[];
    hidden: boolean;
  }>;
  upvoteMax: number;
};

// Typed entry point into the shared core. `benchFilter` restricts the fit
// to a subset of benches (tag-filtered views).
export function rankWithCore(args: {
  models: any[];
  benches: any[];
  scores: ScoreLike[] | Array<{ modelId: string; benchId: string; normalizedScore: number }>;
  benchFilter?: (bench: any) => boolean;
}): CoreRanking {
  return supraRankCore.rank(args) as CoreRanking;
}

// ── Pure compute: inputs already loaded, output = rows to write ─────
function buildRankingsFromInputs(args: {
  models: any[];
  benches: any[];
  scores: ScoreLike[];
}): {
  modelRows: ModelRankingData[];
  familyRows: FamilyRankingData[];
  validFamilyKeys: Set<string>;
} {
  const ranking = rankWithCore(args);
  const configByModel = new Map(ranking.configs.map((row) => [row.modelId, row]));

  // Hidden models keep a ranking row (so un-hiding is instant) but take no
  // part in the fit and carry no score.
  const modelRows: ModelRankingData[] = args.models.map((m: any) => {
    const config = configByModel.get(m._id as string);
    return {
      modelId: m._id as Id<"models">,
      name: m.name,
      provider: m.provider,
      slug: m.slug,
      familyTag: m.familyTag,
      tags: m.tags,
      supraScore: config?.supraScore ?? 0,
      benchCount: config?.benchCount ?? 0,
      hidden: m.hidden ?? false,
    };
  });

  const validFamilyKeys = new Set<string>();
  const familyRows: FamilyRankingData[] = ranking.families.map((family) => {
    validFamilyKeys.add(family.familyKey);
    return {
      familyTag: family.familyTag,
      provider: family.provider,
      supraScore: family.supraScore,
      benchCount: family.benchCount,
      modelCount: family.modelCount,
      representativeModelId: family.representativeModelId as
        | Id<"models">
        | undefined,
      representativeName: family.representativeName,
      representativeSlug: family.representativeSlug,
      aggregationMethod: "best-configuration-pairwise",
      provisional: family.provisional,
      tags: family.tags,
      hidden: family.hidden,
    };
  });

  return { modelRows, familyRows, validFamilyKeys };
}

// ── Persist: write the computed rows + delete stale family rows ──
// Shared by both the Convex-db driver (called inline from a
// mutation) and the D1 action driver (called via runMutation).
async function persistRankings(
  ctx: any,
  out: {
    modelRows: ModelRankingData[];
    familyRows: FamilyRankingData[];
    validFamilyKeys: Set<string>;
  }
): Promise<{ models: number; families: number; familiesDeleted: number }> {
  const updatedAt = Date.now();

  for (const row of out.modelRows) {
    const existing = await ctx.db
      .query("modelRankings")
      .withIndex("by_model", (q: any) => q.eq("modelId", row.modelId))
      .first();
    const data = { ...row, updatedAt };
    if (existing) await ctx.db.patch(existing._id, data);
    else await ctx.db.insert("modelRankings", data);
  }

  // Stale rows happen on rename / familyTag-change / model delete.
  const existingFamilyRows = await ctx.db.query("familyRankings").collect();
  let familiesDeleted = 0;
  for (const r of existingFamilyRows) {
    const key = `${r.familyTag}\u0000${r.provider}`;
    if (!out.validFamilyKeys.has(key)) {
      await ctx.db.delete(r._id);
      familiesDeleted++;
    }
  }

  for (const row of out.familyRows) {
    const data = { ...row, updatedAt };
    const existing = await ctx.db
      .query("familyRankings")
      .withIndex("by_family_provider", (q: any) =>
        q.eq("familyTag", row.familyTag).eq("provider", row.provider)
      )
      .first();
    if (existing) await ctx.db.patch(existing._id, data);
    else await ctx.db.insert("familyRankings", data);
  }

  return {
    models: out.modelRows.length,
    families: out.familyRows.length,
    familiesDeleted,
  };
}

// ════════════════════════════════════════════════════════════
//  DRIVER 1: Convex-db source (legacy path)
//
//  Used by tests, seed:finalize, and migrations.ts. Reads scores
//  straight from the Convex modelScores table — same code path
//  the rebuild has used since day one.
//
//  In production this entry point is no longer wired up to
//  submissions/votes — those now schedule the D1 action below.
//  We keep this around because (a) tests don't have a worker to
//  fetch from, (b) it's a useful "cold-rebuild from authoritative
//  Convex state" tool when D1 needs re-bootstrapping.
// ════════════════════════════════════════════════════════════
export async function recomputeAllUnifiedImpl(ctx: any): Promise<{
  models: number;
  families: number;
  familiesDeleted: number;
}> {
  const allModels = await ctx.db.query("models").collect();
  const allBenches = await ctx.db.query("benches").collect();

  // Per-model scores read pass.
  const flatScores: ScoreLike[] = [];
  for (const m of allModels) {
    const rows = await ctx.db
      .query("modelScores")
      .withIndex("by_model", (q: any) => q.eq("modelId", m._id))
      .collect();
    for (const s of rows) {
      flatScores.push({
        modelId: s.modelId as string,
        benchId: s.benchId as string,
        normalizedScore: s.normalizedScore,
        upvotes: s.upvotes,
        downvotes: s.downvotes,
      });
    }
  }

  // The core reads each bench's denormalised rating/headroom cache. A bench
  // that has never been aggregated (fresh seed, tests) is aggregated now so
  // it enters the fit with real inputs instead of neutral defaults.
  let benches = allBenches;
  let warmed = false;
  for (const b of allBenches) {
    if (
      (b as any).cachedDimensions === undefined ||
      typeof (b as any).cachedHeadroom !== "number"
    ) {
      await recomputeBenchAggregatesInline(ctx, b._id as Id<"benches">);
      warmed = true;
    }
  }
  if (warmed) benches = await ctx.db.query("benches").collect();

  const out = buildRankingsFromInputs({
    models: allModels,
    benches,
    scores: flatScores,
  });
  return persistRankings(ctx, out);
}

export const recomputeModel = internalMutation({
  args: { modelId: v.id("models") },
  handler: async (ctx) => {
    // Evidence share couples every model's score to every other
    // model's evidence weight, so even a single-model update triggers
    // a full re-rank. Used by tests + seed only — production
    // submissions/votes call recomputeFromD1 instead.
    await recomputeAllUnifiedImpl(ctx);
  },
});

export const recomputeAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    await recomputeAllUnifiedImpl(ctx);
  },
});

export const recomputeForBench = internalMutation({
  args: { benchId: v.id("benches") },
  handler: async (ctx) => {
    await recomputeAllUnifiedImpl(ctx);
  },
});

// ════════════════════════════════════════════════════════════
//  DRIVER 2: D1 source (production path)
//
//  Used by submissions / votes / benchQualityRatings. The whole
//  reason this exists: scores are the dominant per-rebuild read
//  cost and Convex bandwidth is the binding constraint. By
//  pulling them from D1 (which has no egress meter on the free
//  tier) we can rebuild rankings without touching the Convex
//  bandwidth quota.
//
//  Composition:
//    1. _loadInputsForRebuild query → models + benches (cheap,
//       both tables small, both cached on the bench row include
//       cachedEffectiveWeight so no rating reads needed).
//    2. fetchAllScoresFromD1() → score snapshot from the worker.
//    3. buildRankingsFromInputs() → pure compute.
//    4. _persistRankings mutation → write modelRankings +
//       familyRankings, delete stale family rows.
//
//  Each step runs in its own runtime: the action does HTTP
//  + arithmetic in the action runtime, the load + persist run
//  in their own (atomic) transactions. Read budget on each
//  transaction is a small constant (M + B for load; M + F for
//  persist) so we comfortably stay under the 32k per-mutation
//  document-read cap regardless of submission volume.
// ════════════════════════════════════════════════════════════

export const _loadInputsForRebuild = internalQuery({
  args: {},
  handler: async (ctx) => {
    const models = await ctx.db.query("models").collect();
    const benches = await ctx.db.query("benches").collect();
    return { models, benches };
  },
});

export const _persistRankings = internalMutation({
  args: {
    modelRows: v.array(
      v.object({
        modelId: v.id("models"),
        name: v.string(),
        provider: v.string(),
        slug: v.string(),
        familyTag: v.optional(v.string()),
        tags: v.array(v.string()),
        supraScore: v.number(),
        benchCount: v.number(),
        hidden: v.boolean(),
      })
    ),
    familyRows: v.array(
      v.object({
        familyTag: v.string(),
        provider: v.string(),
        supraScore: v.number(),
        benchCount: v.number(),
        modelCount: v.number(),
        representativeModelId: v.optional(v.id("models")),
        representativeName: v.optional(v.string()),
        representativeSlug: v.optional(v.string()),
        aggregationMethod: v.literal("best-configuration-pairwise"),
        provisional: v.boolean(),
        tags: v.array(v.string()),
        hidden: v.boolean(),
      })
    ),
    validFamilyKeys: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    return persistRankings(ctx, {
      modelRows: args.modelRows,
      familyRows: args.familyRows,
      validFamilyKeys: new Set(args.validFamilyKeys),
    });
  },
});

async function recomputeFromD1Impl(ctx: any) {
  const { models, benches } = await ctx.runQuery(
    internal.rankings._loadInputsForRebuild,
    {}
  );

  const d1Scores: D1ScoreRow[] = await fetchAllScoresFromD1();
  const scores: ScoreLike[] = d1Scores.map((s) => ({
    modelId: s.modelId,
    benchId: s.benchId,
    normalizedScore: s.normalizedScore,
    upvotes: s.upvotes,
    downvotes: s.downvotes,
  }));

  const out = buildRankingsFromInputs({ models, benches, scores });

  await ctx.runMutation(internal.rankings._persistRankings, {
    modelRows: out.modelRows,
    familyRows: out.familyRows,
    validFamilyKeys: Array.from(out.validFamilyKeys),
  });

  return {
    models: out.modelRows.length,
    families: out.familyRows.length,
  };
}

// Production entry points. These mirror the names of the legacy
// mutation entries so callers only swap the module path. We
// intentionally do NOT discriminate on `modelId` / `benchId`:
// the SupraScore is globally coupled (every model's score depends
// on every other model's evidence weight), so any change requires a
// full rebuild regardless. The arg lets future incremental work
// route differently without changing the caller contract.
export const recomputeFromD1 = internalAction({
  args: {},
  handler: async (ctx) => recomputeFromD1Impl(ctx),
});

export const recomputeModelFromD1 = internalAction({
  args: { modelId: v.id("models") },
  handler: async (ctx) => recomputeFromD1Impl(ctx),
});

export const recomputeForBenchFromD1 = internalAction({
  args: { benchId: v.id("benches") },
  handler: async (ctx) => recomputeFromD1Impl(ctx),
});
