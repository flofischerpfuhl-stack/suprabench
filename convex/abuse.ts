import { Id } from "./_generated/dataModel";

function todayKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export async function enforceDailyActionLimit(
  ctx: any,
  userId: Id<"users">,
  action: string,
  limit: number,
  increment = 1
) {
  const yyyymmdd = todayKey();
  const row = await ctx.db
    .query("actionCounters")
    .withIndex("by_user_action_day", (q: any) =>
      q.eq("userId", userId).eq("action", action).eq("yyyymmdd", yyyymmdd)
    )
    .first();
  const used = row?.count ?? 0;
  if (used + increment > limit) {
    throw new Error(`Rate limit: max ${limit} ${action} actions per day`);
  }
  if (row) {
    await ctx.db.patch(row._id, { count: used + increment, updatedAt: Date.now() });
  } else {
    await ctx.db.insert("actionCounters", {
      userId,
      action,
      yyyymmdd,
      count: increment,
      updatedAt: Date.now(),
    });
  }
}

