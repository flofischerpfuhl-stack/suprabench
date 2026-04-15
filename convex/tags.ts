import { query } from "./_generated/server";

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const benches = await ctx.db.query("benches").collect();

    const tagCounts: Record<string, number> = {};
    for (const bench of benches) {
      for (const tag of bench.tags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }

    return Object.entries(tagCounts)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
  },
});
