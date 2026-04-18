import { query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    if (!user) return null;
    return {
      _id: user._id,
      name: (user as any).name ?? null,
      email: (user as any).email ?? null,
      image: (user as any).image ?? null,
    };
  },
});

// Aggregate activity for the profile page: submissions, tag votes,
// quality ratings, model/bench creations.
export const myActivity = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const scores = await ctx.db
      .query("modelScores")
      .withIndex("by_submitter", (q) => q.eq("submittedBy", userId))
      .order("desc")
      .take(200);

    const submissions = [];
    for (const s of scores) {
      const m = await ctx.db.get(s.modelId);
      const b = await ctx.db.get(s.benchId);
      submissions.push({
        _id: s._id,
        modelName: (m as any)?.name ?? "?",
        modelSlug: (m as any)?.slug ?? "",
        modelHidden: (m as any)?.hidden ?? false,
        benchName: (b as any)?.name ?? "?",
        benchSlug: (b as any)?.slug ?? "",
        benchHidden: (b as any)?.hidden ?? false,
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

    const myBenches = await ctx.db
      .query("benches")
      .withIndex("by_added_by", (q) => q.eq("addedBy", userId))
      .collect();
    const myModels = await ctx.db
      .query("models")
      .withIndex("by_added_by", (q) => q.eq("addedBy", userId))
      .collect();

    // Use the dedicated by_user index instead of a full-table .filter scan.
    const tagVotes = await ctx.db
      .query("tagVotes")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const enrichedTagVotes = [];
    for (const tv of tagVotes) {
      let entityName = "?";
      let entitySlug = "";
      if (tv.entityType === "model") {
        const m = await ctx.db.get(tv.entityId as any);
        if (m) { entityName = (m as any).name; entitySlug = (m as any).slug; }
      } else {
        const b = await ctx.db.get(tv.entityId as any);
        if (b) { entityName = (b as any).name; entitySlug = (b as any).slug; }
      }
      enrichedTagVotes.push({
        entityType: tv.entityType,
        entityId: tv.entityId,
        entityName,
        entitySlug,
        tag: tv.tag,
        value: tv.value,
      });
    }

    const ratings = await ctx.db
      .query("benchQualityRatings")
      .filter((q) => q.eq(q.field("userId"), userId))
      .collect();
    const enrichedRatings = [];
    for (const r of ratings) {
      const b = await ctx.db.get(r.benchId);
      enrichedRatings.push({
        benchId: r.benchId,
        benchName: (b as any)?.name ?? "?",
        benchSlug: (b as any)?.slug ?? "",
        relevance: r.relevance,
        contamination: r.contamination,
        discriminability: r.discriminability,
        reproducibility: r.reproducibility,
        difficulty: (r as any).difficulty ?? null,
      });
    }

    return {
      submissions,
      createdBenches: myBenches.map((b) => ({
        _id: b._id, name: b.name, slug: b.slug, hidden: b.hidden ?? false,
      })),
      createdModels: myModels.map((m) => ({
        _id: m._id, name: m.name, slug: m.slug, hidden: m.hidden ?? false,
      })),
      tagVotes: enrichedTagVotes,
      ratings: enrichedRatings,
    };
  },
});
