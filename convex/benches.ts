import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { recomputeEffectiveTags } from "./tagVotes";
import {
  seedCreatorEntityVote,
  assertNotResurrectingOwnHidden,
} from "./entityVotes";
import { isOfficialUrl } from "./urls";

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
      const ratings = await ctx.db
        .query("benchQualityRatings")
        .withIndex("by_bench", (q) => q.eq("benchId", bench._id))
        .collect();

      let qualityScore: number;
      const dimensions = { relevance: 0, contamination: 0, discriminability: 0, reproducibility: 0, difficulty: 0 };

      if (ratings.length === 0) {
        qualityScore = 50;
      } else {
        dimensions.relevance = ratings.reduce((s, r) => s + r.relevance, 0) / ratings.length;
        dimensions.contamination = ratings.reduce((s, r) => s + r.contamination, 0) / ratings.length;
        dimensions.discriminability = ratings.reduce((s, r) => s + r.discriminability, 0) / ratings.length;
        dimensions.reproducibility = ratings.reduce((s, r) => s + r.reproducibility, 0) / ratings.length;
        const diffs = ratings.map((r) => (typeof (r as any).difficulty === "number" ? (r as any).difficulty : 3));
        dimensions.difficulty = diffs.reduce((s, d) => s + d, 0) / diffs.length;
        qualityScore =
          ((dimensions.relevance + dimensions.contamination + dimensions.discriminability + dimensions.reproducibility) / 4) * 20;
      }

      // Count models with valid scores
      const scores = await ctx.db
        .query("modelScores")
        .withIndex("by_bench", (q) => q.eq("benchId", bench._id))
        .collect();
      const validModelIds = new Set(
        scores.filter((s) => s.upvotes > s.downvotes).map((s) => s.modelId)
      );

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
        qualityScore: Math.round(qualityScore * 10) / 10,
        dimensions: {
          relevance: Math.round(dimensions.relevance * 10) / 10,
          contamination: Math.round(dimensions.contamination * 10) / 10,
          discriminability: Math.round(dimensions.discriminability * 10) / 10,
          reproducibility: Math.round(dimensions.reproducibility * 10) / 10,
          difficulty: Math.round(dimensions.difficulty * 10) / 10,
        },
        modelCount: validModelIds.size,
        raterCount: ratings.length,
      });
    }

    results.sort((a, b) => b.qualityScore - a.qualityScore);
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

    // Quality ratings
    const ratings = await ctx.db
      .query("benchQualityRatings")
      .withIndex("by_bench", (q) => q.eq("benchId", bench._id))
      .collect();

    const dimensions = { relevance: 0, contamination: 0, discriminability: 0, reproducibility: 0, difficulty: 0 };
    let qualityScore = 50;
    if (ratings.length > 0) {
      dimensions.relevance = ratings.reduce((s, r) => s + r.relevance, 0) / ratings.length;
      dimensions.contamination = ratings.reduce((s, r) => s + r.contamination, 0) / ratings.length;
      dimensions.discriminability = ratings.reduce((s, r) => s + r.discriminability, 0) / ratings.length;
      dimensions.reproducibility = ratings.reduce((s, r) => s + r.reproducibility, 0) / ratings.length;
      const diffs = ratings.map((r) => (typeof (r as any).difficulty === "number" ? (r as any).difficulty : 3));
      dimensions.difficulty = diffs.reduce((s, d) => s + d, 0) / diffs.length;
      qualityScore =
        ((dimensions.relevance + dimensions.contamination + dimensions.discriminability + dimensions.reproducibility) / 4) * 20;
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

      // Enrich submissions with user info
      const enrichedSubmissions = [];
      for (const s of submissions) {
        const user = await ctx.db.get(s.submittedBy);
        enrichedSubmissions.push({
          _id: s._id,
          rawScore: s.rawScore,
          normalizedScore: s.normalizedScore,
          sourceUrl: s.sourceUrl,
          submittedBy: s.submittedBy,
          submitterName: (user as any)?.name ?? "Unknown",
          submitterImage: (user as any)?.image ?? null,
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

    // SOTA + headroom — the same formula used in rankings, exposed for the UI
    let top1 = 0;
    for (const ms of modelScores) {
      if (ms.effectiveScore !== null && ms.effectiveScore > top1) top1 = ms.effectiveScore;
    }
    const sotaClamped = Math.max(top1, 50);
    const headroom = Math.max(0.1, (100 - sotaClamped) / 50);
    const difficultyMultiplier =
      ratings.length > 0
        ? Math.max(0, Math.min(1, (dimensions.difficulty - 1) / 4))
        : 0.5;
    const effectiveWeight = qualityScore * difficultyMultiplier * headroom;

    return {
      ...bench,
      qualityScore: Math.round(qualityScore * 10) / 10,
      dimensions: {
        relevance: Math.round(dimensions.relevance * 10) / 10,
        contamination: Math.round(dimensions.contamination * 10) / 10,
        discriminability: Math.round(dimensions.discriminability * 10) / 10,
        reproducibility: Math.round(dimensions.reproducibility * 10) / 10,
        difficulty: Math.round(dimensions.difficulty * 10) / 10,
      },
      raterCount: ratings.length,
      modelScores,
      sota: Math.round(top1 * 10) / 10,
      headroom: Math.round(headroom * 100) / 100,
      difficultyMultiplier: Math.round(difficultyMultiplier * 100) / 100,
      effectiveWeight: Math.round(effectiveWeight * 10) / 10,
      saturated: top1 >= 90,
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
