import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { fetchAllScoresFromD1, D1ScoreRow } from "./scoresWorker";

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

function normalizeFamilyKey(
  familyTag: string | undefined | null
): string | null {
  if (!familyTag) return null;
  const t = familyTag.trim();
  return t.length === 0 ? null : t;
}

function medianOf(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  return s.length % 2 === 0
    ? (s[s.length / 2 - 1] + s[s.length / 2]) / 2
    : s[Math.floor(s.length / 2)];
}

// ── Score-shape adapter ─────────────────────────────────────
// We read scores from two places now:
//   • Convex modelScores (legacy / tests / seed / migrations)
//   • Cloudflare D1 via the scores worker (production rebuild)
// Both produce the same logical row but with different keys
// (Convex uses _id + Id<"models"> branded strings; D1 uses
// convex_id + plain strings). The pure compute below treats
// scores as a structural type so either source works.
type ScoreLike = {
  modelId: string;
  benchId: string;
  normalizedScore: number;
  upvotes: number;
  downvotes: number;
};

// ── Pure compute: all the SupraScore math, no DB access ─────
// Inputs are already-loaded snapshots; output is the rows we
// want to write. Persisting + stale-row cleanup happen in the
// driver functions below so this stays trivially testable and
// reusable across the Convex-db and D1-action code paths.
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

type FamilyRankingData = {
  familyTag: string;
  provider: string;
  supraScore: number;
  benchCount: number;
  modelCount: number;
  tags: string[];
  hidden: boolean;
};

