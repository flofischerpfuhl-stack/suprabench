import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { enforceDailyActionLimit } from "./abuse";

const VOTE_LIMIT_PER_DAY = 500;

export const getMyVote = query({
  args: { targetId: v.string() },
  handler: async (ctx, { targetId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const vote = await ctx.db
      .query("votes")
      .withIndex("by_user_target", (q) =>
        q.eq("userId", userId).eq("targetId", targetId)
      )
      .first();
    return vote ? vote.value : null;
  },
});

export const cast = mutation({
  args: {
    targetId: v.string(),
    value: v.union(v.literal(1), v.literal(-1)),
  },
  handler: async (ctx, { targetId, value }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await enforceDailyActionLimit(ctx, userId, "score-vote", VOTE_LIMIT_PER_DAY);

    // Find the target modelScore
    const score = await ctx.db.get(targetId as any);
    if (
      !score ||
      typeof (score as any).upvotes !== "number" ||
      typeof (score as any).downvotes !== "number" ||
      !(score as any).modelId ||
      !(score as any).benchId
    ) {
      throw new Error("Submission not found");
    }

    // Find existing vote
    const existingVote = await ctx.db
      .query("votes")
      .withIndex("by_user_target", (q) =>
        q.eq("userId", userId).eq("targetId", targetId)
      )
      .first();

    if (existingVote) {
      if (existingVote.value === value) {
        // Toggle off: remove vote
        await ctx.db.delete(existingVote._id);
        if (value === 1) {
          await ctx.db.patch(targetId as any, {
            upvotes: Math.max(0, (score as any).upvotes - 1),
          });
        } else {
          await ctx.db.patch(targetId as any, {
            downvotes: Math.max(0, (score as any).downvotes - 1),
          });
        }
      } else {
        // Switch vote
        await ctx.db.patch(existingVote._id, { value });
        if (value === 1) {
          await ctx.db.patch(targetId as any, {
            upvotes: (score as any).upvotes + 1,
            downvotes: Math.max(0, (score as any).downvotes - 1),
          });
        } else {
          await ctx.db.patch(targetId as any, {
            upvotes: Math.max(0, (score as any).upvotes - 1),
            downvotes: (score as any).downvotes + 1,
          });
        }
      }
    } else {
      // New vote
      await ctx.db.insert("votes", {
        targetId,
        targetType: "modelScore",
        userId,
        value,
      });
      if (value === 1) {
        await ctx.db.patch(targetId as any, {
          upvotes: (score as any).upvotes + 1,
        });
      } else {
        await ctx.db.patch(targetId as any, {
          downvotes: (score as any).downvotes + 1,
        });
      }
    }

    // Trigger ranking recompute for the affected model
    const modelId = (score as any).modelId;
    if (modelId) {
      await ctx.scheduler.runAfter(0, internal.rankings.recomputeModel, {
        modelId,
      });
    }

    // The vote may have flipped this submission's validity (upvotes vs
    // downvotes), which changes the bench's frontier mean / model count.
    // Refresh the bench aggregate cache.
    const benchId = (score as any).benchId;
    if (benchId) {
      await ctx.scheduler.runAfter(0, internal.cache.recomputeBenchAggregates, {
        benchId,
      });
    }
  },
});
