import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { recomputeEffectiveTags } from "./tagVotes";
import {
  seedCreatorEntityVote,
  assertNotResurrectingOwnHidden,
} from "./entityVotes";
import { isOfficialUrl } from "./urls";
import { getBenchWeights } from "./rankings";

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export const listRanked = query({
  args: {},
  handler: async (ctx) => {
    const benches = await ctx.db.query("benches").collect();

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

      // Bench Score = quality × difficulty × headroom (the bench's actual
      // weight in the SupraScore). Range is [0, 100] because difficulty and
      // headroom are both already normalised to [0, 1] in cache.ts.
      // Fallback to qualityScore for benches that haven't been backfilled
      // yet so the list never shows a misleading 0.
      const effectiveWeight =
        typeof bench.cachedEffectiveWeight === "number"
          ? bench.cachedEffectiveWeight
          : qualityScore;

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
    await assertNotResurrectingOwnHidden(ctx, "bench", args.name, userId);

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
      url: args.url,
      isOfficial: isOfficialUrl(args.url),
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
