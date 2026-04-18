import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// ── List ranked models from denormalized cache ──
export const listRanked = query({
  args: {},
  handler: async (ctx) => {
    // O(1) read from cache table instead of O(n×m)
    const rankings = await ctx.db
      .query("modelRankings")
      .withIndex("by_score")
      .order("desc")
      .collect();

    return rankings.map((r) => ({
      _id: r.modelId,
      name: r.name,
      provider: r.provider,
      slug: r.slug,
      familyTag: r.familyTag,
      tags: r.tags,
      supraScore: r.supraScore,
      benchCount: r.benchCount,
    }));
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

    // Get cached SupraScore
    const ranking = await ctx.db
      .query("modelRankings")
      .withIndex("by_model", (q) => q.eq("modelId", model._id))
      .first();
    const supraScore = ranking?.supraScore ?? 0;

    return {
      ...model,
      supraScore,
      benchPerformance,
    };
  },
});

export const search = query({
  args: { query: v.string() },
  handler: async (ctx, { query: q }) => {
    if (q.length < 2) return [];
    const results = await ctx.db
      .query("models")
      .withSearchIndex("search_name", (s) => s.search("name", q))
      .take(10);
    return results.map((m) => ({
      _id: m._id,
      name: m.name,
      provider: m.provider,
      slug: m.slug,
    }));
  },
});

// ── Ranked models + filtered score (scoped to benches matching any active tag) ──
export const listRankedWithFilter = query({
  args: { activeTags: v.array(v.string()) },
  handler: async (ctx, { activeTags }) => {
    const rankings = await ctx.db
      .query("modelRankings")
      .withIndex("by_score")
      .order("desc")
      .collect();

    if (activeTags.length === 0) {
      return rankings.map((r) => ({
        _id: r.modelId,
        name: r.name,
        provider: r.provider,
        slug: r.slug,
        familyTag: r.familyTag,
        tags: r.tags,
        supraScore: r.supraScore,
        benchCount: r.benchCount,
        filteredScore: null,
      }));
    }

    // Find benches matching ANY of the active tags
    const allBenches = await ctx.db.query("benches").collect();
    const matchingBenchIds = new Set<string>(
      allBenches
        .filter((b) => b.tags.some((t) => activeTags.includes(t)))
        .map((b) => b._id as string)
    );

    // Pre-compute quality per matching bench
    const benchQuality: Record<string, number> = {};
    for (const benchId of matchingBenchIds) {
      const ratings = await ctx.db
        .query("benchQualityRatings")
        .withIndex("by_bench", (q) => q.eq("benchId", benchId as any))
        .collect();
      benchQuality[benchId] =
        ratings.length === 0
          ? 50
          : (ratings.reduce(
              (s, r) =>
                s +
                (r.relevance + r.contamination + r.discriminability + r.reproducibility) /
                  4,
              0
            ) /
              ratings.length) *
            20;
    }

    const out = [];
    for (const r of rankings) {
      const scores = await ctx.db
        .query("modelScores")
        .withIndex("by_model", (q) => q.eq("modelId", r.modelId))
        .collect();

      // Group valid scores by bench, scoped to matching benches
      const byBench: Record<string, number[]> = {};
      for (const s of scores) {
        const bId = s.benchId as string;
        if (!matchingBenchIds.has(bId)) continue;
        if (s.upvotes <= s.downvotes) continue;
        if (!byBench[bId]) byBench[bId] = [];
        byBench[bId].push(s.normalizedScore);
      }

      let weighted = 0;
      let weight = 0;
      for (const [bId, vals] of Object.entries(byBench)) {
        vals.sort((a, b) => a - b);
        const median =
          vals.length % 2 === 0
            ? (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2
            : vals[Math.floor(vals.length / 2)];
        const q = benchQuality[bId] ?? 50;
        weighted += q * median;
        weight += q;
      }

      const filteredScore =
        weight > 0 ? Math.round((weighted / weight) * 10) / 10 : null;

      out.push({
        _id: r.modelId,
        name: r.name,
        provider: r.provider,
        slug: r.slug,
        familyTag: r.familyTag,
        tags: r.tags,
        supraScore: r.supraScore,
        benchCount: r.benchCount,
        filteredScore,
      });
    }

    // Sort: models with a filteredScore first, by filteredScore desc,
    // then the rest by supraScore desc
    out.sort((a, b) => {
      if (a.filteredScore !== null && b.filteredScore === null) return -1;
      if (a.filteredScore === null && b.filteredScore !== null) return 1;
      if (a.filteredScore !== null && b.filteredScore !== null) {
        return b.filteredScore - a.filteredScore;
      }
      return b.supraScore - a.supraScore;
    });

    return out;
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

    const modelId = await ctx.db.insert("models", {
      name: args.name,
      provider: args.provider,
      slug,
      familyTag: args.familyTag,
      tags: args.tags,
      addedBy: userId,
      createdAt: Date.now(),
    });

    // Initialize ranking entry
    await ctx.db.insert("modelRankings", {
      modelId,
      name: args.name,
      provider: args.provider,
      slug,
      familyTag: args.familyTag,
      tags: args.tags,
      supraScore: 0,
      benchCount: 0,
      updatedAt: Date.now(),
    });

    return modelId;
  },
});
