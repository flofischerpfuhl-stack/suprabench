import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { recomputeEffectiveTags } from "./tagVotes";

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

const SCORE_ENTRY = v.object({
  modelId: v.optional(v.id("models")),
  newModel: v.optional(NEW_MODEL),
  rawScore: v.number(),
  sourceUrl: v.string(),
  accessedAt: v.number(),
});

// ── Multi-score submission ──
// Lets a contributor submit one or many scores against a single benchmark
// in a single round-trip. Each entry can refer to an existing model OR
// inline-create a new one. The submitter implicitly upvotes each of their
// own submissions so they count as valid out of the gate.
//
// Rate limit: max 30 individual scores per 24h window per user.
export const submitMany = mutation({
  args: {
    benchId: v.optional(v.id("benches")),
    newBench: v.optional(NEW_BENCH),
    scores: v.array(SCORE_ENTRY),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    if (args.scores.length === 0) {
      throw new Error("Must submit at least one score");
    }
    if (args.scores.length > 30) {
      throw new Error("Max 30 scores per submission");
    }

    // Rate limit
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const userRecent = await ctx.db
      .query("modelScores")
      .withIndex("by_submitter", (q) => q.eq("submittedBy", userId))
      .filter((q) => q.gte(q.field("createdAt"), oneDayAgo))
      .collect();
    if (userRecent.length + args.scores.length > 30) {
      throw new Error(
        `Rate limit: max 30 scores per 24h (you already have ${userRecent.length})`
      );
    }

    // Resolve / create bench
    let benchId: Id<"benches">;
    let bench: any;
    if (args.benchId) {
      bench = await ctx.db.get(args.benchId);
      if (!bench) throw new Error("Benchmark not found");
      benchId = args.benchId;
    } else if (args.newBench) {
      const nb = args.newBench;
      let slug = generateSlug(nb.name);
      let existing = await ctx.db
        .query("benches")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .first();
      let counter = 2;
      while (existing) {
        slug = `${generateSlug(nb.name)}-${counter}`;
        existing = await ctx.db
          .query("benches")
          .withIndex("by_slug", (q) => q.eq("slug", slug))
          .first();
        counter++;
      }
      benchId = await ctx.db.insert("benches", {
        name: nb.name,
        slug,
        description: nb.description,
        url: nb.url,
        isOfficial: isOfficialUrl(nb.url),
        tags: [], // will be filled by tag-vote recompute
        scaleMin: nb.scaleMin,
        scaleMax: nb.scaleMax,
        addedBy: userId,
        createdAt: Date.now(),
      });
      bench = await ctx.db.get(benchId);

      // Seed creator's tag votes so initial tags become effective
      const seen = new Set<string>();
      for (const raw of nb.tags) {
        const tag = raw.trim().toLowerCase();
        if (!tag || tag.length > 30 || seen.has(tag)) continue;
        seen.add(tag);
        await ctx.db.insert("tagVotes", {
          entityType: "bench",
          entityId: benchId as unknown as string,
          tag,
          userId,
          value: 1,
        });
      }
      await recomputeEffectiveTags(ctx, "bench", benchId as unknown as string);
    } else {
      throw new Error("Either benchId or newBench must be provided");
    }

    // Process each score entry
    const insertedIds: Id<"modelScores">[] = [];
    const affectedModelIds = new Set<string>();

    for (const entry of args.scores) {
      try {
        new URL(entry.sourceUrl);
      } catch {
        throw new Error(`Invalid source URL: ${entry.sourceUrl}`);
      }
      if (!Number.isFinite(entry.accessedAt) || entry.accessedAt <= 0) {
        throw new Error("Each score must have an 'accessed on' date");
      }

      // Resolve / create model
      let modelId: Id<"models">;
      if (entry.modelId) {
        const model = await ctx.db.get(entry.modelId);
        if (!model) throw new Error("Model not found");
        modelId = entry.modelId;
      } else if (entry.newModel) {
        const nm = entry.newModel;
        let slug = generateSlug(nm.name);
        let existing = await ctx.db
          .query("models")
          .withIndex("by_slug", (q) => q.eq("slug", slug))
          .first();
        let counter = 2;
        while (existing) {
          slug = `${generateSlug(nm.name)}-${counter}`;
          existing = await ctx.db
            .query("models")
            .withIndex("by_slug", (q) => q.eq("slug", slug))
            .first();
          counter++;
        }
        modelId = await ctx.db.insert("models", {
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
        });
        const seen = new Set<string>();
        for (const raw of nm.tags) {
          const tag = raw.trim().toLowerCase();
          if (!tag || tag.length > 30 || seen.has(tag)) continue;
          seen.add(tag);
          await ctx.db.insert("tagVotes", {
            entityType: "model",
            entityId: modelId as unknown as string,
            tag,
            userId,
            value: 1,
          });
        }
        await recomputeEffectiveTags(ctx, "model", modelId as unknown as string);
      } else {
        throw new Error(
          "Each score entry must have either modelId or newModel"
        );
      }

      if (entry.rawScore < bench.scaleMin || entry.rawScore > bench.scaleMax) {
        throw new Error(
          `Score ${entry.rawScore} out of bench scale (${bench.scaleMin}–${bench.scaleMax})`
        );
      }

      const normalizedScore =
        bench.scaleMax === bench.scaleMin
          ? 0
          : ((entry.rawScore - bench.scaleMin) /
              (bench.scaleMax - bench.scaleMin)) *
            100;

      const scoreId = await ctx.db.insert("modelScores", {
        modelId,
        benchId,
        rawScore: entry.rawScore,
        normalizedScore: Math.round(normalizedScore * 100) / 100,
        sourceUrl: entry.sourceUrl,
        accessedAt: entry.accessedAt,
        submittedBy: userId,
        createdAt: Date.now(),
        upvotes: 1,
        downvotes: 0,
      });

      // Implicit submitter upvote
      await ctx.db.insert("votes", {
        targetId: scoreId as unknown as string,
        targetType: "modelScore",
        userId,
        value: 1,
      });

      insertedIds.push(scoreId);
      affectedModelIds.add(modelId as unknown as string);
    }

    // Trigger ranking recomputes (one per affected model)
    for (const m of affectedModelIds) {
      await ctx.scheduler.runAfter(0, internal.rankings.recomputeModel, {
        modelId: m as Id<"models">,
      });
    }

    return { scoreIds: insertedIds, benchId };
  },
});

export const getById = query({
  args: { id: v.id("modelScores") },
  handler: async (ctx, { id }) => {
    const score = await ctx.db.get(id);
    if (!score) return null;

    const model = await ctx.db.get(score.modelId);
    const bench = await ctx.db.get(score.benchId);
    const user = await ctx.db.get(score.submittedBy);

    return {
      ...score,
      modelName: model?.name ?? "Unknown",
      modelSlug: (model as any)?.slug ?? "",
      benchName: (bench as any)?.name ?? "Unknown",
      benchSlug: (bench as any)?.slug ?? "",
      scaleMin: (bench as any)?.scaleMin ?? 0,
      scaleMax: (bench as any)?.scaleMax ?? 100,
      submitterName: (user as any)?.name ?? "Unknown",
      submitterImage: (user as any)?.image ?? null,
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
      const user = await ctx.db.get(s.submittedBy);
      enriched.push({
        ...s,
        submitterName: (user as any)?.name ?? "Unknown",
        submitterImage: (user as any)?.image ?? null,
        isValid: s.upvotes > s.downvotes,
      });
    }
    return enriched.sort((a, b) => b.upvotes - a.upvotes);
  },
});
