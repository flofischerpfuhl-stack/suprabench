import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { fetchAllScoresFromD1, D1ScoreRow } from "./scoresWorker";
import { canonicalFamilyTag } from "./modelFamilies";

// ── SupraScore: user-trust first, coverage as evidence ──
//
//   per-bench ability:
//      A_b = Q·D·H · (u_b/U*)
//
//   per-bench evidence:
//      E_b = A_b · √(N_b/N*)
//
//   per-model ability:
//      μ_m = weightedMean(score_m,b, A_b)
//
//   per-model SupraScore:
//      SupraScore(m) = 50 + √(E_m/E*) · (μ_m − 50)
//
// The point of the split is semantic, not product-facing: users still
// see one SupraScore. Internally, community endorsement decides how much
// a benchmark counts for ability; model-count coverage only changes how
// confident we are in a sparse estimate.
//
// • U* = max `cachedNetUpvotes` across non-hidden benches. The
//   upvote-share is the user-driven trust signal. A benchmark that the
//   community strongly endorses must be able to beat a broader but less
//   trusted benchmark.
//
// • N* = max `cachedModelCount` across non-hidden benches. The
//   model-count-share encodes evidence breadth only. It no longer
//   reduces the central ability estimate, so a high-trust specialist
//   benchmark is not buried just because fewer models have paid to run
//   it yet.
//
// • E* = max E_m across non-hidden models, where E_m is the model's
//   accumulated evidence weight. Sparse models are not multiplied
//   toward zero anymore; they are shrunk toward the neutral midpoint
//   of the normalized score scale (50). That means "not tested on weak
//   benches" is uncertainty, not negative evidence.
//
// Properties of the joint formula:
//   • score stays in [0, 100]
//   • zero tuning hyperparameters — U*, N*, E* all come straight from the DB
//     and 50 is the midpoint of the normalized [0, 100] score scale
//   • evidence √-shape mirrors the 1/√N standard-error falloff
//   • monotonic in the model's own scores and evidence
//   • top-evidence model always has E_m/E* = 1 (no self-penalty)
//   • top-upvoted bench always has u_b/U* = 1 (no self-penalty)
//   • IIA is intentionally violated on every axis: the table is a
//     relative comparison, so "evidence" only exists in comparison
//     to what else exists.
//
// The catalog of attacks the formula is *meant* to defend against
// is enumerated in tests/convex/adversarial-robustness.test.ts and
// is verified end-to-end on every CI run.
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
export const NORMALIZED_SCORE_MIDPOINT = 50;
// A family prefers a concrete configuration measured on at least three
// distinct benchmarks. Three is the smallest coverage that triangulates
// performance instead of selecting a one- or two-benchmark spike.
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

// Evidence weight keeps the same user-trust multiplier, then applies
// the model-count share only to confidence/evidence. So a specialist
// benchmark can carry ability when users endorse it, while very sparse
// benchmarks still produce lower confidence until they have broader
// comparative coverage.
export function evidenceBenchWeight(
  rawWeight: number,
  upvotes: number,
  upvoteMax: number,
  modelCount: number,
  modelCountMax: number
): number {
  const nShare =
    modelCountMax > 0
      ? Math.min(1, Math.max(0, modelCount) / modelCountMax)
      : 1;
  return effectiveBenchWeight(
    rawWeight,
    upvotes,
    upvoteMax,
    modelCount,
    modelCountMax
  ) * Math.sqrt(nShare);
}

export function confidenceAdjustedSupraScore(
  weightedMean: number,
  evidenceWeight: number,
  maxEvidenceWeight: number
): number {
  if (evidenceWeight <= 0 || maxEvidenceWeight <= 0) return 0;
  const share = Math.min(1, evidenceWeight / maxEvidenceWeight);
  const confidence = Math.sqrt(share);
  return (
    NORMALIZED_SCORE_MIDPOINT +
    confidence * (weightedMean - NORMALIZED_SCORE_MIDPOINT)
  );
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
  representativeModelId?: Id<"models">;
  representativeName?: string;
  representativeSlug?: string;
  aggregationMethod: "family-ceiling-pairwise";
  provisional: boolean;
  tags: string[];
  hidden: boolean;
};

