import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

const OFFICIAL_DOMAINS = [
  "lmsys.org",
  "chat.lmsys.org",
  "swebench.com",
  "paperswithcode.com",
  "huggingface.co",
  "scale.com",
  "opencompass.org",
  "evalplus.github.io",
  "arxiv.org",
];

function isOfficialUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return OFFICIAL_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith("." + d)
    );
  } catch {
    return false;
  }
}

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
      const ratings = await ctx.db
        .query("benchQualityRatings")
        .withIndex("by_bench", (q) => q.eq("benchId", bench._id))
        .collect();

      let qualityScore: number;
      const dimensions = { relevance: 0, contamination: 0, discriminability: 0, reproducibility: 0 };

      if (ratings.length === 0) {
        qualityScore = 50;
      } else {
        dimensions.relevance = ratings.reduce((s, r) => s + r.relevance, 0) / ratings.length;
        dimensions.contamination = ratings.reduce((s, r) => s + r.contamination, 0) / ratings.length;
        dimensions.discriminability = ratings.reduce((s, r) => s + r.discriminability, 0) / ratings.length;
        dimensions.reproducibility = ratings.reduce((s, r) => s + r.reproducibility, 0) / ratings.length;
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

    const dimensions = { relevance: 0, contamination: 0, discriminability: 0, reproducibility: 0 };
    let qualityScore = 50;
    if (ratings.length > 0) {
      dimensions.relevance = ratings.reduce((s, r) => s + r.relevance, 0) / ratings.length;
      dimensions.contamination = ratings.reduce((s, r) => s + r.contamination, 0) / ratings.length;
      dimensions.discriminability = ratings.reduce((s, r) => s + r.discriminability, 0) / ratings.length;
      dimensions.reproducibility = ratings.reduce((s, r) => s + r.reproducibility, 0) / ratings.length;
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

    return {
      ...bench,
      qualityScore: Math.round(qualityScore * 10) / 10,
      dimensions: {
        relevance: Math.round(dimensions.relevance * 10) / 10,
        contamination: Math.round(dimensions.contamination * 10) / 10,
        discriminability: Math.round(dimensions.discriminability * 10) / 10,
        reproducibility: Math.round(dimensions.reproducibility * 10) / 10,
      },
      raterCount: ratings.length,
      modelScores,
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
      .take(10);
    return results.map((b) => ({
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

    return await ctx.db.insert("benches", {
      name: args.name,
      slug,
      description: args.description,
      url: args.url,
      isOfficial: isOfficialUrl(args.url),
      tags: args.tags,
      scaleMin: args.scaleMin,
      scaleMax: args.scaleMax,
      addedBy: userId,
      createdAt: Date.now(),
    });
  },
});

export const addTag = mutation({
  args: { benchId: v.id("benches"), tag: v.string() },
  handler: async (ctx, { benchId, tag }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const bench = await ctx.db.get(benchId);
    if (!bench) throw new Error("Benchmark not found");

    const trimmed = tag.trim().toLowerCase();
    if (!trimmed) throw new Error("Tag cannot be empty");
    if (bench.tags.includes(trimmed)) return; // already exists

    await ctx.db.patch(benchId, {
      tags: [...bench.tags, trimmed],
    });
  },
});
