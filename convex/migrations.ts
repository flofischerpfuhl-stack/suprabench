// ════════════════════════════════════════════════════════════
// One-off backfill mutations for cache fields introduced in the
// performance-pass. All optional fields can stay undefined and
// queries fall back to live compute, but you really want to run
// these once after deploy to actually realize the speed-up.
//
// Usage (production):
//   npx convex run --prod migrations:backfillAll
//
// Each step is idempotent — safe to re-run.
// ════════════════════════════════════════════════════════════

import { internalMutation } from "./_generated/server";
import {
  recomputeBenchAggregatesInline,
  syncModelRankingHiddenInline,
  applyTagDeltaInline,
} from "./cache";

// 1. Mirror models.hidden → modelRankings.hidden for every existing row.
export const backfillModelRankingHidden = internalMutation({
  args: {},
  handler: async (ctx) => {
    const models = await ctx.db.query("models").collect();
    let patched = 0;
    for (const m of models) {
      const ranking = await ctx.db
        .query("modelRankings")
        .withIndex("by_model", (q) => q.eq("modelId", m._id))
        .first();
      if (!ranking) continue;
      const desired = m.hidden ?? false;
      if ((ranking.hidden ?? false) !== desired) {
        await ctx.db.patch(ranking._id, { hidden: desired });
        patched++;
      }
    }
    return { models: models.length, patched };
  },
});

// 2. Recompute every bench's aggregate cache from scratch.
export const backfillBenchAggregates = internalMutation({
  args: {},
  handler: async (ctx) => {
    const benches = await ctx.db.query("benches").collect();
    for (const b of benches) {
      await recomputeBenchAggregatesInline(ctx, b._id);
    }
    return { benches: benches.length };
  },
});

// 3. Denormalize submitter name + image into modelScores rows.
export const backfillSubmitterIdentity = internalMutation({
  args: {},
  handler: async (ctx) => {
    const scores = await ctx.db.query("modelScores").collect();
    let patched = 0;
    const userCache = new Map<string, { name?: string; image?: string }>();
    for (const s of scores) {
      if (s.submitterName !== undefined && s.submitterImage !== undefined) continue;
      const key = s.submittedBy as unknown as string;
      let info = userCache.get(key);
      if (!info) {
        const u = await ctx.db.get(s.submittedBy);
        info = {
          name: (u as any)?.name ?? "Unknown",
          image: (u as any)?.image ?? undefined,
        };
        userCache.set(key, info);
      }
      await ctx.db.patch(s._id, {
        submitterName: info.name ?? "Unknown",
        submitterImage: info.image,
      });
      patched++;
    }
    return { scores: scores.length, patched };
  },
});

// 4. Rebuild tagCounts table from scratch by walking models + benches.
export const backfillTagCounts = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Wipe existing first — the "from scratch" rebuild is the simplest
    // way to guarantee correctness during a one-off migration.
    const existing = await ctx.db.query("tagCounts").collect();
    for (const e of existing) await ctx.db.delete(e._id);

    const benches = await ctx.db.query("benches").collect();
    for (const b of benches) {
      if (b.hidden) continue;
      await applyTagDeltaInline(ctx, "bench", [], b.tags ?? []);
    }
    const models = await ctx.db.query("models").collect();
    for (const m of models) {
      if (m.hidden) continue;
      await applyTagDeltaInline(ctx, "model", [], m.tags ?? []);
    }
    return { benches: benches.length, models: models.length };
  },
});

// All-in-one runner. Inlines the four backfills into a single
// transaction. Convex mutations are bounded to ~4s wall-clock and
// limited mutation-result sizes; if any one of these starts timing
// out at scale, run the four sub-mutations individually instead.
export const backfillAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    // 1. modelRankings.hidden
    const models = await ctx.db.query("models").collect();
    let hiddenPatched = 0;
    for (const m of models) {
      const ranking = await ctx.db
        .query("modelRankings")
        .withIndex("by_model", (q) => q.eq("modelId", m._id))
        .first();
      if (!ranking) continue;
      const desired = m.hidden ?? false;
      if ((ranking.hidden ?? false) !== desired) {
        await ctx.db.patch(ranking._id, { hidden: desired });
        hiddenPatched++;
      }
    }

    // 2. bench aggregates
    const benches = await ctx.db.query("benches").collect();
    for (const b of benches) {
      await recomputeBenchAggregatesInline(ctx, b._id);
    }

    // 3. submitter identity
    const scores = await ctx.db.query("modelScores").collect();
    let submitterPatched = 0;
    const userCache = new Map<string, { name?: string; image?: string }>();
    for (const s of scores) {
      if (s.submitterName !== undefined && s.submitterImage !== undefined) continue;
      const key = s.submittedBy as unknown as string;
      let info = userCache.get(key);
      if (!info) {
        const u = await ctx.db.get(s.submittedBy);
        info = {
          name: (u as any)?.name ?? "Unknown",
          image: (u as any)?.image ?? undefined,
        };
        userCache.set(key, info);
      }
      await ctx.db.patch(s._id, {
        submitterName: info.name ?? "Unknown",
        submitterImage: info.image,
      });
      submitterPatched++;
    }

    // 4. tagCounts (rebuild from scratch)
    const existingTagCounts = await ctx.db.query("tagCounts").collect();
    for (const e of existingTagCounts) await ctx.db.delete(e._id);
    for (const b of benches) {
      if (b.hidden) continue;
      await applyTagDeltaInline(ctx, "bench", [], b.tags ?? []);
    }
    for (const m of models) {
      if (m.hidden) continue;
      await applyTagDeltaInline(ctx, "model", [], m.tags ?? []);
    }

    return {
      modelRankingHidden: { models: models.length, patched: hiddenPatched },
      benchAggregates: { benches: benches.length },
      submitterIdentity: { scores: scores.length, patched: submitterPatched },
      tagCounts: { benches: benches.length, models: models.length },
    };
  },
});