export const FAMILY_PAIRWISE_PRIOR_RATERS = 3;
export const FAMILY_PAIRWISE_REGULARIZATION = 0.15;
export const FAMILY_PAIRWISE_ITERATIONS = 40;

function shrinkRatingDimension(
  value: number | undefined,
  raterCount: number,
  priorRaters: number
): number {
  const observed = raterCount > 0 && typeof value === "number" ? value : 3;
  return (observed * raterCount + 3 * priorRaters) / (raterCount + priorRaters);
}

function familyPairwiseBenchWeight(bench: any, upvoteMax: number): number {
  const dimensions = bench.cachedDimensions ?? {};
  const raterCount = Math.max(0, bench.cachedRaterCount ?? 0);
  const trustDimensions = [
    dimensions.relevance,
    dimensions.contamination,
    dimensions.discriminability,
    dimensions.reproducibility,
  ].map((value) =>
    shrinkRatingDimension(value, raterCount, FAMILY_PAIRWISE_PRIOR_RATERS)
  );
  const quality =
    (trustDimensions.reduce((sum, value) => sum + value, 0) /
      trustDimensions.length) * 20;
  const difficulty = shrinkRatingDimension(
    dimensions.difficulty,
    raterCount,
    FAMILY_PAIRWISE_PRIOR_RATERS
  );
  const difficultyMultiplier = Math.min(1, Math.max(0, (difficulty - 1) / 4));
  const headroom =
    typeof bench.cachedHeadroom === "number" ? bench.cachedHeadroom : 1;
  const upvotes =
    typeof bench.cachedNetUpvotes === "number" ? bench.cachedNetUpvotes : 1;
  const trust =
    upvoteMax > 0 ? Math.min(1, Math.max(0, upvotes) / upvoteMax) : 1;
  return quality * difficultyMultiplier * headroom * trust;
}

type FamilyCeilingScore = {
  familyKey: string;
  familyTag: string;
  provider: string;
  benchId: string;
  score: number;
};

