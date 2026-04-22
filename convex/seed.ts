// ════════════════════════════════════════════════════════════
// INITIAL-PREFILL SEED LOADER
//
// Reads a JSON file of benchmark + model + score data (curated by a
// human-supervised AI research pass — see scripts/SEED_PROMPT.md) and
// inserts it into the Convex DB idempotently.
//
// ── Design constraints enforced here ─────────────────────────
//
// 1. EVERY insert must reference a valid `users` row. The schema
//    requires `addedBy: v.id("users")` and `submittedBy: v.id("users")`.
//    We create a single dedicated service user "SupraBench Initial
//    Prefill" and attribute all seed inserts to it. That user has NO
//    authAccount row (can't log in) and is flagged `isServiceUser=true`
//    so the UI / profile queries can hide it from leaderboards.
//
// 2. IDEMPOTENT. Re-running never duplicates:
//    - benches are matched by slug
//    - models are matched by slug
//    - scores are matched by (modelId, benchId, sourceUrl)
//    If a match exists, the row is LEFT UNTOUCHED. To force an update
//    the operator must delete the row manually first. This keeps the
//    seed loader safe to re-run after additions to seed-data.json.
//
// 3. Every submission gets exactly ONE upvote (the same "creator
//    self-upvote" that the regular submitOne mutation emits). No fake
//    additional votes are ever fabricated.
//
// 4. ranks + aggregates + tag caches get fully recomputed at the end so
//    the frontend reflects the new data on next subscription tick.
//
// Usage (production, idempotent):
//   npx convex run --prod seed:loadFromJson --file scripts/seed-data.json
//
// …actually convex run can't read local files directly, so the
// operator instead pipes the JSON:
//   node scripts/run-seed.mjs
// which reads the JSON, chunks it, and calls internal.seed.applyChunk
// one batch at a time. See scripts/run-seed.mjs for the runner.
// ════════════════════════════════════════════════════════════

import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { recomputeEffectiveTags } from "./tagVotes";
import { seedCreatorEntityVote } from "./entityVotes";
import { isOfficialUrl } from "./urls";

const SERVICE_USER_EMAIL = "prefill@suprabench.internal";
const SERVICE_USER_NAME = "SupraBench Initial Prefill";

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// Ensure the service user exists. Returns its id.
// Match is by the magic email so we never create a second one even if
// the record's display name is later edited.
export const ensureServiceUser = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("users")
      .filter((q: any) => q.eq(q.field("email"), SERVICE_USER_EMAIL))
      .first();
    if (existing) return existing._id;
    const id = await ctx.db.insert("users", {
      name: SERVICE_USER_NAME,
      email: SERVICE_USER_EMAIL,
      // image left undefined — UI renders a fallback avatar
      // emailVerificationTime + phone left undefined — auth never touches this row
    } as any);
    return id;
  },
});

// Report what the service user has done so far. Handy for audit:
//   npx convex run --prod seed:summary
export const summary = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.db
      .query("users")
      .filter((q: any) => q.eq(q.field("email"), SERVICE_USER_EMAIL))
      .first();
    if (!user) return { serviceUserExists: false };
    const benches = await ctx.db
      .query("benches")
      .withIndex("by_added_by", (q: any) => q.eq("addedBy", user._id))
      .collect();
    const models = await ctx.db
      .query("models")
      .withIndex("by_added_by", (q: any) => q.eq("addedBy", user._id))
      .collect();
    const scores = await ctx.db
      .query("modelScores")
      .withIndex("by_submitter", (q: any) => q.eq("submittedBy", user._id))
      .collect();
    return {
      serviceUserExists: true,
      serviceUserId: user._id,
      benches: benches.length,
      models: models.length,
      scores: scores.length,
    };
  },
});

// The shape a single "seed entry" must follow. One entry = one bench
// with 0-∞ model scores. Every field is validated here so malformed
// entries fail loudly rather than silently corrupting the DB.
const SEED_SCORE = v.object({
  model: v.object({
    name: v.string(),
    provider: v.string(),
    familyTag: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  }),
  rawScore: v.number(),
  sourceUrl: v.string(),
  accessedAt: v.number(), // ms-since-epoch, NOT a date string
});

