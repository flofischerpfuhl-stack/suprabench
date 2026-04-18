import { internalMutation } from "./_generated/server";

// One-off cleanup: removes auth* records pointing to a non-existent user.
// Safe to keep around; idempotent. Run via:
//   npx convex run --prod admin:cleanupOrphanAuth
export const cleanupOrphanAuth = internalMutation({
  args: {},
  handler: async (ctx) => {
    const report: Record<string, number> = {};

    const accounts = await ctx.db.query("authAccounts").collect();
    for (const a of accounts) {
      const u = await ctx.db.get(a.userId as any);
      if (!u) {
        await ctx.db.delete(a._id);
        report.accounts = (report.accounts ?? 0) + 1;
      }
    }
    const sessions = await ctx.db.query("authSessions").collect();
    for (const s of sessions) {
      const u = await ctx.db.get(s.userId as any);
      if (!u) {
        await ctx.db.delete(s._id);
        report.sessions = (report.sessions ?? 0) + 1;
      }
    }
    const refresh = await ctx.db.query("authRefreshTokens").collect();
    for (const r of refresh) {
      const s = await ctx.db.get(r.sessionId as any);
      if (!s) {
        await ctx.db.delete(r._id);
        report.refreshTokens = (report.refreshTokens ?? 0) + 1;
      }
    }
    const verifiers = await ctx.db.query("authVerifiers").collect();
    for (const v of verifiers) {
      if (Date.now() - v._creationTime > 60 * 60 * 1000) {
        await ctx.db.delete(v._id);
        report.verifiers = (report.verifiers ?? 0) + 1;
      }
    }
    return report;
  },
});