export function buildPairwiseFamilyRankings(args: {
  models: any[];
  benches: any[];
  scores: ScoreLike[];
}): {
  rows: Array<{
    familyKey: string;
    familyTag: string;
    provider: string;
    supraScore: number;
    benchCount: number;
  }>;
  ceilingScores: FamilyCeilingScore[];
} {
  const visibleModels = args.models.filter((model) => !model.hidden);
  const modelById = new Map(
    visibleModels.map((model) => [model._id as string, model])
  );
  const perModelBench = new Map<string, number[]>();
  for (const score of args.scores) {
    if (score.upvotes <= score.downvotes || !modelById.has(score.modelId)) continue;
    const key = `${score.modelId}\u0000${score.benchId}`;
    const values = perModelBench.get(key) ?? [];
    values.push(score.normalizedScore);
    perModelBench.set(key, values);
  }

  const familyMeta = new Map<
    string,
    { familyTag: string; provider: string; benchScores: Map<string, number> }
  >();
  for (const model of visibleModels) {
    const familyTag = normalizeFamilyKey(
      canonicalFamilyTag(model.name, model.familyTag)
    );
    if (!familyTag) continue;
    const familyKey = `${familyTag}\u0000${model.provider}`;
    if (!familyMeta.has(familyKey)) {
      familyMeta.set(familyKey, {
        familyTag,
        provider: model.provider,
        benchScores: new Map(),
      });
    }
  }
  for (const [key, values] of perModelBench) {
    const [modelId, benchId] = key.split("\u0000");
    const model = modelById.get(modelId);
    if (!model) continue;
    const familyTag = normalizeFamilyKey(
      canonicalFamilyTag(model.name, model.familyTag)
    );
    if (!familyTag) continue;
    const familyKey = `${familyTag}\u0000${model.provider}`;
    const meta = familyMeta.get(familyKey);
    if (!meta) continue;
    const concreteScore = medianOf(values);
    const previous = meta.benchScores.get(benchId);
    if (previous === undefined || concreteScore > previous) {
      meta.benchScores.set(benchId, concreteScore);
    }
  }

  const visibleBenches = args.benches.filter((bench) => !bench.hidden);
  const upvoteMax = Math.max(
    0,
    ...visibleBenches.map((bench) => bench.cachedNetUpvotes ?? 1)
  );
  const rawWeight = new Map<string, number>();
  for (const bench of visibleBenches) {
    rawWeight.set(
      bench._id as string,
      familyPairwiseBenchWeight(bench, upvoteMax)
    );
  }
  const positiveWeights = [...rawWeight.values()].filter((weight) => weight > 0);
  const meanWeight =
    positiveWeights.length > 0
      ? positiveWeights.reduce((sum, weight) => sum + weight, 0) /
        positiveWeights.length
      : 1;

  const familyKeys = [...familyMeta.keys()];
  const familyIndex = new Map(familyKeys.map((key, index) => [key, index]));
  const comparisons: Array<{
    left: number;
    right: number;
    outcome: number;
    weight: number;
  }> = [];
  const ceilingScores: FamilyCeilingScore[] = [];
  for (const bench of visibleBenches) {
    const benchId = bench._id as string;
    const rows: Array<{ familyKey: string; score: number }> = [];
    for (const [familyKey, meta] of familyMeta) {
      const score = meta.benchScores.get(benchId);
      if (score === undefined) continue;
      rows.push({ familyKey, score });
      ceilingScores.push({
        familyKey,
        familyTag: meta.familyTag,
        provider: meta.provider,
        benchId,
        score,
      });
    }
    if (rows.length < 2) continue;
    const benchmarkWeight = (rawWeight.get(benchId) ?? 0) / meanWeight;
    if (benchmarkWeight <= 0) continue;
    const pairWeight = benchmarkWeight / (rows.length - 1);
    for (let left = 0; left < rows.length; left++) {
      for (let right = left + 1; right < rows.length; right++) {
        comparisons.push({
          left: familyIndex.get(rows[left].familyKey)!,
          right: familyIndex.get(rows[right].familyKey)!,
          outcome:
            rows[left].score === rows[right].score
              ? 0.5
              : rows[left].score > rows[right].score
                ? 1
                : 0,
          weight: pairWeight,
        });
      }
    }
  }

  const ability = new Float64Array(familyKeys.length);
  const gradient = new Float64Array(familyKeys.length);
  const information = new Float64Array(familyKeys.length);
  for (let iteration = 0; iteration < FAMILY_PAIRWISE_ITERATIONS; iteration++) {
    gradient.fill(0);
    information.fill(FAMILY_PAIRWISE_REGULARIZATION);
    for (const comparison of comparisons) {
      const difference = Math.max(
        -30,
        Math.min(30, ability[comparison.left] - ability[comparison.right])
      );
      const probability = 1 / (1 + Math.exp(-difference));
      const residual = comparison.weight * (comparison.outcome - probability);
      const curvature = comparison.weight * probability * (1 - probability);
      gradient[comparison.left] += residual;
      gradient[comparison.right] -= residual;
      information[comparison.left] += curvature;
      information[comparison.right] += curvature;
    }
    let center = 0;
    for (let index = 0; index < ability.length; index++) {
      gradient[index] -= FAMILY_PAIRWISE_REGULARIZATION * ability[index];
      const step = Math.max(-1, Math.min(1, gradient[index] / information[index]));
      ability[index] += 0.8 * step;
      center += ability[index];
    }
    center /= ability.length || 1;
    for (let index = 0; index < ability.length; index++) ability[index] -= center;
  }

  const rows = familyKeys.map((familyKey, index) => {
    const meta = familyMeta.get(familyKey)!;
    return {
      familyKey,
      familyTag: meta.familyTag,
      provider: meta.provider,
      supraScore: 100 / (1 + Math.exp(-ability[index])),
      benchCount: meta.benchScores.size,
    };
  });
  return { rows, ceilingScores };
}

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
    abilityWeight: number;
    totalWeight: number;
    benchCount: number;
  };
  const modelAggregates: ModelAgg[] = [];
  for (const m of allModels) {
    const scores = scoresByModel.get(m._id as string) ?? [];
    const benchScores: Record<string, number[]> = {};
    for (const s of scores) {
      if (s.upvotes > s.downvotes) {
        (benchScores[s.benchId] ??= []).push(s.normalizedScore);
      }
    }

    let weightedSum = 0;
    let abilityWeightTotal = 0;
    let evidenceWeightTotal = 0;
    let benchCount = 0;
    for (const [benchId, vals] of Object.entries(benchScores)) {
      const med = medianOf(vals);

      const rawW = benchWeightCache.get(benchId) ?? 0;
      const u = upvoteMap.get(benchId) ?? 1;
      const n = modelCountMap.get(benchId) ?? 0;
      const abilityWeight = effectiveBenchWeight(
        rawW,
        u,
        upvoteMax,
        n,
        modelCountMax
      );
      const evidenceWeight = evidenceBenchWeight(
        rawW,
        u,
        upvoteMax,
        n,
        modelCountMax
      );
      if (abilityWeight <= 0) continue;
      weightedSum += abilityWeight * med;
      abilityWeightTotal += abilityWeight;
      evidenceWeightTotal += evidenceWeight;
      benchCount++;
    }
    modelAggregates.push({
      modelId: m._id as Id<"models">,
      model: m,
      weightedMean:
        abilityWeightTotal > 0 ? weightedSum / abilityWeightTotal : 0,
      abilityWeight: abilityWeightTotal,
      totalWeight: evidenceWeightTotal,
      benchCount,
    });
  }

  // ─── 4. Apply evidence confidence to concrete models ───
  // Family rows deliberately reuse these scores so a family is represented
  // by one real, reproducible configuration rather than a synthetic mixture.
  let maxModelEvidenceWeight = 0;
  for (const a of modelAggregates) {
    if (a.model.hidden) continue;
    if (a.totalWeight > maxModelEvidenceWeight) {
      maxModelEvidenceWeight = a.totalWeight;
    }
  }

  const modelRows: ModelRankingData[] = modelAggregates.map((a) => {
    const supraScore = confidenceAdjustedSupraScore(
      a.weightedMean,
      a.totalWeight,
      maxModelEvidenceWeight
    );
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

  // ─── 5. Opponent-adjusted family ceiling ───

  const pairs = new Map<
    string,
    { familyTag: string; provider: string; members: any[] }
  >();
  for (const m of allModels) {
    const k = normalizeFamilyKey(canonicalFamilyTag(m.name, m.familyTag));
    if (!k) continue;
    const key = `${k}\u0000${m.provider}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = { familyTag: k, provider: m.provider, members: [] };
      pairs.set(key, pair);
    }
    pair.members.push(m);
  }

  const pairwise = buildPairwiseFamilyRankings({
    models: allModels,
    benches: allBenches,
    scores,
  });
  const pairwiseByKey = new Map(
    pairwise.rows.map((row) => [row.familyKey, row])
  );
  const validFamilyKeys = new Set<string>();
  const familyRows: FamilyRankingData[] = [];
  for (const { familyTag, provider, members } of pairs.values()) {
    const visible = members.filter((m: any) => !m.hidden);
    const isAllHidden = visible.length === 0 && members.length > 0;

    const tagSet = new Set<string>();
    for (const m of visible) for (const t of (m.tags ?? [])) tagSet.add(t);

    const familyKey = `${familyTag}\u0000${provider}`;
    const ranking = pairwiseByKey.get(familyKey);
    const familyBenchCount = ranking?.benchCount ?? 0;

    validFamilyKeys.add(familyKey);
    familyRows.push({
      familyTag,
      provider,
      supraScore: Math.round((ranking?.supraScore ?? 0) * 10) / 10,
      benchCount: familyBenchCount,
      modelCount: visible.length,
      aggregationMethod: "family-ceiling-pairwise",
      provisional: familyBenchCount < FAMILY_REPRESENTATIVE_MIN_BENCHES,
      tags: Array.from(tagSet),
      hidden: isAllHidden,
    });
  }

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
        aggregationMethod: v.literal("family-ceiling-pairwise"),
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
