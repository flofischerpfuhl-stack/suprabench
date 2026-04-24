import { query } from "./_generated/server";
import { v } from "convex/values";

// Aggregated tag counts across both benches and models. Used as the
// global tag filter bar / autocomplete source.
//
// Fast path: read the denormalized tagCounts cache (kept in sync by
// tagVotes.recomputeEffectiveTags via cache.applyTagDeltaInline).
// Slow fallback: full collect of benches+models when the cache is empty
// (i.e. before `migrations:backfillTagCounts` has been run, or when the
// site has zero tagged entities).
export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const cached = await ctx.db.query("tagCounts").collect();
    if (cached.length > 0) {
      return cached
        .map((c) => ({
          tag: c.tag,
          count: c.benches + c.models,
          benches: c.benches,
          models: c.models,
        }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    }

    // Fallback: legacy O(M+B) full scan.
    const counts: Record<string, { count: number; benches: number; models: number }> = {};
    const benches = await ctx.db.query("benches").collect();
    for (const b of benches) {
      if (b.hidden) continue;
      for (const t of b.tags) {
        const e = counts[t] ?? { count: 0, benches: 0, models: 0 };
        e.count += 1;
        e.benches += 1;
        counts[t] = e;
      }
    }
    const models = await ctx.db.query("models").collect();
    for (const m of models) {
      if (m.hidden) continue;
      for (const t of m.tags) {
        const e = counts[t] ?? { count: 0, benches: 0, models: 0 };
        e.count += 1;
        e.models += 1;
        counts[t] = e;
      }
    }
    return Object.entries(counts)
      .map(([tag, e]) => ({ tag, ...e }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  },
});

// Tags that appear on at least one non-hidden BENCH. Returned sorted
// by bench-count desc, then alphabetically. This is the canonical list
// for the leaderboard's tag-filter chips, because filtering models by
// tag computes a "filtered SupraScore" that only makes sense if the
// tag actually selects benches. A model-only tag like "multimodal"
// (no bench has that tag yet) would just yield a null filteredScore
// for every model — so we hide it from the chips.
//
// Same fast/slow split as listAll.
export const listForBenches = query({
  args: {},
  handler: async (ctx) => {
    const cached = await ctx.db.query("tagCounts").collect();
    if (cached.length > 0) {
      return cached
        .filter((c) => c.benches > 0)
        .map((c) => ({ tag: c.tag, count: c.benches }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    }
    const counts: Record<string, number> = {};
    const benches = await ctx.db.query("benches").collect();
    for (const b of benches) {
      if (b.hidden) continue;
      for (const t of b.tags) counts[t] = (counts[t] ?? 0) + 1;
    }
    return Object.entries(counts)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  },
});

// Tags that appear on at least one non-hidden MODEL. Currently only
// surfaced via the search autocomplete (so typing "multimodal" finds
// Gemini even if no bench is tagged that way). Not used for filter
// chips — the chips are bench-tags only (see listForBenches above).
export const listForModels = query({
  args: {},
  handler: async (ctx) => {
    const cached = await ctx.db.query("tagCounts").collect();
    if (cached.length > 0) {
      return cached
        .filter((c) => c.models > 0)
        .map((c) => ({ tag: c.tag, count: c.models }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    }
    const counts: Record<string, number> = {};
    const models = await ctx.db.query("models").collect();
    for (const m of models) {
      if (m.hidden) continue;
      for (const t of m.tags) counts[t] = (counts[t] ?? 0) + 1;
    }
    return Object.entries(counts)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  },
});

// Substring search over all known tags. Used by the tag autocomplete
// in the submit form and in the future global tag picker.
//
// Uses the denormalized tagCounts cache (one indexed scan, O(distinct tags))
// instead of the previous O(M+B) full scan over models and benches.
export const search = query({
  args: { query: v.string() },
  handler: async (ctx, { query }) => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const cached = await ctx.db.query("tagCounts").collect();
    if (cached.length > 0) {
      return cached
        .map((c) => c.tag)
        .filter((t) => t.includes(q))
        .sort()
        .slice(0, 20);
    }

    // Fallback: legacy O(M+B) full scan.
    const benches = await ctx.db.query("benches").collect();
    const models = await ctx.db.query("models").collect();
    const set = new Set<string>();
    for (const b of benches) if (!b.hidden) for (const t of b.tags) set.add(t);
    for (const m of models) if (!m.hidden) for (const t of m.tags) set.add(t);
    return Array.from(set)
      .filter((t) => t.includes(q))
      .sort()
      .slice(0, 20);
  },
});
