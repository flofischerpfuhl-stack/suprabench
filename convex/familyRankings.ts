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
// Then the family's supraScore uses the SAME bench-weight formula as
// individual models (quality × difficulty × headroom, floor 0.1).
// This makes family / model scores directly comparable — a family
// can't game the score by having a larger model roster.
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
// ── When does this recompute? ───────────────────────────────
// Whenever rankings.recomputeModel or rankings.recomputeAll runs,
// it also triggers recomputeFamily(familyTag) for the affected
// family. rankings.recomputeForBench walks every model whose score
// changed, so families transitively get recomputed too.
// ════════════════════════════════════════════════════════════

import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { getBenchWeights } from "./rankings";

// ── Helpers ──

function median(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  return s.length % 2 === 0
    ? (s[s.length / 2 - 1] + s[s.length / 2]) / 2
    : s[Math.floor(s.length / 2)];
}

function normalizeFamilyKey(familyTag: string | undefined | null): string | null {
  if (!familyTag) return null;
  const t = familyTag.trim();
  return t.length === 0 ? null : t;
}

// Compute + upsert a single family's ranking row.
// If `provider` is specified and no matching models exist (e.g.
// because the last model was deleted), the existing row is marked
// hidden rather than deleted — preserves referential integrity for
// any cached link we might have shipped out.
async function recomputeOneFamily(
  ctx: any,
  familyTag: string,
  provider: string | null = null
) {
  // Find all models in this family. We scan the table — family size
  // is small (< 100 models per family in practice) so a scan is
  // cheap and avoids adding a by_family index.
  const allModels = await ctx.db.query("models").collect();
  const members = allModels.filter(
    (m: any) =>
      normalizeFamilyKey(m.familyTag) === familyTag &&
      (provider === null || m.provider === provider)
  );

  // Distinct providers inside the family. Usually 1 (GPT-4 is all
  // OpenAI) but occasionally 2+ (e.g. a lab + their fine-tuner); we
  // emit one row per (familyTag, provider) to keep them separate on
  // the UI.
  const providers = new Set<string>(members.map((m: any) => m.provider));
  const resultRows: any[] = [];

  for (const p of providers) {
    const familyMembers = members.filter((m: any) => m.provider === p);
    const visible = familyMembers.filter((m: any) => !m.hidden);
    const isAllHidden = visible.length === 0 && familyMembers.length > 0;

    // Collect every valid score from every visible member, grouped by bench.
    // perBench[benchId] = array of per-member medians on that bench.
    const perBench: Record<string, number[]> = {};
    for (const m of visible) {
      const scores = await ctx.db
        .query("modelScores")
        .withIndex("by_model", (q: any) => q.eq("modelId", m._id))
        .collect();
      const byBench: Record<string, number[]> = {};
      for (const s of scores) {
        if (s.upvotes > s.downvotes) {
          const k = s.benchId as string;
          (byBench[k] ??= []).push(s.normalizedScore);
        }
      }
      for (const [benchId, vals] of Object.entries(byBench)) {
        const med = median(vals);
        (perBench[benchId] ??= []).push(med);
      }
    }

    let weightedSum = 0;
    let weightTotal = 0;
    let benchCount = 0;

    for (const [benchId, memberMedians] of Object.entries(perBench)) {
      const familyMedian = median(memberMedians);
      const w = await getBenchWeights(ctx, benchId as Id<"benches">);
      if (w.weight <= 0) continue;
      weightedSum += w.weight * familyMedian;
      weightTotal += w.weight;
      benchCount++;
    }

    const supraScore = weightTotal > 0 ? weightedSum / weightTotal : 0;

    // Union of member tags — useful for the tag-filter UX, same as
    // modelRankings.tags.
    const tagSet = new Set<string>();
    for (const m of visible) for (const t of (m.tags ?? [])) tagSet.add(t);

    const data = {
      familyTag,
      provider: p,
      supraScore: Math.round(supraScore * 10) / 10,
      benchCount,
      modelCount: visible.length,
      tags: Array.from(tagSet),
      updatedAt: Date.now(),
      hidden: isAllHidden,
    };

    const existing = await ctx.db
      .query("familyRankings")
      .withIndex("by_family_provider", (q: any) =>
        q.eq("familyTag", familyTag).eq("provider", p)
      )
      .first();

    if (existing) await ctx.db.patch(existing._id, data);
    else await ctx.db.insert("familyRankings", data);
    resultRows.push(data);
  }

  return resultRows;
}

// ── Public internal mutations ──

// Recompute a single family (identified by familyTag, and optionally
// a specific provider). Called by rankings.recomputeModel when a
// model with that familyTag changes.
export const recomputeFamily = internalMutation({
  args: { familyTag: v.string(), provider: v.optional(v.string()) },
  handler: async (ctx, { familyTag, provider }) => {
    const rows = await recomputeOneFamily(ctx, familyTag, provider ?? null);
    return { rows: rows.length };
  },
});

// Rebuild the entire familyRankings table from scratch. Safe to run
// repeatedly; idempotent.
//
// Usage:
//   npx convex run --prod familyRankings:recomputeAll
export const recomputeAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    // 1. Purge rows whose familyTag no longer exists on any model
    //    (happens after a model rename / family-tag change).
    const allModels = await ctx.db.query("models").collect();
    const liveFamilies = new Set<string>();
    for (const m of allModels) {
      const k = normalizeFamilyKey(m.familyTag);
      if (k) liveFamilies.add(k);
    }
    const existingRows = await ctx.db.query("familyRankings").collect();
    let deleted = 0;
    for (const r of existingRows) {
      if (!liveFamilies.has(r.familyTag)) {
        await ctx.db.delete(r._id);
        deleted++;
      }
    }

    // 2. Recompute every live family.
    let touched = 0;
    for (const f of liveFamilies) {
      const rows = await recomputeOneFamily(ctx, f, null);
      touched += rows.length;
    }

    return {
      liveFamilies: liveFamilies.size,
      rowsWritten: touched,
      rowsDeleted: deleted,
    };
  },
});