const SEED_BENCH = v.object({
  name: v.string(),
  description: v.string(),
  url: v.string(),
  scaleMin: v.number(),
  scaleMax: v.number(),
  tags: v.optional(v.array(v.string())),
  scores: v.array(SEED_SCORE),
});

// Apply one chunk of seed entries. The runner splits a big JSON file
// into chunks so no single mutation exceeds the Convex 1MB arg /
// 16MB transaction limits.
//
// Returns per-entry stats so the runner can print a clean summary.
export const applyChunk = internalMutation({
  args: { entries: v.array(SEED_BENCH) },
  handler: async (ctx, { entries }) => {
    const serviceUserId: Id<"users"> = await ctx.runMutation(
      internal.seed.ensureServiceUser,
      {}
    );

    const stats = {
      benchesCreated: 0,
      benchesReused: 0,
      modelsCreated: 0,
      modelsReused: 0,
      scoresInserted: 0,
      scoresSkipped: 0,
      errors: [] as string[],
    };

    for (const entry of entries) {
      try {
        // ── Resolve / create bench by slug ──
        const benchSlug = generateSlug(entry.name);
        let bench: any = await ctx.db
          .query("benches")
          .withIndex("by_slug", (q: any) => q.eq("slug", benchSlug))
          .first();
        let benchId: Id<"benches">;
        if (bench) {
          benchId = bench._id;
          stats.benchesReused++;
        } else {
          benchId = await ctx.db.insert("benches", {
            name: entry.name,
            slug: benchSlug,
            description: entry.description,
            url: entry.url,
            isOfficial: isOfficialUrl(entry.url),
            tags: [],
            scaleMin: entry.scaleMin,
            scaleMax: entry.scaleMax,
            addedBy: serviceUserId,
            createdAt: Date.now(),
          });
          await seedCreatorEntityVote(
            ctx,
            "bench",
            benchId as unknown as string,
            serviceUserId
          );
          const seen = new Set<string>();
          for (const raw of entry.tags ?? []) {
            const t = raw.trim().toLowerCase();
            if (!t || t.length > 30 || seen.has(t)) continue;
            seen.add(t);
            await ctx.db.insert("tagVotes", {
              entityType: "bench",
              entityId: benchId as unknown as string,
              tag: t,
              userId: serviceUserId,
              value: 1,
            });
          }
          await recomputeEffectiveTags(
            ctx,
            "bench",
            benchId as unknown as string
          );
          bench = await ctx.db.get(benchId);
          stats.benchesCreated++;
        }

        // ── Per-score: resolve/create model, insert score if not already there ──
        for (const s of entry.scores) {
          const modelSlug = generateSlug(s.model.name);
          let model: any = await ctx.db
            .query("models")
            .withIndex("by_slug", (q: any) => q.eq("slug", modelSlug))
            .first();
          let modelId: Id<"models">;
          if (model) {
            modelId = model._id;
            stats.modelsReused++;
          } else {
            modelId = await ctx.db.insert("models", {
              name: s.model.name,
              provider: s.model.provider,
              slug: modelSlug,
              familyTag: s.model.familyTag,
              tags: [],
              addedBy: serviceUserId,
              createdAt: Date.now(),
            });
            await ctx.db.insert("modelRankings", {
              modelId,
              name: s.model.name,
              provider: s.model.provider,
              slug: modelSlug,
              familyTag: s.model.familyTag,
              tags: [],
              supraScore: 0,
              benchCount: 0,
              updatedAt: Date.now(),
              hidden: false,
            });
            await seedCreatorEntityVote(
              ctx,
              "model",
              modelId as unknown as string,
              serviceUserId
            );
            const seen = new Set<string>();
            for (const raw of s.model.tags ?? []) {
              const t = raw.trim().toLowerCase();
              if (!t || t.length > 30 || seen.has(t)) continue;
              seen.add(t);
              await ctx.db.insert("tagVotes", {
                entityType: "model",
                entityId: modelId as unknown as string,
                tag: t,
                userId: serviceUserId,
                value: 1,
              });
            }
            await recomputeEffectiveTags(
              ctx,
              "model",
              modelId as unknown as string
            );
            stats.modelsCreated++;
          }

          // Dedup score by (modelId, benchId, sourceUrl).
          // Two legitimate scores from different source URLs are allowed
          // (e.g. re-published in both arxiv + official lab blog); the
          // canonical URL per (model, bench) should appear only once.
          const existingScores = await ctx.db
            .query("modelScores")
            .withIndex("by_model_bench", (q: any) =>
              q.eq("modelId", modelId).eq("benchId", benchId)
            )
            .collect();
          const dup = existingScores.find(
            (e: any) => e.sourceUrl === s.sourceUrl
          );
          if (dup) {
            stats.scoresSkipped++;
            continue;
          }

          if (!Number.isFinite(s.rawScore)) {
            stats.errors.push(
              `${entry.name} / ${s.model.name}: rawScore not finite`
            );
            continue;
          }
          if (
            s.rawScore < bench.scaleMin ||
            s.rawScore > bench.scaleMax
          ) {
            stats.errors.push(
              `${entry.name} / ${s.model.name}: rawScore ${s.rawScore} outside [${bench.scaleMin}, ${bench.scaleMax}]`
            );
            continue;
          }
          try {
            new URL(s.sourceUrl);
          } catch {
            stats.errors.push(
              `${entry.name} / ${s.model.name}: invalid sourceUrl`
            );
            continue;
          }
          if (!Number.isFinite(s.accessedAt) || s.accessedAt <= 0) {
            stats.errors.push(
              `${entry.name} / ${s.model.name}: invalid accessedAt`
            );
            continue;
          }

          const normalized =
            bench.scaleMax === bench.scaleMin
              ? 0
              : ((s.rawScore - bench.scaleMin) /
                  (bench.scaleMax - bench.scaleMin)) *
                100;

          const scoreId = await ctx.db.insert("modelScores", {
            modelId,
            benchId,
            rawScore: s.rawScore,
            normalizedScore: Math.round(normalized * 100) / 100,
            sourceUrl: s.sourceUrl,
            accessedAt: s.accessedAt,
            submittedBy: serviceUserId,
            createdAt: Date.now(),
            // Seed scores get exactly one upvote — the same self-upvote
            // that the normal submitOne mutation emits. No fake votes
            // are ever added beyond that.
            upvotes: 1,
            downvotes: 0,
            submitterName: SERVICE_USER_NAME,
            submitterImage: undefined,
          });
          await ctx.db.insert("votes", {
            targetId: scoreId as unknown as string,
            targetType: "modelScore",
            userId: serviceUserId,
            value: 1,
          });
          stats.scoresInserted++;
        }
      } catch (e: any) {
        stats.errors.push(
          `${entry.name}: ${e?.message ?? String(e)}`
        );
      }
    }

    return stats;
  },
});

// Recompute everything downstream (rankings, family rankings, bench
// aggregates, tag counts). Run ONCE after all chunks have been applied.
// Safe to re-run.
export const recomputeAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    // rankings.recomputeAll walks every model; cheaper than per-insert
    // incremental updates when we've just dumped hundreds of scores.
    await ctx.runMutation(internal.rankings.recomputeAll, {});
    // Bench aggregates (cached quality score, headroom, modelCount, …)
    await ctx.runMutation(internal.migrations.backfillBenchAggregates, {});
    // Tag counts rebuild (idempotent full sweep)
    await ctx.runMutation(internal.migrations.backfillTagCounts, {});
    // Family rankings (introduced alongside seed): recompute from scratch.
    // Guarded so the import doesn't fail if the family-rankings feature
    // lands in a later commit.
    try {
      await ctx.runMutation((internal as any).familyRankings.recomputeAll, {});
    } catch {
      // familyRankings feature not yet deployed — ignore.
    }
    return { ok: true };
  },
});
