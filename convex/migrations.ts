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
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  recomputeBenchAggregatesInline,
  syncModelRankingHiddenInline,
  applyTagDeltaInline,
} from "./cache";
import { isOfficialUrl } from "./urls";
import { canonicalFamilyTag } from "./modelFamilies";

// Split product tiers/releases that were previously stored under a shared
// umbrella family. Idempotent and intentionally limited to names for which the
// canonical tier is explicit in the model name.
//
// Run once, then rebuild rankings from D1:
//   npx convex run --prod migrations:splitTieredModelFamilies
//   npx convex run --prod rankings:recomputeFromD1
export const splitTieredModelFamilies = internalMutation({
  args: {},
  handler: async (ctx) => {
    const models = await ctx.db.query("models").collect();
    const changed: Array<{ name: string; from: string | null; to: string }> = [];

    for (const model of models) {
      const desired = canonicalFamilyTag(model.name, model.familyTag);
      if (!desired || desired === model.familyTag) continue;
      await ctx.db.patch(model._id, { familyTag: desired });
      changed.push({ name: model.name, from: model.familyTag ?? null, to: desired });
    }

    return { scanned: models.length, patched: changed.length, changed };
  },
});

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

// 5. Re-evaluate benches.isOfficial against the current whitelist.
//
// `isOfficial` is decided once at insert-time from the bench's URL via
// isOfficialUrl(). When we add new domains to the whitelist (e.g. after
// "Humanity's Last Exam" highlighted that agi.safe.ai was missing),
// already-stored benches still hold the stale boolean. This migration
// walks every bench and patches the field if and only if the live
// computation disagrees with what's stored.
//
// Idempotent — re-running after the whitelist has stabilised is a no-op.
//
// Usage:
//   npx convex run --prod migrations:recomputeBenchIsOfficial
export const recomputeBenchIsOfficial = internalMutation({
  args: {},
  handler: async (ctx) => {
    const benches = await ctx.db.query("benches").collect();
    let promoted = 0; // false → true (whitelist grew)
    let demoted = 0;  // true  → false (domain removed)
    const promotedSlugs: string[] = [];
    for (const b of benches) {
      const desired = isOfficialUrl(b.url);
      if (desired === b.isOfficial) continue;
      await ctx.db.patch(b._id, { isOfficial: desired });
      if (desired) {
        promoted++;
        promotedSlugs.push(b.slug);
      } else {
        demoted++;
      }
    }
    return {
      benches: benches.length,
      promoted,
      demoted,
      promotedSlugs,
    };
  },
});

// 6. Build the familyRankings cache from scratch.
//
// Run after the family-rankings feature first lands, and any time
// `migrations:backfillAll` would be run. Idempotent.
//
// Usage:
//   npx convex run --prod migrations:backfillFamilyRankings
export const backfillFamilyRankings = internalMutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.runMutation(internal.familyRankings.recomputeAll, {});
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

    // 5. familyRankings — delegate to the feature module so the logic
    //    stays in one place.
    const familyStats = await ctx.runMutation(
      internal.familyRankings.recomputeAll,
      {}
    );

    return {
      modelRankingHidden: { models: models.length, patched: hiddenPatched },
      benchAggregates: { benches: benches.length },
      submitterIdentity: { scores: scores.length, patched: submitterPatched },
      tagCounts: { benches: benches.length, models: models.length },
      familyRankings: familyStats,
    };
  },
});

// One-off: rename tier keys in the live `apiWaitlist` table after the
// tier taxonomy changed from hobby/pro/scale/enterprise to the new
// starter/pro/enterprise/enterprise_plus scheme.
//
//   hobby      → starter
//   pro        → pro              (unchanged, skipped)
//   scale      → enterprise
//   enterprise → enterprise_plus
//
// Order matters: rename the top tier FIRST, otherwise the scale →
// enterprise step would clobber unrelated enterprise rows that
// haven't been renamed yet.
//
// Idempotent: re-running on already-renamed rows is a no-op because
// the source keys no longer appear.
//
// Run once after deploying the new code:
//   npx convex run --prod migrations:renameWaitlistTiers
export const renameWaitlistTiers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("apiWaitlist").collect();
    let enterprisePlus = 0, enterprise = 0, starter = 0;
    for (const r of rows) {
      if (r.tier === "enterprise") {
        await ctx.db.patch(r._id, { tier: "enterprise_plus" });
        enterprisePlus++;
      }
    }
    for (const r of rows) {
      if (r.tier === "scale") {
        await ctx.db.patch(r._id, { tier: "enterprise" });
        enterprise++;
      }
    }
    for (const r of rows) {
      if (r.tier === "hobby") {
        await ctx.db.patch(r._id, { tier: "starter" });
        starter++;
      }
    }
    return {
      total: rows.length,
      renamed: { enterprisePlus, enterprise, starter },
    };
  },
});

