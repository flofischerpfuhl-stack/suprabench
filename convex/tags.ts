import { query } from "./_generated/server";
import { v } from "convex/values";

// Aggregated tag counts across both benches and models. Used as the
// global tag filter bar / autocomplete source.
export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const counts: Record<string, { count: number; benches: number; models: number }> = {};

    const benches = await ctx.db.query("benches").collect();
    for (const b of benches) {
      for (const t of b.tags) {
        const e = counts[t] ?? { count: 0, benches: 0, models: 0 };
        e.count += 1;
        e.benches += 1;
        counts[t] = e;
      }
    }

    const models = await ctx.db.query("models").collect();
    for (const m of models) {
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

// Substring search over all known tags. Used by the tag autocomplete
// in the submit form and in the future global tag picker.
export const search = query({
  args: { query: v.string() },
  handler: async (ctx, { query }) => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const benches = await ctx.db.query("benches").collect();
    const models = await ctx.db.query("models").collect();

    const set = new Set<string>();
    for (const b of benches) for (const t of b.tags) set.add(t);
    for (const m of models) for (const t of m.tags) set.add(t);

    return Array.from(set)
      .filter((t) => t.includes(q))
      .sort()
      .slice(0, 20);
  },
});
