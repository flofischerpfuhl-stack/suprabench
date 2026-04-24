import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { recomputeEffectiveTags } from "./tagVotes";
import {
  seedCreatorEntityVote,
  assertNotResurrectingOwnHidden,
} from "./entityVotes";
import {
  getBenchWeights,
  getBenchCoverageIndex,
  effectiveBenchWeight,
} from "./rankings";
import { enforceDailyActionLimit } from "./abuse";

const MAX_NAME_LEN = 120;
const MAX_PROVIDER_LEN = 80;
const MAX_FAMILY_TAG_LEN = 80;
const CREATE_LIMIT_PER_DAY = 10;

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// Filter out hidden models from a rankings list.
//
// Fast path: read `hidden` directly from the denormalized
// modelRankings cache (kept in sync by entityVotes.applyHiddenState).
// Slow fallback: if a row hasn't been backfilled yet (cached field is
// undefined), look up the source-of-truth on the models table. This
// keeps results correct during migration; once `migrations:backfillAll`
// has run, the slow path is never taken.
async function filterHiddenRankings(ctx: any, rankings: any[]) {
  const out = [];
  for (const r of rankings) {
    if (typeof r.hidden === "boolean") {
      if (!r.hidden) out.push(r);
      continue;
    }
    const m = await ctx.db.get(r.modelId);
    if (m && !m.hidden) out.push(r);
  }
  return out;
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
    const visible = await filterHiddenRankings(ctx, rankings);

    return visible.map((r) => ({
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
    if (model.hidden) return null;

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
      if (!bench || (bench as any).hidden) continue;

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
      .take(20);
    return results
      .filter((m) => !m.hidden)
      .slice(0, 10)
      .map((m) => ({
        _id: m._id,
        name: m.name,
        provider: m.provider,
        slug: m.slug,
      }));
  },
});

// Distinct provider list — for autocomplete on the submit form so users
// don't accidentally introduce duplicate spellings ("OpenAi" vs "OpenAI").
export const listProviders = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("models").collect();
    const seen = new Map<string, string>(); // lowercase -> canonical
    for (const m of all) {
      if (m.hidden) continue;
      const key = (m.provider ?? "").trim().toLowerCase();
      if (key && !seen.has(key)) seen.set(key, m.provider);
    }
    return Array.from(seen.values()).sort();
  },
});

// Ranked FAMILIES from the denormalized familyRankings cache.
// Mirrors listRanked's shape but one row = one (familyTag, provider)
// pair. Used when the leaderboard UI is in "families" mode.
export const listRankedFamilies = query({
  args: {},
  handler: async (ctx) => {
    const rankings = await ctx.db
      .query("familyRankings")
      .withIndex("by_score")
      .order("desc")
      .collect();
    // Filter out families where every member is hidden. Cache field is
    // optional (backfill-compat) — treat undefined as "not hidden".
    const visible = rankings.filter((r) => !(r.hidden ?? false));
    return visible.map((r) => ({
      familyTag: r.familyTag,
      provider: r.provider,
      supraScore: r.supraScore,
      benchCount: r.benchCount,
      modelCount: r.modelCount,
      tags: r.tags,
    }));
  },
});

