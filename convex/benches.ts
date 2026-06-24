import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { recomputeEffectiveTags } from "./tagVotes";
import {
  seedCreatorEntityVote,
  assertNotResurrectingOwnHidden,
} from "./entityVotes";
import { isOfficialUrl } from "./urls";
import { normalizePublicHttpUrl } from "./urls";
import { enforceDailyActionLimit } from "./abuse";
import {
  getBenchWeights,
  getBenchCoverageIndex,
  effectiveBenchWeight,
} from "./rankings";

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

const MAX_NAME_LEN = 120;
const MAX_DESCRIPTION_LEN = 1000;
const CREATE_LIMIT_PER_DAY = 10;

export const listRanked = query({
  args: {},
  handler: async (ctx) => {
    const benches = await ctx.db.query("benches").collect();

    // Displayed Bench Weight is the intrinsic Q·D·H product folded
    // through community trust via u/U*. Distinct model count is
    // still used by the model-ranker as evidence/confidence, but it
    // no longer reduces the benchmark's central ability weight.
    const cov = await getBenchCoverageIndex(ctx);

    const results = [];
    for (const bench of benches) {
      if (bench.hidden) continue;

      // Fast path: read from denormalized aggregates (kept fresh by
      // cache.recomputeBenchAggregates on every score / vote / rating).
      // Slow fallback: compute live for benches not yet backfilled.
      let qualityScore: number;
      let dimensions: {
        relevance: number;
        contamination: number;
        discriminability: number;
        reproducibility: number;
        difficulty: number;
      };
      let modelCount: number;
      let raterCount: number;

      if (
        typeof bench.cachedQualityScore === "number" &&
        bench.cachedDimensions &&
        typeof bench.cachedModelCount === "number" &&
        typeof bench.cachedRaterCount === "number"
      ) {
        qualityScore = bench.cachedQualityScore;
        dimensions = bench.cachedDimensions;
        modelCount = bench.cachedModelCount;
        raterCount = bench.cachedRaterCount;
      } else {
        // Fallback: original O(scores + ratings) compute. Only triggers
        // for benches that haven't been touched since the cache was
        // introduced (run `migrations:backfillBenchAggregates` to fix).
        const ratings = await ctx.db
          .query("benchQualityRatings")
          .withIndex("by_bench", (q) => q.eq("benchId", bench._id))
          .collect();
        const dim = { relevance: 0, contamination: 0, discriminability: 0, reproducibility: 0, difficulty: 0 };
        if (ratings.length === 0) {
          qualityScore = 50;
        } else {
          dim.relevance = ratings.reduce((s, r) => s + r.relevance, 0) / ratings.length;
          dim.contamination = ratings.reduce((s, r) => s + r.contamination, 0) / ratings.length;
          dim.discriminability = ratings.reduce((s, r) => s + r.discriminability, 0) / ratings.length;
          dim.reproducibility = ratings.reduce((s, r) => s + r.reproducibility, 0) / ratings.length;
          const diffs = ratings.map((r) => (typeof (r as any).difficulty === "number" ? (r as any).difficulty : 3));
          dim.difficulty = diffs.reduce((s, d) => s + d, 0) / diffs.length;
          qualityScore =
            ((dim.relevance + dim.contamination + dim.discriminability + dim.reproducibility) / 4) * 20;
        }
        const scores = await ctx.db
          .query("modelScores")
          .withIndex("by_bench", (q) => q.eq("benchId", bench._id))
          .collect();
        const validModelIds = new Set(
          scores.filter((s) => s.upvotes > s.downvotes).map((s) => s.modelId)
        );
        dimensions = {
          relevance: Math.round(dim.relevance * 10) / 10,
          contamination: Math.round(dim.contamination * 10) / 10,
          discriminability: Math.round(dim.discriminability * 10) / 10,
          reproducibility: Math.round(dim.reproducibility * 10) / 10,
          difficulty: Math.round(dim.difficulty * 10) / 10,
        };
        modelCount = validModelIds.size;
        raterCount = ratings.length;
        qualityScore = Math.round(qualityScore * 10) / 10;
      }

      // Raw weight = quality × difficulty × headroom. This is the
      // bench's intrinsic Q·D·H product without any community-trust
      // shrinkage. Fallback to qualityScore for benches that haven't
      // been backfilled yet so the list never shows a misleading 0.
      const rawWeight =
        typeof bench.cachedEffectiveWeight === "number"
          ? bench.cachedEffectiveWeight
          : qualityScore;

      // Trust-adjusted weight: apply u_b/U* so a freshly-created
      // self-rated bench does not carry full model-ranking weight
      // until the community endorses it.
      const u = cov.upvoteMap.get(bench._id as string) ?? 1;
      const nForCov =
        cov.modelCountMap.get(bench._id as string) ?? modelCount;
      const effectiveWeight =
        Math.round(
          effectiveBenchWeight(
            rawWeight,
            u,
            cov.upvoteMax,
            nForCov,
            cov.modelCountMax
          ) * 10
        ) / 10;

      results.push({
        _id: bench._id,
        name: bench.name,
        slug: bench.slug,
        description: bench.description,
        url: bench.url,
        isOfficial: bench.isOfficial,
        tags: bench.tags,
        scaleMin: bench.scaleMin,
        scaleMax: bench.scaleMax,
        qualityScore,
        effectiveWeight,
        // Pre-shrinkage Q·D·H so the UI can show "intrinsic 60 →
        // effective 19 because only 1 community endorsement vs the
        // leader's 80".
        rawWeight: Math.round(rawWeight * 10) / 10,
        netUpvotes: u,
        maxNetUpvotes: cov.upvoteMax,
        modelCountForCoverage: nForCov,
        maxModelCountForCoverage: cov.modelCountMax,
        dimensions,
        modelCount,
        raterCount,
      });
    }

    results.sort((a, b) => b.effectiveWeight - a.effectiveWeight);
    return results;
  },
});

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const bench = await ctx.db
      .query("benches")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!bench) return null;
    if (bench.hidden) return null;

    // Aggregate fields — fast path reads from denormalized cache,
    // slow fallback computes live (for unmigrated rows).
    let qualityScore: number;
    let dimensions: {
      relevance: number;
      contamination: number;
      discriminability: number;
      reproducibility: number;
      difficulty: number;
    };
    let raterCount: number;
    let frontierMean: number;
    let modelCount: number;
    let topK: number;
    let headroom: number;
    let difficultyMultiplier: number;
    let effectiveWeight: number;

    if (
      typeof bench.cachedQualityScore === "number" &&
      bench.cachedDimensions &&
      typeof bench.cachedRaterCount === "number" &&
      typeof bench.cachedFrontierMean === "number" &&
      typeof bench.cachedModelCount === "number" &&
      typeof bench.cachedTopK === "number" &&
      typeof bench.cachedHeadroom === "number" &&
      typeof bench.cachedDifficultyMultiplier === "number" &&
      typeof bench.cachedEffectiveWeight === "number"
    ) {
      qualityScore = bench.cachedQualityScore;
      dimensions = bench.cachedDimensions;
      raterCount = bench.cachedRaterCount;
      frontierMean = bench.cachedFrontierMean;
      modelCount = bench.cachedModelCount;
      topK = bench.cachedTopK;
      headroom = bench.cachedHeadroom;
      difficultyMultiplier = bench.cachedDifficultyMultiplier;
      effectiveWeight = bench.cachedEffectiveWeight;
    } else {
      const ratings = await ctx.db
        .query("benchQualityRatings")
        .withIndex("by_bench", (q) => q.eq("benchId", bench._id))
        .collect();
      const dim = { relevance: 0, contamination: 0, discriminability: 0, reproducibility: 0, difficulty: 0 };
      let qs = 50;
      if (ratings.length > 0) {
        dim.relevance = ratings.reduce((s, r) => s + r.relevance, 0) / ratings.length;
        dim.contamination = ratings.reduce((s, r) => s + r.contamination, 0) / ratings.length;
        dim.discriminability = ratings.reduce((s, r) => s + r.discriminability, 0) / ratings.length;
        dim.reproducibility = ratings.reduce((s, r) => s + r.reproducibility, 0) / ratings.length;
        const diffs = ratings.map((r) => (typeof (r as any).difficulty === "number" ? (r as any).difficulty : 3));
        dim.difficulty = diffs.reduce((s, d) => s + d, 0) / diffs.length;
        qs = ((dim.relevance + dim.contamination + dim.discriminability + dim.reproducibility) / 4) * 20;
      }
      const w = await getBenchWeights(ctx, bench._id);
      qualityScore = Math.round(qs * 10) / 10;
      dimensions = {
        relevance: Math.round(dim.relevance * 10) / 10,
        contamination: Math.round(dim.contamination * 10) / 10,
        discriminability: Math.round(dim.discriminability * 10) / 10,
        reproducibility: Math.round(dim.reproducibility * 10) / 10,
        difficulty: Math.round(dim.difficulty * 10) / 10,
      };
      raterCount = ratings.length;
      frontierMean = Math.round(w.frontierMean * 10) / 10;
      modelCount = w.modelCount;
      topK = w.topK;
      headroom = Math.round(w.headroom * 100) / 100;
      difficultyMultiplier = Math.round(w.difficulty * 100) / 100;
      effectiveWeight = Math.round(w.weight * 10) / 10;
    }

    // Apply the per-bench u/U* trust multiplier on top of the raw
    // Q·D·H so the detail page shows the same Bench Weight number as
    // the leaderboard.
    const cov = await getBenchCoverageIndex(ctx);
    const netUpvotes = cov.upvoteMap.get(bench._id as string) ?? 1;
    const nForCov =
      cov.modelCountMap.get(bench._id as string) ?? modelCount;
    const rawWeight = effectiveWeight;
    effectiveWeight =
      Math.round(
        effectiveBenchWeight(
          effectiveWeight,
          netUpvotes,
          cov.upvoteMax,
          nForCov,
          cov.modelCountMax
        ) * 10
      ) / 10;

    // All submissions for this bench
    const allScores = await ctx.db
      .query("modelScores")
      .withIndex("by_bench", (q) => q.eq("benchId", bench._id))
      .collect();

    // Group by model
    const modelGroups: Record<string, typeof allScores> = {};
    for (const s of allScores) {
      if (!modelGroups[s.modelId]) modelGroups[s.modelId] = [];
      modelGroups[s.modelId].push(s);
    }

    const modelScores = [];
    for (const [modelId, submissions] of Object.entries(modelGroups)) {
      const model = await ctx.db.get(modelId as any);
      if (!model) continue;

      const validSubmissions = submissions.filter((s) => s.upvotes > s.downvotes);
      const validScores = validSubmissions.map((s) => s.normalizedScore).sort((a, b) => a - b);
      const effectiveScore =
        validScores.length === 0
          ? null
          : validScores.length % 2 === 0
            ? (validScores[validScores.length / 2 - 1] + validScores[validScores.length / 2]) / 2
            : validScores[Math.floor(validScores.length / 2)];

      // Enrich submissions with denormalized submitter info. Fast path:
      // read submitterName/Image directly off the score row. Slow fallback:
      // db.get the user (only for un-backfilled rows).
      const enrichedSubmissions = [];
      for (const s of submissions) {
        let name = s.submitterName;
        let image = s.submitterImage ?? null;
        if (name === undefined) {
          const user = await ctx.db.get(s.submittedBy);
          name = (user as any)?.name ?? "Unknown";
          image = (user as any)?.image ?? null;
        }
        enrichedSubmissions.push({
          _id: s._id,
          rawScore: s.rawScore,
          normalizedScore: s.normalizedScore,
          sourceUrl: s.sourceUrl,
          submittedBy: s.submittedBy,
          submitterName: name,
          submitterImage: image,
          createdAt: s.createdAt,
          upvotes: s.upvotes,
          downvotes: s.downvotes,
          isValid: s.upvotes > s.downvotes,
        });
      }

      modelScores.push({
        modelId,
        modelName: (model as any).name,
        modelSlug: (model as any).slug,
        effectiveScore:
          effectiveScore !== null ? Math.round(effectiveScore * 10) / 10 : null,
        validCount: validSubmissions.length,
        totalCount: submissions.length,
        submissions: enrichedSubmissions.sort((a, b) => b.upvotes - a.upvotes),
      });
    }

    // Sort the per-model leaderboard for this bench by effective score
    // descending so the bench detail page can render a meaningful #1, #2,
    // … rank column. Models with no valid score (effectiveScore === null)
    // sink to the bottom — they haven't actually competed yet.
    modelScores.sort((a, b) => {
      if (a.effectiveScore === null && b.effectiveScore === null) return 0;
      if (a.effectiveScore === null) return 1;
      if (b.effectiveScore === null) return -1;
      return b.effectiveScore - a.effectiveScore;
    });

    return {
      ...bench,
      qualityScore,
      dimensions,
      raterCount,
      modelScores,
      frontierMean,
      modelCount,
      topK,
      headroom,
      difficultyMultiplier,
      effectiveWeight,
      rawWeight: Math.round(rawWeight * 10) / 10,
      netUpvotes,
      maxNetUpvotes: cov.upvoteMax,
      modelCountForCoverage: nForCov,
      maxModelCountForCoverage: cov.modelCountMax,
      saturated: modelCount >= 3 && frontierMean >= 90,
      saturationDampened: modelCount < 3,
    };
  },
});

