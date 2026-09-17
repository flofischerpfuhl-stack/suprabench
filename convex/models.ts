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
  rankWithCore,
} from "./rankings";
import { enforceDailyActionLimit } from "./abuse";
import { canonicalFamilyTag } from "./modelFamilies";

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
      representativeModelId: r.representativeModelId,
      representativeName: r.representativeName,
      representativeSlug: r.representativeSlug,
      aggregationMethod: r.aggregationMethod,
      provisional: r.provisional ?? true,
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

// ── Tag-filtered leaderboards ───────────────────────────────
// The live site computes tag-filtered scores in the browser from
// `rankingSnapshot` (one cached read for every visitor instead of a full
// score-table read per tag combination). These two queries are kept for API
// compatibility and for clients still running a cached older frontend. Both
// run the same shared fit restricted to benches that carry any active tag.
async function filteredCoreRanking(ctx: any, activeTags: string[]) {
  const benches = await ctx.db.query("benches").collect();
  const models = await ctx.db.query("models").collect();
  const scores = await ctx.db.query("modelScores").collect();
  return rankWithCore({
    models,
    benches,
    scores: scores.map((score: any) => ({
      modelId: score.modelId as string,
      benchId: score.benchId as string,
      normalizedScore: score.normalizedScore,
      upvotes: score.upvotes,
      downvotes: score.downvotes,
    })),
    benchFilter: (b: any) => (b.tags ?? []).some((t: string) => activeTags.includes(t)),
  });
}

function byFilteredScore(a: any, b: any) {
  if (a.filteredScore !== null && b.filteredScore === null) return -1;
  if (a.filteredScore === null && b.filteredScore !== null) return 1;
  if (a.filteredScore !== null && b.filteredScore !== null) {
    return b.filteredScore - a.filteredScore;
  }
  return b.supraScore - a.supraScore;
}

export const listRankedFamiliesWithFilter = query({
  args: { activeTags: v.array(v.string()) },
  handler: async (ctx, { activeTags }) => {
    const rankings = await ctx.db
      .query("familyRankings")
      .withIndex("by_score")
      .order("desc")
      .collect();
    const visible = rankings.filter((r) => !(r.hidden ?? false));
    const filtered =
      activeTags.length === 0 ? null : await filteredCoreRanking(ctx, activeTags);
    const byFamily = new Map(
      (filtered?.families ?? []).map((row) => [row.familyKey, row])
    );
    const out = visible.map((family) => {
      const row = byFamily.get(`${family.familyTag}\u0000${family.provider}`);
      return {
        familyTag: family.familyTag,
        provider: family.provider,
        supraScore: family.supraScore,
        benchCount: filtered ? row?.benchCount ?? 0 : family.benchCount,
        modelCount: family.modelCount,
        representativeModelId: family.representativeModelId,
        representativeName: family.representativeName,
        representativeSlug: family.representativeSlug,
        aggregationMethod: family.aggregationMethod,
        provisional: filtered ? row?.provisional ?? true : family.provisional ?? true,
        tags: family.tags,
        filteredScore:
          row && row.ability !== null ? row.supraScore : (null as number | null),
      };
    });
    if (filtered) out.sort(byFilteredScore);
    return out;
  },
});

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
    const filtered =
      activeTags.length === 0 ? null : await filteredCoreRanking(ctx, activeTags);
    const byModel = new Map(
      (filtered?.configs ?? []).map((row) => [row.modelId, row])
    );
    const out = rankings.map((r) => {
      const row = byModel.get(r.modelId as string);
      return {
        _id: r.modelId,
        name: r.name,
        provider: r.provider,
        slug: r.slug,
        familyTag: r.familyTag,
        tags: r.tags,
        supraScore: r.supraScore,
        benchCount: r.benchCount,
        filteredScore:
          row && row.ability !== null ? row.supraScore : (null as number | null),
      };
    });
    if (filtered) out.sort(byFilteredScore);
    return out;
  },
});

// Everything the shared ranking core needs, in one public, cacheable read.
// The browser uses it to compute tag-filtered leaderboards locally: Convex
// caches this result for every visitor until a score, vote or rating
// changes, so filtering costs no database reads per click.
export const rankingSnapshot = query({
  args: {},
  handler: async (ctx) => {
    const benches = await ctx.db.query("benches").collect();
    const models = await ctx.db.query("models").collect();
    const scores = await ctx.db.query("modelScores").collect();
    const visibleModels = models.filter((m: any) => !m.hidden);
    const visibleBenches = benches.filter((b: any) => !b.hidden);
    const modelIds = new Set(visibleModels.map((m) => m._id as string));
    const benchIds = new Set(visibleBenches.map((b) => b._id as string));

    // Collapse submissions to one median cell per (model, bench) so the
    // payload carries no submitter data and stays small.
    const cells = new Map<string, number[]>();
    for (const s of scores) {
      if (s.upvotes <= s.downvotes) continue;
      if (!modelIds.has(s.modelId as string) || !benchIds.has(s.benchId as string)) continue;
      const key = `${s.modelId}|${s.benchId}`;
      const list = cells.get(key);
      if (list) list.push(s.normalizedScore);
      else cells.set(key, [s.normalizedScore]);
    }
    return {
      models: visibleModels.map((m: any) => ({
        _id: m._id,
        name: m.name,
        provider: m.provider,
        slug: m.slug,
        familyTag: m.familyTag ?? null,
        tags: m.tags ?? [],
      })),
      benches: visibleBenches.map((b: any) => ({
        _id: b._id,
        tags: b.tags ?? [],
        cachedDimensions: b.cachedDimensions ?? null,
        cachedRaterCount: b.cachedRaterCount ?? 0,
        cachedHeadroom: b.cachedHeadroom ?? null,
        cachedNetUpvotes:
          typeof b.cachedNetUpvotes === "number" ? b.cachedNetUpvotes : 1,
      })),
      scores: Array.from(cells, ([key, values]) => {
        const [modelId, benchId] = key.split("|");
        return { modelId, benchId, normalizedScore: median(values) };
      }),
    };
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

    const familyTag = canonicalFamilyTag(args.name, args.familyTag);
    const modelId = await ctx.db.insert("models", {
      name: args.name,
      provider: args.provider,
      slug,
      familyTag,
      tags: [],
      addedBy: userId,
      createdAt: Date.now(),
    });

    await ctx.db.insert("modelRankings", {
      modelId,
      name: args.name,
      provider: args.provider,
      slug,
      familyTag,
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
