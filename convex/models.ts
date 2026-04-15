import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

// Helper: generate a slug from a name
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export const listRanked = query({
  args: {},
  handler: async (ctx) => {
    const models = await ctx.db.query("models").collect();
    const benches = await ctx.db.query("benches").collect();

    // Pre-compute bench quality scores
    const benchQualities: Record<string, number> = {};
    for (const bench of benches) {
      const ratings = await ctx.db
        .query("benchQualityRatings")
        .withIndex("by_bench", (q) => q.eq("benchId", bench._id))
        .collect();
      if (ratings.length === 0) {
        benchQualities[bench._id] = 50; // neutral default
      } else {
        const avg =
          ratings.reduce(
            (sum, r) =>
              sum +
              (r.relevance + r.contamination + r.discriminability + r.reproducibility) / 4,
            0
          ) / ratings.length;
        benchQualities[bench._id] = avg * 20;
      }
    }

    // Compute SupraScore for each model
    const rankedModels = [];
    for (const model of models) {
      const scores = await ctx.db
        .query("modelScores")
        .withIndex("by_model", (q) => q.eq("modelId", model._id))
        .collect();

      // Group by bench, compute median of valid submissions
      const benchScores: Record<string, number[]> = {};
      for (const s of scores) {
        if (s.upvotes > s.downvotes) {
          if (!benchScores[s.benchId]) benchScores[s.benchId] = [];
          benchScores[s.benchId].push(s.normalizedScore);
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
        const quality = benchQualities[benchId] ?? 50;
        weightedSum += quality * median;
        weightTotal += quality;
        benchCount++;
      }

      const supraScore = weightTotal > 0 ? weightedSum / weightTotal : 0;

      rankedModels.push({
        _id: model._id,
        name: model.name,
        provider: model.provider,
        slug: model.slug,
        familyTag: model.familyTag,
        tags: model.tags,
        supraScore: Math.round(supraScore * 10) / 10,
        benchCount,
      });
    }

    rankedModels.sort((a, b) => b.supraScore - a.supraScore);
    return rankedModels;
  },
});

export const listRankedWithFilter = query({
  args: { activeTags: v.array(v.string()) },
  handler: async (ctx, { activeTags }) => {
    const models = await ctx.db.query("models").collect();
    const benches = await ctx.db.query("benches").collect();

    // Pre-compute bench quality scores
    const benchQualities: Record<string, number> = {};
    const benchTags: Record<string, string[]> = {};
    for (const bench of benches) {
      benchTags[bench._id] = bench.tags;
      const ratings = await ctx.db
        .query("benchQualityRatings")
        .withIndex("by_bench", (q) => q.eq("benchId", bench._id))
        .collect();
      if (ratings.length === 0) {
        benchQualities[bench._id] = 50;
      } else {
        const avg =
          ratings.reduce(
            (sum, r) =>
              sum +
              (r.relevance + r.contamination + r.discriminability + r.reproducibility) / 4,
            0
          ) / ratings.length;
        benchQualities[bench._id] = avg * 20;
      }
    }

    const rankedModels = [];
    for (const model of models) {
      const scores = await ctx.db
        .query("modelScores")
        .withIndex("by_model", (q) => q.eq("modelId", model._id))
        .collect();

      const benchScores: Record<string, number[]> = {};
      for (const s of scores) {
        if (s.upvotes > s.downvotes) {
          if (!benchScores[s.benchId]) benchScores[s.benchId] = [];
          benchScores[s.benchId].push(s.normalizedScore);
        }
      }

      // Global SupraScore
      let weightedSum = 0;
      let weightTotal = 0;
      let benchCount = 0;
      // Filtered score
      let fWeightedSum = 0;
      let fWeightTotal = 0;

      for (const [benchId, vals] of Object.entries(benchScores)) {
        vals.sort((a, b) => a - b);
        const median =
          vals.length % 2 === 0
            ? (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2
            : vals[Math.floor(vals.length / 2)];
        const quality = benchQualities[benchId] ?? 50;
        weightedSum += quality * median;
        weightTotal += quality;
        benchCount++;

        // Check if bench matches any active tag
        const tags = benchTags[benchId] ?? [];
        if (activeTags.length > 0 && activeTags.some((t) => tags.includes(t))) {
          fWeightedSum += quality * median;
          fWeightTotal += quality;
        }
      }

      const supraScore = weightTotal > 0 ? weightedSum / weightTotal : 0;
      const filteredScore =
        activeTags.length > 0 && fWeightTotal > 0
          ? fWeightedSum / fWeightTotal
          : null;

      rankedModels.push({
        _id: model._id,
        name: model.name,
        provider: model.provider,
        slug: model.slug,
        familyTag: model.familyTag,
        tags: model.tags,
        supraScore: Math.round(supraScore * 10) / 10,
        filteredScore:
          filteredScore !== null ? Math.round(filteredScore * 10) / 10 : null,
        benchCount,
      });
    }

    rankedModels.sort((a, b) => b.supraScore - a.supraScore);
    return rankedModels;
  },
});

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const model = await ctx.db
      .query("models")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!model) return null;

    const allScores = await ctx.db
      .query("modelScores")
      .withIndex("by_model", (q) => q.eq("modelId", model._id))
      .collect();

    // Group by bench
    const benchGroups: Record<string, typeof allScores> = {};
    for (const s of allScores) {
      if (!benchGroups[s.benchId]) benchGroups[s.benchId] = [];
      benchGroups[s.benchId].push(s);
    }

    const benchPerformance = [];
    for (const [benchId, submissions] of Object.entries(benchGroups)) {
      const bench = await ctx.db.get(benchId as any);
      if (!bench) continue;

      // Bench quality
      const ratings = await ctx.db
        .query("benchQualityRatings")
        .withIndex("by_bench", (q) => q.eq("benchId", benchId as any))
        .collect();
      const benchQuality =
        ratings.length === 0
          ? 50
          : (ratings.reduce(
              (sum, r) =>
                sum +
                (r.relevance + r.contamination + r.discriminability + r.reproducibility) /
                  4,
              0
            ) /
              ratings.length) *
            20;

      const validSubmissions = submissions.filter((s) => s.upvotes > s.downvotes);
      const validScores = validSubmissions.map((s) => s.normalizedScore).sort((a, b) => a - b);
      const effectiveScore =
        validScores.length === 0
          ? null
          : validScores.length % 2 === 0
            ? (validScores[validScores.length / 2 - 1] + validScores[validScores.length / 2]) / 2
            : validScores[Math.floor(validScores.length / 2)];

      benchPerformance.push({
        benchId,
        benchName: (bench as any).name,
        benchSlug: (bench as any).slug,
        benchQuality: Math.round(benchQuality * 10) / 10,
        effectiveScore:
          effectiveScore !== null ? Math.round(effectiveScore * 10) / 10 : null,
        validCount: validSubmissions.length,
        totalCount: submissions.length,
        submissions: submissions.map((s) => ({
          _id: s._id,
          rawScore: s.rawScore,
          normalizedScore: s.normalizedScore,
          sourceUrl: s.sourceUrl,
          submittedBy: s.submittedBy,
          createdAt: s.createdAt,
          upvotes: s.upvotes,
          downvotes: s.downvotes,
          isValid: s.upvotes > s.downvotes,
        })),
      });
    }

    // Compute SupraScore
    let weightedSum = 0;
    let weightTotal = 0;
    for (const bp of benchPerformance) {
      if (bp.effectiveScore !== null) {
        weightedSum += bp.benchQuality * bp.effectiveScore;
        weightTotal += bp.benchQuality;
      }
    }
    const supraScore = weightTotal > 0 ? weightedSum / weightTotal : 0;

    return {
      ...model,
      supraScore: Math.round(supraScore * 10) / 10,
      benchPerformance,
    };
  },
});

export const search = query({
  args: { query: v.string() },
  handler: async (ctx, { query: q }) => {
    const models = await ctx.db.query("models").collect();
    const lower = q.toLowerCase();
    return models
      .filter((m) => m.name.toLowerCase().includes(lower))
      .slice(0, 10)
      .map((m) => ({ _id: m._id, name: m.name, provider: m.provider, slug: m.slug }));
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    provider: v.string(),
    familyTag: v.optional(v.string()),
    tags: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    let slug = generateSlug(args.name);
    // Ensure slug uniqueness
    let existing = await ctx.db
      .query("models")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    let counter = 2;
    while (existing) {
      slug = `${generateSlug(args.name)}-${counter}`;
      existing = await ctx.db
        .query("models")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .first();
      counter++;
    }

    return await ctx.db.insert("models", {
      name: args.name,
      provider: args.provider,
      slug,
      familyTag: args.familyTag,
      tags: args.tags,
      addedBy: userId,
      createdAt: Date.now(),
    });
  },
});