function buildRankingsFromInputs(args: {
  models: any[];
  benches: any[];
  scores: ScoreLike[];
  // Optional fallback: if a bench has no cachedEffectiveWeight,
  // we need ITS Q·D·H from somewhere. Convex-db driver passes
  // a cache pre-populated via getBenchWeights. D1 driver passes
  // an empty map and any missing weight degrades to 0 (the bench
  // is silently excluded). In steady-state production, every
  // bench has a cache so this never triggers.
  weightFallback?: Map<string, number>;
}): {
  modelRows: ModelRankingData[];
  familyRows: FamilyRankingData[];
  validFamilyKeys: Set<string>;
} {
  const { models: allModels, benches: allBenches, scores, weightFallback } = args;

  // Group scores by model up-front (single pass).
  const scoresByModel = new Map<string, ScoreLike[]>();
  for (const s of scores) {
    let arr = scoresByModel.get(s.modelId);
    if (!arr) {
      arr = [];
      scoresByModel.set(s.modelId, arr);
    }
    arr.push(s);
  }

  // ─── 1. Coverage index (U*, N*) ───
  const upvoteMap = new Map<string, number>();
  const modelCountMap = new Map<string, number>();
  let upvoteMax = 0;
  let modelCountMax = 0;
  for (const b of allBenches) {
    const u =
      typeof (b as any).cachedNetUpvotes === "number"
        ? (b as any).cachedNetUpvotes
        : 1;
    let n: number;
    if (typeof (b as any).cachedModelCount === "number") {
      n = (b as any).cachedModelCount;
    } else {
      // Live fallback: count distinct models with net-positive
      // submissions on this bench. Uses already-loaded scores.
      const valid = new Set<string>();
      for (const s of scores) {
        if (s.benchId === (b._id as string) && s.upvotes > s.downvotes) {
          valid.add(s.modelId);
        }
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

  // ─── 2. Bench raw weight (Q×D×H) cache ───
  const benchWeightCache = new Map<string, number>();
  for (const b of allBenches) {
    if (typeof (b as any).cachedEffectiveWeight === "number") {
      benchWeightCache.set(b._id as string, (b as any).cachedEffectiveWeight);
    } else if (weightFallback?.has(b._id as string)) {
      benchWeightCache.set(b._id as string, weightFallback.get(b._id as string)!);
    } else {
      // Bench is missing its denormalised weight AND no fallback
      // was supplied — caller didn't pre-warm the cache. We log
      // and assign 0, which excludes the bench from rankings
      // until the next recomputeBenchAggregates fires.
      console.warn(
        `[rankings] bench ${b._id} missing cachedEffectiveWeight; excluded from rebuild`
      );
      benchWeightCache.set(b._id as string, 0);
    }
  }

  // ─── 3. Per-model aggregate ───
  type ModelAgg = {
    modelId: Id<"models">;
    model: any;
    weightedMean: number;
    totalWeight: number;
    benchCount: number;
  };
  const modelAggregates: ModelAgg[] = [];
  // medianByModelBench[modelId][benchId] = that model's median on
  // that bench. The family aggregator reuses this.
  const medianByModelBench = new Map<string, Map<string, number>>();

  for (const m of allModels) {
    const scores = scoresByModel.get(m._id as string) ?? [];
    const benchScores: Record<string, number[]> = {};
    for (const s of scores) {
      if (s.upvotes > s.downvotes) {
        (benchScores[s.benchId] ??= []).push(s.normalizedScore);
      }
    }

    let weightedSum = 0;
    let weightTotal = 0;
    let benchCount = 0;
    const perBench = new Map<string, number>();

    for (const [benchId, vals] of Object.entries(benchScores)) {
      const med = medianOf(vals);
      perBench.set(benchId, med);

      const rawW = benchWeightCache.get(benchId) ?? 0;
      const u = upvoteMap.get(benchId) ?? 1;
      const n = modelCountMap.get(benchId) ?? 0;
      const eff = effectiveBenchWeight(rawW, u, upvoteMax, n, modelCountMax);
      if (eff <= 0) continue;
      weightedSum += eff * med;
      weightTotal += eff;
      benchCount++;
    }
    medianByModelBench.set(m._id as string, perBench);

    modelAggregates.push({
      modelId: m._id as Id<"models">,
      model: m,
      weightedMean: weightTotal > 0 ? weightedSum / weightTotal : 0,
      totalWeight: weightTotal,
      benchCount,
    });
  }

  // ─── 4. Per-family aggregate ───
  type FamilyAgg = {
    familyTag: string;
    provider: string;
    weightedMean: number;
    totalWeight: number;
    benchCount: number;
    modelCount: number;
    tags: string[];
    hidden: boolean;
  };
  const familyAggregates: FamilyAgg[] = [];

  const pairs = new Map<
    string,
    { familyTag: string; provider: string; members: any[] }
  >();
  for (const m of allModels) {
    const k = normalizeFamilyKey(m.familyTag);
    if (!k) continue;
    const key = `${k}\u0000${m.provider}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = { familyTag: k, provider: m.provider, members: [] };
      pairs.set(key, pair);
    }
    pair.members.push(m);
  }

  for (const { familyTag, provider, members } of pairs.values()) {
    const visible = members.filter((m: any) => !m.hidden);
    const isAllHidden = visible.length === 0 && members.length > 0;

    const perBench: Record<string, number[]> = {};
    for (const m of visible) {
      const memberMedians = medianByModelBench.get(m._id as string);
      if (!memberMedians) continue;
      for (const [benchId, med] of memberMedians) {
        (perBench[benchId] ??= []).push(med);
      }
    }

    let weightedSum = 0;
    let weightTotal = 0;
    let benchCount = 0;
    for (const [benchId, memberMedians] of Object.entries(perBench)) {
      const familyMedian = medianOf(memberMedians);
      const rawW = benchWeightCache.get(benchId) ?? 0;
      const u = upvoteMap.get(benchId) ?? 1;
      const n = modelCountMap.get(benchId) ?? 0;
      const eff = effectiveBenchWeight(rawW, u, upvoteMax, n, modelCountMax);
      if (eff <= 0) continue;
      weightedSum += eff * familyMedian;
      weightTotal += eff;
      benchCount++;
    }

    const tagSet = new Set<string>();
    for (const m of visible) for (const t of (m.tags ?? [])) tagSet.add(t);

    familyAggregates.push({
      familyTag,
      provider,
      weightedMean: weightTotal > 0 ? weightedSum / weightTotal : 0,
      totalWeight: weightTotal,
      benchCount,
      modelCount: visible.length,
      tags: Array.from(tagSet),
      hidden: isAllHidden,
    });
  }

  // ─── 5. Apply √(W_m / W*) and √(W_f / W*) shrinkage ───
  let maxModelTotalWeight = 0;
  for (const a of modelAggregates) {
    if (a.model.hidden) continue;
    if (a.totalWeight > maxModelTotalWeight) maxModelTotalWeight = a.totalWeight;
  }
  let maxFamilyTotalWeight = 0;
  for (const a of familyAggregates) {
    if (a.hidden) continue;
    if (a.totalWeight > maxFamilyTotalWeight) maxFamilyTotalWeight = a.totalWeight;
  }

  const modelRows: ModelRankingData[] = modelAggregates.map((a) => {
    const share =
      maxModelTotalWeight > 0
        ? Math.min(1, a.totalWeight / maxModelTotalWeight)
        : 0;
    const supraScore = a.weightedMean * Math.sqrt(share);
    return {
      modelId: a.modelId,
      name: a.model.name,
      provider: a.model.provider,
      slug: a.model.slug,
      familyTag: a.model.familyTag,
      tags: a.model.tags,
      supraScore: Math.round(supraScore * 10) / 10,
      benchCount: a.benchCount,
      hidden: a.model.hidden ?? false,
    };
  });

  const validFamilyKeys = new Set<string>();
  const familyRows: FamilyRankingData[] = familyAggregates.map((a) => {
    validFamilyKeys.add(`${a.familyTag}\u0000${a.provider}`);
    const share =
      maxFamilyTotalWeight > 0
        ? Math.min(1, a.totalWeight / maxFamilyTotalWeight)
        : 0;
    const supraScore = a.weightedMean * Math.sqrt(share);
    return {
      familyTag: a.familyTag,
      provider: a.provider,
      supraScore: Math.round(supraScore * 10) / 10,
      benchCount: a.benchCount,
      modelCount: a.modelCount,
      tags: a.tags,
      hidden: a.hidden,
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

  // Pre-warm the weight-fallback map for any bench missing
  // cachedEffectiveWeight. This was inline in the old impl but
  // pulling it out lets the pure compute stay db-free.
  const weightFallback = new Map<string, number>();
  for (const b of allBenches) {
    if (typeof (b as any).cachedEffectiveWeight !== "number") {
      const w = await getBenchWeights(ctx, b._id as Id<"benches">);
      weightFallback.set(b._id as string, w.weight);
    }
  }

  const out = buildRankingsFromInputs({
    models: allModels,
    benches: allBenches,
    scores: flatScores,
    weightFallback,
  });
  return persistRankings(ctx, out);
}

export const recomputeModel = internalMutation({
  args: { modelId: v.id("models") },
  handler: async (ctx) => {
    // Coverage-share couples every model's score to every other
    // model's totalWeight, so even a single-model update triggers
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
// on every other model's totalWeight), so any change requires a
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
