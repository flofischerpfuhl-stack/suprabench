// ════════════════════════════════════════════════════════════
// MODEL-FAMILY RANKINGS
//
// Aggregates individual-model scores up to their familyTag (e.g.
// "GPT-4", "Claude 3.5", "Gemini 2.5") so the leaderboard can toggle
// between a "models" view and a "families" view without an O(M×B)
// re-scan on every frontend subscription.
//
// ── Aggregation semantics ───────────────────────────────────
// A family's per-bench score is the MEDIAN of its constituent
// models' per-bench medians. That median (not mean) is the right
// choice because:
//   • outlier models in a family (e.g. an accidentally-tested older
//     variant) shouldn't drag the family score
//   • "the family as a whole" is what a user browsing for "which GPT
//     family should I use?" actually wants — median tracks that.
//
// Then the family's supraScore is the bench-weighted mean of those
// family medians, adjusted by evidence confidence around the neutral
// 50-point midpoint exactly like the per-model SupraScore. Evidence
// share is computed within the family scale (max over all families,
// not over all models) so the leaderboard's top-evidence family has
// share=1.
//
// ── What counts as a family ─────────────────────────────────
// Models with `familyTag === undefined` or empty string are NOT
// counted anywhere. We don't invent a pseudo-family from the model's
// own name — that would flood the leaderboard with single-member
// "families" and make the toggle useless.
//
// Hidden models (entity-votes ≤ threshold) are skipped entirely. If
// every member of a family is hidden, the familyRankings row is
// flagged `hidden: true` so list queries can filter it out the same
// way they filter hidden models.
//
// ── How recompute is wired ──────────────────────────────────
// All actual rebuild logic lives in rankings.recomputeAllUnifiedImpl,
// which rebuilds modelRankings AND familyRankings from a single
// shared read pass. The mutations in this file are kept as named
// entry points (`recomputeAll`, `recomputeFamily`) so external
// callers — the migrations module, manual `npx convex run` invocations,
// and entity-vote cascades that target a specific family — keep
// working unchanged. They all delegate straight to the unified impl.
//
// Why one impl instead of two: scores are the dominant doc-read cost,
// and the previous design re-read them once per rebuild. Sharing the
// pass cuts ~46% off the per-event database bandwidth without
// changing any observable output (same SupraScores, same hidden flags,
// same idempotency).
// ════════════════════════════════════════════════════════════

import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { recomputeAllUnifiedImpl } from "./rankings";

// Recompute a single family (identified by familyTag, optionally
// scoped to a provider). Because the evidence-confidence factor compares
// this family's evidence weight against the max over ALL families, a
// "single family" update is never actually local — we always
// full-rebuild. Args are accepted for backwards compatibility with
// the entity-vote cascade in entityVotes.ts and ignored.
export const recomputeFamily = internalMutation({
  args: { familyTag: v.string(), provider: v.optional(v.string()) },
  handler: async (ctx) => {
    const r = await recomputeAllUnifiedImpl(ctx);
    return { rows: r.families };
  },
});

// Rebuild the entire familyRankings table (and modelRankings, since
// they share a read pass). Safe to run repeatedly; idempotent.
//
// Usage:
//   npx convex run --prod familyRankings:recomputeAll
export const recomputeAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    const r = await recomputeAllUnifiedImpl(ctx);
    return {
      liveFamilies: r.families,
      rowsWritten: r.families,
      rowsDeleted: r.familiesDeleted,
    };
  },
});