// ── Rename a benchmark (name, slug, description) ────────────
// Curation batches refuse to touch an existing benchmark whose name or
// slug differs from the manifest, so a rename has to be explicit. Name
// and slug are not denormalised anywhere (scores and rankings reference
// the bench by id), so this is a single patch. Refuses to collide with
// another benchmark's slug.
//
//   npx convex run --prod migrations:renameBench \
//     '{"slug":"old-slug","newName":"New Name","newDescription":"…"}'
export const renameBench = internalMutation({
  args: {
    slug: v.string(),
    newName: v.string(),
    newDescription: v.optional(v.string()),
  },
  handler: async (ctx, { slug, newName, newDescription }) => {
    const bench = await ctx.db
      .query("benches")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!bench) throw new Error(`Benchmark not found: ${slug}`);
    const name = newName.trim();
    if (!name || name.length > 120) throw new Error("Invalid benchmark name");
    const newSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    if (newSlug !== slug) {
      const clash = await ctx.db
        .query("benches")
        .withIndex("by_slug", (q) => q.eq("slug", newSlug))
        .first();
      if (clash) throw new Error(`Slug already in use: ${newSlug}`);
    }
    const patch: Record<string, string> = { name, slug: newSlug };
    if (newDescription !== undefined) {
      const description = newDescription.trim();
      if (!description || description.length > 1000) {
        throw new Error("Invalid benchmark description");
      }
      patch.description = description;
    }
    await ctx.db.patch(bench._id, patch);
    return { id: bench._id, from: { name: bench.name, slug }, to: patch };
  },
});

// ── Identity cleanup: delete duplicate rows, move rows, drop empty configs ──
// For rows that ended up under the wrong configuration of a model (unlabelled
// copies of a labelled row, alias configurations, a vendor-reported row next
// to the publisher's row). Explicit plan, dry run by default, guards that make
// information loss impossible:
//
//   deleteRow   the model (same familyTag + provider) must still have another
//               row on that benchmark afterwards
//   moveRow     target configuration belongs to the same model and has no row
//               on that benchmark yet
//   deleteEmptyConfiguration   configuration has no score rows left
//
// Every op carries `expect` (configuration name, bench slug, raw score) so a
// stale plan fails instead of hitting the wrong row. Returns an archive of
// everything removed or changed — commit it under docs/curation/cleanup/.
//
//   npx convex run --prod migrations:applyIdentityCleanup '{"dryRun":true,"ops":[…]}'
const CLEANUP_OP = v.object({
  op: v.union(v.literal("deleteRow"), v.literal("moveRow"), v.literal("deleteEmptyConfiguration")),
  scoreId: v.optional(v.id("modelScores")),
  configuration: v.string(),
  benchSlug: v.optional(v.string()),
  rawScore: v.optional(v.number()),
  toConfiguration: v.optional(v.string()),
  reason: v.string(),
});