function median(vals: number[]): number {
  vals.sort((a, b) => a - b);
  return vals.length % 2 === 0
    ? (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2
    : vals[Math.floor(vals.length / 2)];
}

async function scopedBenchWeights(ctx: any, benches: any[]) {
  const cov = await getBenchCoverageIndex(ctx);
  const weights: Record<string, number> = {};
  for (const b of benches) {
    const raw =
      typeof b.cachedEffectiveWeight === "number"
        ? b.cachedEffectiveWeight
        : (await getBenchWeights(ctx, b._id as any)).weight;
    weights[b._id as string] = effectiveBenchWeight(
      raw,
      cov.upvoteMap.get(b._id as string) ?? 1,
      cov.upvoteMax,
      cov.modelCountMap.get(b._id as string) ?? 0,
      cov.modelCountMax
    );
  }
  return weights;
}

function supraFromAggregate(weightedSum: number, totalWeight: number, maxWeight: number) {
  if (totalWeight <= 0 || maxWeight <= 0) return null;
  const weightedMean = weightedSum / totalWeight;
  return Math.round(weightedMean * Math.sqrt(Math.min(1, totalWeight / maxWeight)) * 10) / 10;
}

// Ranked FAMILIES with a tag-filtered score. Parallel to
// listRankedWithFilter, but the inner aggregation is the same
// "median-of-member-medians, weighted by full bench weight" semantics
// used by familyRankings.recomputeAll. activeTags is OR-matched
// against bench tags (a bench counts if it has any of the tags).
export const listRankedFamiliesWithFilter = query({
  args: { activeTags: v.array(v.string()) },
  handler: async (ctx, { activeTags }) => {
    const rankings = await ctx.db
      .query("familyRankings")
      .withIndex("by_score")
      .order("desc")
      .collect();
    const visible = rankings.filter((r) => !(r.hidden ?? false));

    if (activeTags.length === 0) {
      return visible.map((r) => ({
        familyTag: r.familyTag,
        provider: r.provider,
        supraScore: r.supraScore,
        benchCount: r.benchCount,
        modelCount: r.modelCount,
        tags: r.tags,
        filteredScore: null as number | null,
      }));
    }

    const allBenches = await ctx.db.query("benches").collect();
    const matchingBenches = allBenches.filter(
      (b) => !b.hidden && b.tags.some((t) => activeTags.includes(t))
    );
    const matchingBenchIds = new Set<string>(
      matchingBenches.map((b) => b._id as string)
    );
    const benchWeight = await scopedBenchWeights(ctx, matchingBenches);

    const allModels = await ctx.db.query("models").collect();
    const out = [];
    let maxWeight = 0;
    for (const r of visible) {
      const members = allModels.filter(
        (m: any) =>
          !m.hidden &&
          (m.familyTag ?? "").trim() === r.familyTag &&
          m.provider === r.provider
      );

      // perBench[benchId] = array of per-member medians on that bench,
      // restricted to matching benches and net-positive scores. The
      // outer median across that array is the family's score on that
      // bench (matches familyRankings.recomputeAll semantics).
      const perBench: Record<string, number[]> = {};
      for (const m of members) {
        const scores = await ctx.db
          .query("modelScores")
          .withIndex("by_model", (q) => q.eq("modelId", m._id))
          .collect();
        const byBench: Record<string, number[]> = {};
        for (const s of scores) {
          const bId = s.benchId as string;
          if (!matchingBenchIds.has(bId)) continue;
          if (s.upvotes <= s.downvotes) continue;
          (byBench[bId] ??= []).push(s.normalizedScore);
        }
        for (const [bId, vals] of Object.entries(byBench)) {
          vals.sort((a, b) => a - b);
          (perBench[bId] ??= []).push(median(vals));
        }
      }

      let weighted = 0;
      let weight = 0;
      for (const [bId, memberMeds] of Object.entries(perBench)) {
        const familyMed = median(memberMeds);
        const w = benchWeight[bId] ?? 0;
        if (w <= 0) continue;
        weighted += w * familyMed;
        weight += w;
      }
      if (weight > maxWeight) maxWeight = weight;

      out.push({
        familyTag: r.familyTag,
        provider: r.provider,
        supraScore: r.supraScore,
        benchCount: r.benchCount,
        modelCount: r.modelCount,
        tags: r.tags,
        filteredScore: null as number | null,
        _filteredWeighted: weighted,
        _filteredWeight: weight,
      });
    }

    for (const row of out) {
      row.filteredScore = supraFromAggregate(row._filteredWeighted, row._filteredWeight, maxWeight);
      delete (row as any)._filteredWeighted;
      delete (row as any)._filteredWeight;
    }

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

// Distinct family-tags list — same idea, prevents typo splits.
export const listFamilyTags = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("models").collect();
    const seen = new Map<string, string>();
    for (const m of all) {
      if (m.hidden || !m.familyTag) continue;
      const key = m.familyTag.trim().toLowerCase();
      if (key && !seen.has(key)) seen.set(key, m.familyTag);
    }
    return Array.from(seen.values()).sort();
  },
});

// ── Ranked models + filtered score (scoped to benches matching any active tag) ──
export const listRankedWithFilter = query({
  args: { activeTags: v.array(v.string()) },
  handler: async (ctx, { activeTags }) => {
    const allRankings = await ctx.db
      .query("modelRankings")
      .withIndex("by_score")
      .order("desc")
      .collect();
    const rankings = await filterHiddenRankings(ctx, allRankings);

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
    const matchingBenches = allBenches.filter(
      (b) => !b.hidden && b.tags.some((t) => activeTags.includes(t))
    );
    const matchingBenchIds = new Set<string>(
      matchingBenches.map((b) => b._id as string)
    );

    // Pre-compute full bench weight (quality × difficulty × headroom).
    //
    // Fast path: read from the denormalized cachedEffectiveWeight on the
    // bench (kept fresh by cache.recomputeBenchAggregates).
    // Slow fallback: compute live via getBenchWeights for benches that
    // haven't been backfilled yet. Once `migrations:backfillAll` has run,
    // the slow path is never taken.
    const benchWeight = await scopedBenchWeights(ctx, matchingBenches);

    const out = [];
    let maxWeight = 0;
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
        const med = median(vals);
        const w = benchWeight[bId] ?? 0;
        if (w <= 0) continue;
        weighted += w * med;
        weight += w;
      }
      if (weight > maxWeight) maxWeight = weight;

      out.push({
        _id: r.modelId,
        name: r.name,
        provider: r.provider,
        slug: r.slug,
        familyTag: r.familyTag,
        tags: r.tags,
        supraScore: r.supraScore,
        benchCount: r.benchCount,
        filteredScore: null as number | null,
        _filteredWeighted: weighted,
        _filteredWeight: weight,
      });
    }

    for (const row of out) {
      row.filteredScore = supraFromAggregate(row._filteredWeighted, row._filteredWeight, maxWeight);
      delete (row as any)._filteredWeighted;
      delete (row as any)._filteredWeight;
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
    if (!args.name?.trim()) throw new Error("Name is required");
    if (!args.provider?.trim()) throw new Error("Provider is required");
    if (args.name.trim().length > MAX_NAME_LEN) throw new Error("Name too long");
    if (args.provider.trim().length > MAX_PROVIDER_LEN) throw new Error("Provider too long");
    if ((args.familyTag ?? "").trim().length > MAX_FAMILY_TAG_LEN) throw new Error("Family tag too long");
    await enforceDailyActionLimit(ctx, userId, "create-model", CREATE_LIMIT_PER_DAY);
    await assertNotResurrectingOwnHidden(ctx, "model", args.name, userId);

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
      tags: [],
      addedBy: userId,
      createdAt: Date.now(),
    });

    await ctx.db.insert("modelRankings", {
      modelId,
      name: args.name,
      provider: args.provider,
      slug,
      familyTag: args.familyTag,
      tags: [],
      supraScore: 0,
      benchCount: 0,
      updatedAt: Date.now(),
      hidden: false,
    });
    await seedCreatorEntityVote(ctx, "model", modelId as unknown as string, userId);

    const seen = new Set<string>();
    for (const raw of args.tags) {
      const t = raw.trim().toLowerCase();
      if (!t || t.length > 30 || seen.has(t)) continue;
      seen.add(t);
      await ctx.db.insert("tagVotes", {
        entityType: "model",
        entityId: modelId as unknown as string,
        tag: t,
        userId,
        value: 1,
      });
    }
    await recomputeEffectiveTags(ctx, "model", modelId as unknown as string);
    return modelId;
  },
});