export const search = query({
  args: { query: v.string() },
  handler: async (ctx, { query: q }) => {
    if (q.length < 2) return [];
    const results = await ctx.db
      .query("benches")
      .withSearchIndex("search_name", (s) => s.search("name", q))
      .take(20);
    return results
      .filter((b) => !b.hidden)
      .slice(0, 10)
      .map((b) => ({
        _id: b._id,
        name: b.name,
        slug: b.slug,
        scaleMin: b.scaleMin,
        scaleMax: b.scaleMax,
        isOfficial: b.isOfficial,
      }));
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    description: v.string(),
    url: v.string(),
    scaleMin: v.number(),
    scaleMax: v.number(),
    tags: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    if (!args.name?.trim()) throw new Error("Name is required");
    if (args.name.trim().length > MAX_NAME_LEN) throw new Error("Name too long");
    if ((args.description ?? "").trim().length > MAX_DESCRIPTION_LEN) {
      throw new Error("Description too long");
    }
    if (!Number.isFinite(args.scaleMin) || !Number.isFinite(args.scaleMax) || args.scaleMax <= args.scaleMin) {
      throw new Error("Scale must have finite min < max");
    }
    await enforceDailyActionLimit(ctx, userId, "create-bench", CREATE_LIMIT_PER_DAY);
    await assertNotResurrectingOwnHidden(ctx, "bench", args.name, userId);
    const url = normalizePublicHttpUrl(args.url);

    let slug = generateSlug(args.name);
    let existing = await ctx.db
      .query("benches")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    let counter = 2;
    while (existing) {
      slug = `${generateSlug(args.name)}-${counter}`;
      existing = await ctx.db
        .query("benches")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .first();
      counter++;
    }

    const benchId = await ctx.db.insert("benches", {
      name: args.name,
      slug,
      description: args.description,
      url,
      isOfficial: isOfficialUrl(url),
      tags: [],
      scaleMin: args.scaleMin,
      scaleMax: args.scaleMax,
      addedBy: userId,
      createdAt: Date.now(),
    });
    await seedCreatorEntityVote(ctx, "bench", benchId as unknown as string, userId);

    const seen = new Set<string>();
    for (const raw of args.tags) {
      const t = raw.trim().toLowerCase();
      if (!t || t.length > 30 || seen.has(t)) continue;
      seen.add(t);
      await ctx.db.insert("tagVotes", {
        entityType: "bench",
        entityId: benchId as unknown as string,
        tag: t,
        userId,
        value: 1,
      });
    }
    await recomputeEffectiveTags(ctx, "bench", benchId as unknown as string);
    return benchId;
  },
});
