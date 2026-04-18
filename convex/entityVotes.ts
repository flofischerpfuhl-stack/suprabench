import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";

const ENTITY = v.union(v.literal("model"), v.literal("bench"));

// Hide rule (engagement-aware):
//   downs ≥ max(MIN_DOWNS_FLOOR, ceil(RATIO * (ups + downs)))   AND   downs > ups
//
// Why this and not a flat -3 threshold?
//   Flat thresholds let a tiny clique of malicious accounts kick legitimate
//   benches/models with very little engagement. Scaling with total votes
//   means: at low engagement we require the absolute floor (5), but the
//   more the bench gets engaged with, the more downvotes are needed to
//   override the upvotes. Established benches are hard to remove; spam is
//   easy to remove.
export const MIN_DOWNS_FLOOR = 5;
export const DOWN_RATIO = 0.6;

function shouldHide(ups: number, downs: number): boolean {
  const total = ups + downs;
  const required = Math.max(MIN_DOWNS_FLOOR, Math.ceil(DOWN_RATIO * total));
  return downs >= required && downs > ups;
}

function downsRequiredToHide(ups: number, downs: number): number {
  // How many more downvotes are needed to flip the hide flag right now?
  // Useful for the UI (“X more downvotes would hide this”).
  let d = downs;
  while (!shouldHide(ups, d) && d < ups + downs + 200) d++;
  return Math.max(0, d - downs);
}

async function entityNetScore(
  ctx: any,
  entityType: "model" | "bench",
  entityId: string
): Promise<{ score: number; ups: number; downs: number }> {
  const votes = await ctx.db
    .query("entityVotes")
    .withIndex("by_entity", (q: any) =>
      q.eq("entityType", entityType).eq("entityId", entityId)
    )
    .collect();
  let ups = 0;
  let downs = 0;
  for (const v of votes) {
    if (v.value === 1) ups++;
    else downs++;
  }
  return { score: ups - downs, ups, downs };
}

async function applyHiddenState(
  ctx: any,
  entityType: "model" | "bench",
  entityId: string
) {
  const { ups, downs } = await entityNetScore(ctx, entityType, entityId);
  const hidden = shouldHide(ups, downs);
  if (entityType === "model") {
    const id = entityId as Id<"models">;
    const m = await ctx.db.get(id);
    if (m && (m.hidden ?? false) !== hidden) {
      await ctx.db.patch(id, { hidden });
    }
  } else {
    const id = entityId as Id<"benches">;
    const b = await ctx.db.get(id);
    if (b && (b.hidden ?? false) !== hidden) {
      await ctx.db.patch(id, { hidden });
    }
  }
}

// Seed +1 vote when an entity is created — used by submit/create flows.
export async function seedCreatorEntityVote(
  ctx: any,
  entityType: "model" | "bench",
  entityId: string,
  userId: Id<"users">
) {
  await ctx.db.insert("entityVotes", {
    entityType,
    entityId,
    userId,
    value: 1,
  });
}

// Returns score + my vote for an entity.
export const getForEntity = query({
  args: { entityType: ENTITY, entityId: v.string() },
  handler: async (ctx, { entityType, entityId }) => {
    const userId = await getAuthUserId(ctx);
    const { score, ups, downs } = await entityNetScore(ctx, entityType, entityId);
    let myVote: 1 | -1 | 0 = 0;
    if (userId) {
      const mine = await ctx.db
        .query("entityVotes")
        .withIndex("by_user_entity", (q) =>
          q.eq("userId", userId).eq("entityType", entityType).eq("entityId", entityId)
        )
        .first();
      if (mine) myVote = mine.value as 1 | -1;
    }
    return {
      score,
      ups,
      downs,
      myVote,
      downsToHide: downsRequiredToHide(ups, downs),
      minDownsFloor: MIN_DOWNS_FLOOR,
      downRatio: DOWN_RATIO,
    };
  },
});

export const cast = mutation({
  args: {
    entityType: ENTITY,
    entityId: v.string(),
    value: v.union(v.literal(1), v.literal(-1)),
  },
  handler: async (ctx, { entityType, entityId, value }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    if (entityType === "model") {
      const m = await ctx.db.get(entityId as Id<"models">);
      if (!m) throw new Error("Model not found");
    } else {
      const b = await ctx.db.get(entityId as Id<"benches">);
      if (!b) throw new Error("Benchmark not found");
    }

    const existing = await ctx.db
      .query("entityVotes")
      .withIndex("by_user_entity", (q) =>
        q.eq("userId", userId).eq("entityType", entityType).eq("entityId", entityId)
      )
      .first();

    if (existing) {
      if (existing.value === value) {
        await ctx.db.delete(existing._id);
      } else {
        await ctx.db.patch(existing._id, { value });
      }
    } else {
      await ctx.db.insert("entityVotes", { entityType, entityId, userId, value });
    }

    await applyHiddenState(ctx, entityType, entityId);
  },
});

// Helper used by create-mutations: rejects if the same user already
// owns a HIDDEN entity of the same type with the same normalised name.
// Prevents the spam pattern of re-submitting after community removal.
export async function assertNotResurrectingOwnHidden(
  ctx: any,
  entityType: "model" | "bench",
  name: string,
  userId: Id<"users">
) {
  const norm = name.trim().toLowerCase();
  if (entityType === "model") {
    const rows = await ctx.db
      .query("models")
      .withIndex("by_added_by", (q: any) => q.eq("addedBy", userId))
      .collect();
    for (const r of rows) {
      if (r.hidden && r.name.trim().toLowerCase() === norm) {
        throw new Error(
          "You already submitted a model with this name and it was removed by the community. " +
            "Please pick a different name."
        );
      }
    }
  } else {
    const rows = await ctx.db
      .query("benches")
      .withIndex("by_added_by", (q: any) => q.eq("addedBy", userId))
      .collect();
    for (const r of rows) {
      if (r.hidden && r.name.trim().toLowerCase() === norm) {
        throw new Error(
          "You already submitted a benchmark with this name and it was removed by the community. " +
            "Please pick a different name."
        );
      }
    }
  }
}
