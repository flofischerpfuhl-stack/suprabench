import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { applyTagDeltaInline } from "./cache";

const ENTITY = v.union(v.literal("model"), v.literal("bench"));

function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase();
}

// Recompute the canonical tag set for an entity from tagVotes (sum > 0).
// Patches the underlying record + denormalised modelRankings cache.
export async function recomputeEffectiveTags(
  ctx: any,
  entityType: "model" | "bench",
  entityId: string
): Promise<string[]> {
  const votes = await ctx.db
    .query("tagVotes")
    .withIndex("by_entity", (q: any) =>
      q.eq("entityType", entityType).eq("entityId", entityId)
    )
    .collect();

  const totals: Record<string, number> = {};
  for (const v of votes) {
    totals[v.tag] = (totals[v.tag] ?? 0) + v.value;
  }
  const effective = Object.entries(totals)
    .filter(([, score]) => score > 0)
    .map(([tag]) => tag)
    .sort();

  if (entityType === "model") {
    const id = entityId as Id<"models">;
    const model = await ctx.db.get(id);
    if (model) {
      const oldTags = model.tags ?? [];
      await ctx.db.patch(id, { tags: effective });
      const ranking = await ctx.db
        .query("modelRankings")
        .withIndex("by_model", (q: any) => q.eq("modelId", id))
        .first();
      if (ranking) await ctx.db.patch(ranking._id, { tags: effective });
      // Maintain global tagCounts cache incrementally. Hidden entities
      // are excluded from public counts to match tags.listAll semantics.
      if (!(model.hidden ?? false)) {
        await applyTagDeltaInline(ctx, "model", oldTags, effective);
      }
    }
  } else {
    const id = entityId as Id<"benches">;
    const bench = await ctx.db.get(id);
    if (bench) {
      const oldTags = bench.tags ?? [];
      await ctx.db.patch(id, { tags: effective });
      if (!(bench.hidden ?? false)) {
        await applyTagDeltaInline(ctx, "bench", oldTags, effective);
      }
    }
  }
  return effective;
}

// All tags + scores + my-vote for an entity.
export const listForEntity = query({
  args: { entityType: ENTITY, entityId: v.string() },
  handler: async (ctx, { entityType, entityId }) => {
    const userId = await getAuthUserId(ctx);
    const votes = await ctx.db
      .query("tagVotes")
      .withIndex("by_entity", (q) =>
        q.eq("entityType", entityType).eq("entityId", entityId)
      )
      .collect();

    const totals: Record<string, { score: number; voters: number; myVote: 0 | 1 | -1 }> = {};
    for (const v of votes) {
      const t = totals[v.tag] ?? { score: 0, voters: 0, myVote: 0 };
      t.score += v.value;
      t.voters += 1;
      if (userId && v.userId === userId) {
        t.myVote = v.value as 1 | -1;
      }
      totals[v.tag] = t;
    }

    return Object.entries(totals)
      .map(([tag, t]) => ({ tag, ...t }))
      .sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));
  },
});

// Cast or toggle a tag vote. Switching from -1 to +1 (or vice versa)
// just patches; voting same direction toggles the vote off.
export const cast = mutation({
  args: {
    entityType: ENTITY,
    entityId: v.string(),
    tag: v.string(),
    value: v.union(v.literal(1), v.literal(-1)),
  },
  handler: async (ctx, { entityType, entityId, tag, value }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const t = normalizeTag(tag);
    if (!t) throw new Error("Empty tag");
    if (t.length > 30) throw new Error("Tag too long (max 30 chars)");

    // Validate the entity actually exists
    if (entityType === "model") {
      const m = await ctx.db.get(entityId as Id<"models">);
      if (!m) throw new Error("Model not found");
    } else {
      const b = await ctx.db.get(entityId as Id<"benches">);
      if (!b) throw new Error("Benchmark not found");
    }

    const existing = await ctx.db
      .query("tagVotes")
      .withIndex("by_user_entity_tag", (q) =>
        q
          .eq("userId", userId)
          .eq("entityType", entityType)
          .eq("entityId", entityId)
          .eq("tag", t)
      )
      .first();

    if (existing) {
      if (existing.value === value) {
        await ctx.db.delete(existing._id);
      } else {
        await ctx.db.patch(existing._id, { value });
      }
    } else {
      await ctx.db.insert("tagVotes", {
        entityType,
        entityId,
        tag: t,
        userId,
        value,
      });
    }

    await recomputeEffectiveTags(ctx, entityType, entityId);
  },
});

// Internal helper used by other mutations (submission, model.create, …) to
// seed the creator's +1 vote on each initial tag.
export const seedCreatorTags = internalMutation({
  args: {
    entityType: ENTITY,
    entityId: v.string(),
    tags: v.array(v.string()),
    userId: v.id("users"),
  },
  handler: async (ctx, { entityType, entityId, tags, userId }) => {
    const seen = new Set<string>();
    for (const raw of tags) {
      const t = normalizeTag(raw);
      if (!t || t.length > 30 || seen.has(t)) continue;
      seen.add(t);
      const dup = await ctx.db
        .query("tagVotes")
        .withIndex("by_user_entity_tag", (q) =>
          q
            .eq("userId", userId)
            .eq("entityType", entityType)
            .eq("entityId", entityId)
            .eq("tag", t)
        )
        .first();
      if (dup) continue;
      await ctx.db.insert("tagVotes", {
        entityType,
        entityId,
        tag: t,
        userId,
        value: 1,
      });
    }
    await recomputeEffectiveTags(ctx, entityType, entityId);
  },
});
