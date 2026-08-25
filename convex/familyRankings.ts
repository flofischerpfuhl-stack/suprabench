// ════════════════════════════════════════════════════════════
// MODEL-FAMILY RANKINGS
//
// Aggregates individual-model scores up to their familyTag (e.g.
// "GPT-4", "Claude 3.5", "Gemini 2.5") so the leaderboard can toggle
// between a "models" view and a "families" view without an O(M×B)
// re-scan on every frontend subscription.
//
// ── Family-ceiling semantics ───────────────────────────────
// Each benchmark keeps the family's best valid concrete configuration, without
// mutating or merging the source rows. Weighted pairwise wins/losses are joined
// across benchmark participant fields with a regularized Bradley-Terry fit.
// Families with fewer than three distinct benchmarks stay visible but are
// explicitly marked provisional.
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
// scoped to a provider). Pairwise ability is relative to all participating
// families, so a "single family" update is never actually local — we always
// full-rebuild. Args are accepted
// for backwards compatibility with
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
