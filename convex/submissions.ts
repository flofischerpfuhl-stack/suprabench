import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";

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

export const submit = mutation({
  args: {
    benchId: v.optional(v.id("benches")),
    newBench: v.optional(
      v.object({
        name: v.string(),
        description: v.string(),
        url: v.string(),
        scaleMin: v.number(),
        scaleMax: v.number(),
        tags: v.array(v.string()),
      })
    ),
    modelId: v.optional(v.id("models")),
    newModel: v.optional(
      v.object({
        name: v.string(),
        provider: v.string(),
        familyTag: v.optional(v.string()),
        tags: v.array(v.string()),
      })
    ),
    rawScore: v.number(),
    sourceUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Rate limiting: max 5 submissions in last 24h — uses by_submitter index
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const userRecent = await ctx.db
      .query("modelScores")
      .withIndex("by_submitter", (q) => q.eq("submittedBy", userId))
      .filter((q) => q.gte(q.field("createdAt"), oneDayAgo))
      .collect();
    if (userRecent.length >= 5) {
      throw new Error("Rate limit: max 5 submissions per day");
    }

    // Validate source URL
    try {
      new URL(args.sourceUrl);
    } catch {
      throw new Error("Invalid source URL");
    }

    // Resolve or create bench
    let benchId = args.benchId;
    let bench;
    if (benchId) {
      bench = await ctx.db.get(benchId);
      if (!bench) throw new Error("Benchmark not found");
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
        tags: nb.tags,
        scaleMin: nb.scaleMin,
        scaleMax: nb.scaleMax,
        addedBy: userId,
        createdAt: Date.now(),
      });
      bench = await ctx.db.get(benchId);
    } else {
      throw new Error("Either benchId or newBench must be provided");
    }

    // Resolve or create model
    let modelId = args.modelId;
    if (modelId) {
      const model = await ctx.db.get(modelId);
      if (!model) throw new Error("Model not found");
    } else if (args.newModel) {
      const nm = args.newModel;
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
        tags: nm.tags,
        addedBy: userId,
        createdAt: Date.now(),
      });

      // Initialize ranking entry for new model
      await ctx.db.insert("modelRankings", {
        modelId,
        name: nm.name,
        provider: nm.provider,
        slug,
        familyTag: nm.familyTag,
        tags: nm.tags,
        supraScore: 0,
        benchCount: 0,
        updatedAt: Date.now(),
      });
    } else {
      throw new Error("Either modelId or newModel must be provided");
    }

    // Score range validation
    if (bench) {
      if (args.rawScore < bench.scaleMin || args.rawScore > bench.scaleMax) {
        throw new Error(
          `Score must be between ${bench.scaleMin} and ${bench.scaleMax}`
        );
      }
    }

    // Normalize score
    const scaleMin = bench!.scaleMin;
    const scaleMax = bench!.scaleMax;
    const normalizedScore =
      scaleMax === scaleMin
        ? 0
        : ((args.rawScore - scaleMin) / (scaleMax - scaleMin)) * 100;

    const scoreId = await ctx.db.insert("modelScores", {
      modelId: modelId!,
      benchId: benchId!,
      rawScore: args.rawScore,
      normalizedScore: Math.round(normalizedScore * 100) / 100,
      sourceUrl: args.sourceUrl,
      submittedBy: userId,
      createdAt: Date.now(),
      upvotes: 0,
      downvotes: 0,
    });

    // Trigger ranking recompute for affected model
    await ctx.scheduler.runAfter(0, internal.rankings.recomputeModel, {
      modelId: modelId!,
    });

    return scoreId;
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