export const applyIdentityCleanup = internalMutation({
  args: { dryRun: v.boolean(), ops: v.array(CLEANUP_OP) },
  handler: async (ctx, { dryRun, ops }) => {
    if (ops.length > 100) throw new Error("Max 100 operations per call");
    const models = await ctx.db.query("models").collect();
    const benches = await ctx.db.query("benches").collect();
    const modelByName = new Map(models.map((m) => [m.name, m]));
    const benchBySlug = new Map(benches.map((b) => [b.slug, b]));
    const sameModel = (a: any, b: any) =>
      canonicalFamilyTag(a.name, a.familyTag) === canonicalFamilyTag(b.name, b.familyTag) &&
      a.provider === b.provider;
    const archive: any[] = [];
    const touchedBenches = new Set<string>();
    const changedScoreIds: any[] = [];
    const deletedScoreIds: string[] = [];
    const gone = new Set<string>(); // score ids deleted earlier in this plan
    const moved = new Map<string, string>(); // score id → new model id

    for (const [index, op] of ops.entries()) {
      const label = `op[${index}] ${op.op} ${op.configuration}`;
      if (op.reason.trim().length < 15) throw new Error(`${label}: reason required`);
      const config: any = modelByName.get(op.configuration);
      if (!config) throw new Error(`${label}: configuration not found`);

      if (op.op === "deleteEmptyConfiguration") {
        const rows = await ctx.db
          .query("modelScores")
          .withIndex("by_model", (q) => q.eq("modelId", config._id))
          .collect();
        const left = rows.filter((r) => !gone.has(r._id as string) && (moved.get(r._id as string) ?? config._id) === config._id);
        if (left.length > 0) throw new Error(`${label}: still has ${left.length} score rows`);
        archive.push({ op: op.op, reason: op.reason, configuration: { ...config } });
        if (!dryRun) {
          const ranking = await ctx.db
            .query("modelRankings")
            .withIndex("by_model", (q) => q.eq("modelId", config._id))
            .first();
          if (ranking) await ctx.db.delete(ranking._id);
          for (const table of ["entityVotes", "tagVotes"] as const) {
            const votes = await ctx.db
              .query(table)
              .withIndex("by_entity", (q: any) => q.eq("entityType", "model").eq("entityId", config._id as string))
              .collect();
            for (const vote of votes) await ctx.db.delete(vote._id);
          }
          await ctx.db.delete(config._id);
        }
        continue;
      }

      if (!op.scoreId || !op.benchSlug || op.rawScore === undefined) {
        throw new Error(`${label}: scoreId, benchSlug and rawScore are required`);
      }
      const bench: any = benchBySlug.get(op.benchSlug);
      if (!bench) throw new Error(`${label}: benchmark not found`);
      const row: any = await ctx.db.get(op.scoreId);
      if (!row || gone.has(op.scoreId as string)) throw new Error(`${label}: score row not found`);
      if (row.modelId !== config._id || row.benchId !== bench._id || row.rawScore !== op.rawScore) {
        throw new Error(`${label}: row does not match the expected configuration, benchmark and value`);
      }
      const benchRows = await ctx.db
        .query("modelScores")
        .withIndex("by_bench", (q) => q.eq("benchId", bench._id))
        .collect();
      const live = benchRows.filter((r) => !gone.has(r._id as string));
      const ownerOf = (r: any) => moved.get(r._id as string) ?? (r.modelId as string);
      const modelDoc = (id: string) => models.find((m) => (m._id as string) === id);

      if (op.op === "deleteRow") {
        const survivors = live.filter((r) => r._id !== row._id && sameModel(modelDoc(ownerOf(r)), config));
        if (survivors.length === 0) {
          throw new Error(`${label}: deleting would leave the model without a row on ${op.benchSlug}`);
        }
        archive.push({ op: op.op, reason: op.reason, configuration: config.name, benchSlug: op.benchSlug, row: { ...row }, keptInstead: survivors.map((r) => ({ configuration: modelDoc(ownerOf(r))?.name, rawScore: r.rawScore, sourceUrl: r.sourceUrl })) });
        gone.add(row._id as string);
        if (!dryRun) {
          const votes = await ctx.db.query("votes").withIndex("by_target", (q) => q.eq("targetId", row._id as string)).collect();
          for (const vote of votes) await ctx.db.delete(vote._id);
          await ctx.db.delete(row._id);
          deletedScoreIds.push(row._id as string);
        }
      } else {
        const target: any = op.toConfiguration ? modelByName.get(op.toConfiguration) : undefined;
        if (!target) throw new Error(`${label}: target configuration not found`);
        if (target.hidden) throw new Error(`${label}: target configuration is hidden`);
        if (!sameModel(target, config)) throw new Error(`${label}: target belongs to a different model`);
        if (live.some((r) => ownerOf(r) === (target._id as string))) {
          throw new Error(`${label}: ${target.name} already has a row on ${op.benchSlug}`);
        }
        archive.push({ op: op.op, reason: op.reason, from: config.name, to: target.name, benchSlug: op.benchSlug, row: { ...row } });
        moved.set(row._id as string, target._id as string);
        if (!dryRun) {
          await ctx.db.patch(row._id, { modelId: target._id });
          changedScoreIds.push(row._id);
        }
      }
      touchedBenches.add(bench._id as string);
    }

    if (!dryRun) {
      for (const benchId of touchedBenches) await recomputeBenchAggregatesInline(ctx, benchId as any);
      for (const convexId of deletedScoreIds) {
        await ctx.scheduler.runAfter(0, internal.scoresWorker.deleteScoreFromMirror, { convexId });
      }
      // mirrors moved rows (upsert by convex id) and rebuilds the rankings
      await ctx.scheduler.runAfter(3000, internal.scoresWorker.mirrorScoresAndRebuild, { scoreIds: changedScoreIds });
    }
    return { dryRun, operations: ops.length, deleted: deletedScoreIds.length || [...gone].length, moved: moved.size, archive };
  },
});
