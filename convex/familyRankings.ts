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
// family medians, scaled by √(family_totalWeight / max_family_totalWeight)
// exactly like the per-model SupraScore. Coverage-share is computed
// within the family scale (max over all families, not over all models)
// so the leaderboard's top family always has share=1.
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

// Compute the raw aggregate (weightedMean + totalWeight + benchCount +
// tags + hidden-flag) for one (familyTag, provider) group. Does NOT
// write anything — caller composes all aggregates, finds max
// totalWeight across families, then writes familyRankings rows in a
// second pass so the coverage-share denominator is global.
async function aggregateFamilyProvider(
  ctx: any,
  members: any[],
  familyTag: string,
  provider: string
): Promise<{
  familyTag: string;
  provider: string;
  weightedMean: number;
  totalWeight: number;
  benchCount: number;
  modelCount: number;
  tags: string[];
  hidden: boolean;
} | null> {
  const familyMembers = members.filter((m: any) => m.provider === provider);
  if (familyMembers.length === 0) return null;
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

  const weightedMean = weightTotal > 0 ? weightedSum / weightTotal : 0;

  const tagSet = new Set<string>();
  for (const m of visible) for (const t of (m.tags ?? [])) tagSet.add(t);

  return {
    familyTag,
    provider,
    weightedMean,
    totalWeight: weightTotal,
    benchCount,
    modelCount: visible.length,
    tags: Array.from(tagSet),
    hidden: isAllHidden,
  };
}

async function writeFamilyRow(
  ctx: any,
  agg: {
    familyTag: string;
    provider: string;
    weightedMean: number;
    totalWeight: number;
    benchCount: number;
    modelCount: number;
    tags: string[];
    hidden: boolean;
  },
  maxFamilyTotalWeight: number
) {
  const share =
    maxFamilyTotalWeight > 0
      ? Math.min(1, agg.totalWeight / maxFamilyTotalWeight)
      : 0;
  const supraScore = agg.weightedMean * Math.sqrt(share);

  const data = {
    familyTag: agg.familyTag,
    provider: agg.provider,
    supraScore: Math.round(supraScore * 10) / 10,
    benchCount: agg.benchCount,
    modelCount: agg.modelCount,
    tags: agg.tags,
    updatedAt: Date.now(),
    hidden: agg.hidden,
  };

  const existing = await ctx.db
    .query("familyRankings")
    .withIndex("by_family_provider", (q: any) =>
      q.eq("familyTag", agg.familyTag).eq("provider", agg.provider)
    )
    .first();

  if (existing) await ctx.db.patch(existing._id, data);
  else await ctx.db.insert("familyRankings", data);
}

async function recomputeAllImpl(ctx: any) {
  // 1. Enumerate every live (familyTag, provider) pair from models.
  const allModels = await ctx.db.query("models").collect();
  const liveFamilies = new Set<string>();
  const pairs = new Map<string, { familyTag: string; provider: string }>();
  for (const m of allModels) {
    const k = normalizeFamilyKey(m.familyTag);
    if (!k) continue;
    liveFamilies.add(k);
    pairs.set(`${k}\u0000${m.provider}`, { familyTag: k, provider: m.provider });
  }

  // 2. Purge rows whose (familyTag, provider) no longer exists
  //    (happens after model rename / family-tag change / delete).
  const existingRows = await ctx.db.query("familyRankings").collect();
  let deleted = 0;
  for (const r of existingRows) {
    const key = `${r.familyTag}\u0000${r.provider}`;
    if (!pairs.has(key)) {
      await ctx.db.delete(r._id);
      deleted++;
    }
  }

  // 3. Pass 1: compute raw aggregates for every (family, provider).
  const aggregates: NonNullable<
    Awaited<ReturnType<typeof aggregateFamilyProvider>>
  >[] = [];
  const membersByFamily = new Map<string, any[]>();
  for (const m of allModels) {
    const k = normalizeFamilyKey(m.familyTag);
    if (!k) continue;
    const list = membersByFamily.get(k) ?? [];
    list.push(m);
    membersByFamily.set(k, list);
  }
  for (const { familyTag, provider } of pairs.values()) {
    const members = membersByFamily.get(familyTag) ?? [];
    const agg = await aggregateFamilyProvider(ctx, members, familyTag, provider);
    if (agg) aggregates.push(agg);
  }

  // 4. Max totalWeight across all non-hidden families — denominator
  //    for the √(coverageShare) factor. Hidden families don't count
  //    (same rationale as per-model: a mothballed giant shouldn't
  //    permanently squash everyone else).
  let maxFamilyTotalWeight = 0;
  for (const a of aggregates) {
    if (a.hidden) continue;
    if (a.totalWeight > maxFamilyTotalWeight) maxFamilyTotalWeight = a.totalWeight;
  }

  // 5. Pass 2: write rows.
  for (const a of aggregates) {
    await writeFamilyRow(ctx, a, maxFamilyTotalWeight);
  }

  return {
    liveFamilies: liveFamilies.size,
    rowsWritten: aggregates.length,
    rowsDeleted: deleted,
  };
}

// ── Public internal mutations ──

// Recompute a single family (identified by familyTag, and optionally
// a specific provider). Because the coverage-share factor compares
// this family's totalWeight against the max over ALL families, a
// single-family update isn't actually local — we full-rebuild. Kept
// under the old name so existing callers don't change.
export const recomputeFamily = internalMutation({
  args: { familyTag: v.string(), provider: v.optional(v.string()) },
  handler: async (ctx) => {
    const r = await recomputeAllImpl(ctx);
    return { rows: r.rowsWritten };
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
    return await recomputeAllImpl(ctx);
  },
});
