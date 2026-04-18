import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { recomputeEffectiveTags } from "./tagVotes";
import {
  seedCreatorEntityVote,
  assertNotResurrectingOwnHidden,
} from "./entityVotes";
import { isOfficialUrl } from "./urls";

const RATE_LIMIT_PER_DAY = 30;

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

const NEW_BENCH = v.object({
  name: v.string(),
  description: v.string(),
  url: v.string(),
  scaleMin: v.number(),
  scaleMax: v.number(),
  tags: v.array(v.string()),
});

const NEW_MODEL = v.object({
  name: v.string(),
  provider: v.string(),
  familyTag: v.optional(v.string()),
  tags: v.array(v.string()),
});

// ── Internal helpers ──

async function checkRateLimit(ctx: any, userId: Id<"users">, addCount: number) {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recent = await ctx.db
    .query("modelScores")
    .withIndex("by_submitter", (q: any) => q.eq("submittedBy", userId))
    .filter((q: any) => q.gte(q.field("createdAt"), oneDayAgo))
    .collect();
  if (recent.length + addCount > RATE_LIMIT_PER_DAY) {
    throw new Error(
      `Rate limit: max ${RATE_LIMIT_PER_DAY} scores per 24h (you already have ${recent.length})`
    );
  }
}

async function resolveOrCreateBench(
  ctx: any,
  userId: Id<"users">,
  args: { benchId?: Id<"benches">; newBench?: any }
): Promise<{ benchId: Id<"benches">; bench: any }> {
  if (args.benchId) {
    const bench = await ctx.db.get(args.benchId);
    if (!bench) throw new Error("Benchmark not found");
    if (bench.hidden) throw new Error("This benchmark has been removed by the community");
    return { benchId: args.benchId, bench };
  }
  if (!args.newBench) throw new Error("Either benchId or newBench must be provided");

  const nb = args.newBench;
  if (!nb.name?.trim()) throw new Error("Benchmark name is required");
  await assertNotResurrectingOwnHidden(ctx, "bench", nb.name, userId);

  let slug = generateSlug(nb.name);
  let existing = await ctx.db
    .query("benches")
    .withIndex("by_slug", (q: any) => q.eq("slug", slug))
    .first();
  let counter = 2;
  while (existing) {
    slug = `${generateSlug(nb.name)}-${counter}`;
    existing = await ctx.db
      .query("benches")
      .withIndex("by_slug", (q: any) => q.eq("slug", slug))
      .first();
    counter++;
  }
  const benchId = await ctx.db.insert("benches", {
    name: nb.name,
    slug,
    description: nb.description,
    url: nb.url,
    isOfficial: isOfficialUrl(nb.url),
    tags: [],
    scaleMin: nb.scaleMin,
    scaleMax: nb.scaleMax,
    addedBy: userId,
    createdAt: Date.now(),
  });
  await seedCreatorEntityVote(ctx, "bench", benchId as unknown as string, userId);

  const seen = new Set<string>();
  for (const raw of nb.tags) {
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
  return { benchId, bench: await ctx.db.get(benchId) };
}

async function resolveOrCreateModel(
  ctx: any,
  userId: Id<"users">,
  args: { modelId?: Id<"models">; newModel?: any }
): Promise<Id<"models">> {
  if (args.modelId) {
    const model = await ctx.db.get(args.modelId);
    if (!model) throw new Error("Model not found");
    if (model.hidden) throw new Error("This model has been removed by the community");
    return args.modelId;
  }
  if (!args.newModel) throw new Error("Either modelId or newModel must be provided");

  const nm = args.newModel;
  if (!nm.name?.trim()) throw new Error("Model name is required");
  if (!nm.provider?.trim()) throw new Error("Provider is required");
  await assertNotResurrectingOwnHidden(ctx, "model", nm.name, userId);

  let slug = generateSlug(nm.name);
  let existing = await ctx.db
    .query("models")
    .withIndex("by_slug", (q: any) => q.eq("slug", slug))
    .first();
  let counter = 2;
  while (existing) {
    slug = `${generateSlug(nm.name)}-${counter}`;
    existing = await ctx.db
      .query("models")
      .withIndex("by_slug", (q: any) => q.eq("slug", slug))
      .first();
    counter++;
  }
  const modelId = await ctx.db.insert("models", {
    name: nm.name,
    provider: nm.provider,
    slug,
    familyTag: nm.familyTag,
    tags: [],
    addedBy: userId,
    createdAt: Date.now(),
  });
  await ctx.db.insert("modelRankings", {
    modelId,
    name: nm.name,
    provider: nm.provider,
    slug,
    familyTag: nm.familyTag,
    tags: [],
    supraScore: 0,
    benchCount: 0,
    updatedAt: Date.now(),
    hidden: false,
  });
  await seedCreatorEntityVote(ctx, "model", modelId as unknown as string, userId);

  const seen = new Set<string>();
  for (const raw of nm.tags) {
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
}

async function insertScore(
  ctx: any,
  userId: Id<"users">,
  modelId: Id<"models">,
  benchId: Id<"benches">,
  bench: any,
  rawScore: number,
  sourceUrl: string,
  accessedAt: number
): Promise<Id<"modelScores">> {
  if (!Number.isFinite(rawScore)) throw new Error("Invalid score");
  if (rawScore < bench.scaleMin || rawScore > bench.scaleMax) {
    throw new Error(`Score ${rawScore} out of range (${bench.scaleMin}–${bench.scaleMax})`);
  }
  try {
    new URL(sourceUrl);
  } catch {
    throw new Error(`Invalid source URL: ${sourceUrl}`);
  }
  if (!Number.isFinite(accessedAt) || accessedAt <= 0) {
    throw new Error("Invalid 'accessed on' date");
  }

  const normalized =
    bench.scaleMax === bench.scaleMin
      ? 0
      : ((rawScore - bench.scaleMin) / (bench.scaleMax - bench.scaleMin)) * 100;

  // Denormalize submitter identity at insert time so detail/profile
  // queries don't need an O(1) db.get(submittedBy) per submission.
  const submitter = await ctx.db.get(userId);

  const scoreId = await ctx.db.insert("modelScores", {
    modelId,
    benchId,
    rawScore,
    normalizedScore: Math.round(normalized * 100) / 100,
    sourceUrl,
    accessedAt,
    submittedBy: userId,
    createdAt: Date.now(),
    upvotes: 1,
    downvotes: 0,
    submitterName: (submitter as any)?.name ?? "Unknown",
    submitterImage: (submitter as any)?.image ?? undefined,
  });
  await ctx.db.insert("votes", {
    targetId: scoreId as unknown as string,
    targetType: "modelScore",
    userId,
    value: 1,
  });
  return scoreId;
}

// ────────────────────────────────────────────
// Public mutations — three submit modes.
// ────────────────────────────────────────────

// Mode A: a single new score against an existing model + existing bench.
export const submitOne = mutation({
  args: {
    modelId: v.id("models"),
    benchId: v.id("benches"),
    rawScore: v.number(),
    sourceUrl: v.string(),
    accessedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await checkRateLimit(ctx, userId, 1);

    const { benchId, bench } = await resolveOrCreateBench(ctx, userId, {
      benchId: args.benchId,
    });
    const modelId = await resolveOrCreateModel(ctx, userId, {
      modelId: args.modelId,
    });
    const scoreId = await insertScore(
      ctx, userId, modelId, benchId, bench,
      args.rawScore, args.sourceUrl, args.accessedAt
    );
    await ctx.scheduler.runAfter(0, internal.rankings.recomputeModel, { modelId });
    await ctx.scheduler.runAfter(0, internal.cache.recomputeBenchAggregates, { benchId });
    return { scoreIds: [scoreId], benchId, modelIds: [modelId] };
  },
});

// Mode B: one benchmark + many model scores. Used when you publish a
// brand-new benchmark and want to seed it with all the models you tested.
export const submitForBench = mutation({
  args: {
    benchId: v.optional(v.id("benches")),
    newBench: v.optional(NEW_BENCH),
    scores: v.array(
      v.object({
        modelId: v.optional(v.id("models")),
        newModel: v.optional(NEW_MODEL),
        rawScore: v.number(),
        sourceUrl: v.string(),
        accessedAt: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    if (args.scores.length === 0) throw new Error("At least one score required");
    if (args.scores.length > 30) throw new Error("Max 30 scores per submission");
    await checkRateLimit(ctx, userId, args.scores.length);

    const { benchId, bench } = await resolveOrCreateBench(ctx, userId, {
      benchId: args.benchId, newBench: args.newBench,
    });

    const scoreIds: Id<"modelScores">[] = [];
    const modelIdsAffected = new Set<string>();
    for (let i = 0; i < args.scores.length; i++) {
      const e = args.scores[i];
      try {
        const modelId = await resolveOrCreateModel(ctx, userId, {
          modelId: e.modelId, newModel: e.newModel,
        });
        const scoreId = await insertScore(
          ctx, userId, modelId, benchId, bench,
          e.rawScore, e.sourceUrl, e.accessedAt
        );
        scoreIds.push(scoreId);
        modelIdsAffected.add(modelId as unknown as string);
      } catch (err: any) {
        throw new Error(`Score #${i + 1}: ${err.message}`);
      }
    }
    for (const m of modelIdsAffected) {
      await ctx.scheduler.runAfter(0, internal.rankings.recomputeModel, {
        modelId: m as Id<"models">,
      });
    }
    // Single bench, many new scores → one aggregate refresh for it.
    await ctx.scheduler.runAfter(0, internal.cache.recomputeBenchAggregates, { benchId });
    return { scoreIds, benchId, modelIds: Array.from(modelIdsAffected) };
  },
});

// Mode C: one model + many bench scores. Used when a new model drops and
// you want to enter results across all the benchmarks you ran.
export const submitForModel = mutation({
  args: {
    modelId: v.optional(v.id("models")),
    newModel: v.optional(NEW_MODEL),
    scores: v.array(
      v.object({
        benchId: v.optional(v.id("benches")),
        newBench: v.optional(NEW_BENCH),
        rawScore: v.number(),
        sourceUrl: v.string(),
        accessedAt: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    if (args.scores.length === 0) throw new Error("At least one score required");
    if (args.scores.length > 30) throw new Error("Max 30 scores per submission");
    await checkRateLimit(ctx, userId, args.scores.length);

    const modelId = await resolveOrCreateModel(ctx, userId, {
      modelId: args.modelId, newModel: args.newModel,
    });

    const scoreIds: Id<"modelScores">[] = [];
    const benchIdsAffected = new Set<string>();
    for (let i = 0; i < args.scores.length; i++) {
      const e = args.scores[i];
      try {
        const { benchId, bench } = await resolveOrCreateBench(ctx, userId, {
          benchId: e.benchId, newBench: e.newBench,
        });
        const scoreId = await insertScore(
          ctx, userId, modelId, benchId, bench,
          e.rawScore, e.sourceUrl, e.accessedAt
        );
        scoreIds.push(scoreId);
        benchIdsAffected.add(benchId as unknown as string);
      } catch (err: any) {
        throw new Error(`Score #${i + 1}: ${err.message}`);
      }
    }
    await ctx.scheduler.runAfter(0, internal.rankings.recomputeModel, { modelId });
    for (const b of benchIdsAffected) {
      await ctx.scheduler.runAfter(0, internal.cache.recomputeBenchAggregates, {
        benchId: b as Id<"benches">,
      });
    }
    return { scoreIds, modelId };
  },
});

// ────────────────────────────────────────────
// Queries
// ────────────────────────────────────────────

export const getById = query({
  args: { id: v.id("modelScores") },
  handler: async (ctx, { id }) => {
    const score = await ctx.db.get(id);
    if (!score) return null;
    const model = await ctx.db.get(score.modelId);
    const bench = await ctx.db.get(score.benchId);

    // Prefer denormalized submitter fields; fall back to db.get only if
    // the score row predates the migration.
    let submitterName = score.submitterName;
    let submitterImage = score.submitterImage ?? null;
    if (submitterName === undefined) {
      const user = await ctx.db.get(score.submittedBy);
      submitterName = (user as any)?.name ?? "Unknown";
      submitterImage = (user as any)?.image ?? null;
    }

    return {
      ...score,
      modelName: model?.name ?? "Unknown",
      modelSlug: (model as any)?.slug ?? "",
      modelHidden: (model as any)?.hidden ?? false,
      benchName: (bench as any)?.name ?? "Unknown",
      benchSlug: (bench as any)?.slug ?? "",
      benchHidden: (bench as any)?.hidden ?? false,
      scaleMin: (bench as any)?.scaleMin ?? 0,
      scaleMax: (bench as any)?.scaleMax ?? 100,
      submitterName,
      submitterImage,
      isValid: score.upvotes > score.downvotes,
    };
  },
});

export const listByModelBench = query({
  args: { modelId: v.id("models"), benchId: v.id("benches") },
  handler: async (ctx, { modelId, benchId }) => {
    const scores = await ctx.db
      .query("modelScores")
      .withIndex("by_model_bench", (q) =>
        q.eq("modelId", modelId).eq("benchId", benchId)
      )
      .collect();
    const enriched = [];
    for (const s of scores) {
      let submitterName = s.submitterName;
      let submitterImage = s.submitterImage ?? null;
      if (submitterName === undefined) {
        const user = await ctx.db.get(s.submittedBy);
        submitterName = (user as any)?.name ?? "Unknown";
        submitterImage = (user as any)?.image ?? null;
      }
      enriched.push({
        ...s,
        submitterName,
        submitterImage,
        isValid: s.upvotes > s.downvotes,
      });
    }
    return enriched.sort((a, b) => b.upvotes - a.upvotes);
  },
});

// User activity feed for the profile page.
export const listByUser = query({
  args: { userId: v.id("users"), limit: v.optional(v.number()) },
  handler: async (ctx, { userId, limit }) => {
    const lim = limit ?? 100;
    const rows = await ctx.db
      .query("modelScores")
      .withIndex("by_submitter", (q) => q.eq("submittedBy", userId))
      .order("desc")
      .take(lim);
    const out = [];
    for (const s of rows) {
      const model = await ctx.db.get(s.modelId);
      const bench = await ctx.db.get(s.benchId);
      out.push({
        _id: s._id,
        modelName: (model as any)?.name ?? "Unknown",
        modelSlug: (model as any)?.slug ?? "",
        modelHidden: (model as any)?.hidden ?? false,
        benchName: (bench as any)?.name ?? "Unknown",
        benchSlug: (bench as any)?.slug ?? "",
        benchHidden: (bench as any)?.hidden ?? false,
        rawScore: s.rawScore,
        normalizedScore: s.normalizedScore,
        sourceUrl: s.sourceUrl,
        accessedAt: s.accessedAt,
        createdAt: s.createdAt,
        upvotes: s.upvotes,
        downvotes: s.downvotes,
        isValid: s.upvotes > s.downvotes,
      });
    }
    return out;
  },
});
