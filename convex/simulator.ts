// ════════════════════════════════════════════════════════════
// SIMULATED SUPRASCORE — backend.
//
// Partner and Enterprise+ users can compute a *what-if* SupraScore
// for an unreleased model: "if I added a model with these scores
// against these existing benches, what rank would it land at?"
// Useful for marketing decks ("our internal eval shows model X would
// place #3 on SupraBench") without forcing partners to publish their
// scores prematurely.
//
// Architecture (UI-only, by design):
//
//   1. Frontend opens the simulator tab → fetches `fetchSnapshot`
//      ONCE per session: a bulk dump of every bench, every model,
//      every valid modelScore. Heavy-ish payload but cached
//      client-side after the first load (snapshots only refresh on
//      explicit user action or page reload).
//   2. User fills out the form, hits Simulate.
//   3. Frontend calls `recordRun` to charge one quota unit (and
//      enforce the daily limit) — this is the ONLY DB write the
//      simulator does. No simulated model, no simulated score, no
//      simulated ranking is persisted.
//   4. Frontend runs the full ranking math in-browser (see
//      public/js/simulator-math.js) and renders the hypothetical
//      leaderboard right next to the live one.
//
// Why no API endpoint? The user explicitly preferred UI-only:
// JSON-shaped requests for "scores for each of these existing
// benches" are a high-error-rate surface (slug typos, scale unit
// mistakes), and the use case is marketing — i.e. someone is going
// to look at the result anyway. UI-first matches that workflow
// without inventing a new error class.
//
// Tier gating: only users with grantedTier ∈ {partner,
// enterprise_plus} AND grantedLimits.simulationsPerDay > 0 can use
// the feature. Admins do NOT get a special bypass — if an admin
// wants to use the simulator, they self-grant a partner/enterprise+
// tier with their preferred daily limit (the admin board has the
// limit field). This keeps the abuse-surface analysis trivial:
// every user who can run the simulator has a hard daily counter,
// no exceptions.
// ════════════════════════════════════════════════════════════

import { mutation, query, type QueryCtx, type MutationCtx } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "./_generated/dataModel";

// "Tier" of access the simulator demands. Centralised so the
// snapshot query, the recordRun mutation and the usage query agree
// on who counts as eligible.
async function assertSimulatorAccess(
  ctx: QueryCtx | MutationCtx
): Promise<{
  userId: Id<"users">;
  tier: "partner" | "enterprise_plus";
  limit: number;
}> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("unauthorized (not signed in)");
  const role = await ctx.db
    .query("userRoles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  const tier = role?.grantedTier;
  if (tier !== "partner" && tier !== "enterprise_plus") {
    throw new Error(
      "simulator requires Partner or Enterprise+ tier — contact the SupraBench team"
    );
  }
  const limit = role?.grantedLimits?.simulationsPerDay ?? 0;
  if (limit <= 0) {
    throw new Error(
      "your tier grant has no daily simulator budget — ask your SupraBench account contact to set one"
    );
  }
  return { userId, tier, limit };
}

function todayKey(): string {
  // YYYY-MM-DD in UTC. UTC is fine here — the simulator is a
  // burst tool, not a billing window, and a single global day
  // boundary is one less thing to misexplain.
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(
    2,
    "0"
  )}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ──────────────────────────── QUERIES ────────────────────────────

/** Returns *everything* the client-side simulator math needs to
 *  re-rank the entire leaderboard with one hypothetical extra
 *  model. Heavy by design (one round-trip ≈ tens of kilobytes for
 *  current scale) — that's the price of doing the recompute
 *  client-side and getting a snappy UX without writing any
 *  hypothetical state to the DB.
 *
 *  Tier-gated: same gate as recordRun, so unauthorised users can't
 *  use this as a bulk-export side channel. (The data IS all
 *  derivable from the public model-detail pages and /v1/export
 *  on Enterprise+, so this isn't strictly more sensitive than
 *  what's already public — the gate is mostly hygiene.) */
export const fetchSnapshot = query({
  args: {},
  handler: async (ctx) => {
    await assertSimulatorAccess(ctx);

    const benches = await ctx.db.query("benches").collect();
    const models = await ctx.db.query("models").collect();
    const scoresRaw = await ctx.db.query("modelScores").collect();

    // Set of non-hidden model ids: used to filter scores so the
    // simulator math only sees what the live ranker would see.
    const visibleModelIds = new Set(
      models.filter((m) => !(m as any).hidden).map((m) => m._id as string)
    );
    const visibleBenchIds = new Set(
      benches.filter((b) => !(b as any).hidden).map((b) => b._id as string)
    );

    // Only ship the columns the math touches — keeps the payload
    // lean and the contract tight (less coupling between schema
    // evolution and simulator code).
    const benchesOut = benches.map((b: any) => ({
      _id: b._id,
      slug: b.slug,
      name: b.name,
      scaleMin: b.scaleMin,
      scaleMax: b.scaleMax,
      hidden: !!b.hidden,
      tags: b.tags ?? [],
      cachedQualityScore: b.cachedQualityScore ?? null,
      cachedDifficultyMultiplier: b.cachedDifficultyMultiplier ?? null,
      cachedHeadroom: b.cachedHeadroom ?? null,
      cachedFrontierMean: b.cachedFrontierMean ?? null,
      cachedModelCount: b.cachedModelCount ?? null,
      cachedNetUpvotes: typeof b.cachedNetUpvotes === "number" ? b.cachedNetUpvotes : 1,
      cachedEffectiveWeight: b.cachedEffectiveWeight ?? null,
    }));

    const modelsOut = models
      .filter((m: any) => !m.hidden)
      .map((m: any) => ({
        _id: m._id,
        slug: m.slug,
        name: m.name,
        provider: m.provider,
        familyTag: m.familyTag ?? null,
      }));

    const scoresOut = scoresRaw
      .filter(
        (s: any) =>
          s.upvotes > s.downvotes &&
          visibleModelIds.has(s.modelId as string) &&
          visibleBenchIds.has(s.benchId as string)
      )
      .map((s: any) => ({
        modelId: s.modelId,
        benchId: s.benchId,
        normalizedScore: s.normalizedScore,
      }));

    return {
      benches: benchesOut,
      models: modelsOut,
      scores: scoresOut,
      capturedAt: Date.now(),
    };
  },
});

/** Returns the calling user's simulator usage for today plus the
 *  daily limit from their grant. Frontend uses this to gate the
 *  Simulate button and show the remaining budget. Returns null if
 *  the user has no simulator access at all (frontend hides the tab
 *  in that case). */
export const myUsageToday = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const role = await ctx.db
      .query("userRoles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    const tier = role?.grantedTier;
    if (tier !== "partner" && tier !== "enterprise_plus") return null;
    const limit = role?.grantedLimits?.simulationsPerDay ?? 0;
    if (limit <= 0) return { tier, limit: 0, used: 0 };

    const today = todayKey();
    const row = await ctx.db
      .query("simulationUsage")
      .withIndex("by_user_day", (q) =>
        q.eq("userId", userId).eq("yyyymmdd", today)
      )
      .first();
    return { tier, limit, used: row?.count ?? 0 };
  },
});

// ──────────────────────────── MUTATIONS ──────────────────────────

/** Charge one simulator-run unit against the calling user's daily
 *  budget. Throws if they're over the limit so the frontend can
 *  surface a clean error and refuse to render the result. The
 *  actual simulation math runs client-side — this mutation is
 *  pure budgeting, no simulated state ever lands in the DB. */
export const recordRun = mutation({
  args: {},
  handler: async (ctx) => {
    const { userId, tier, limit } = await assertSimulatorAccess(ctx);
    const today = todayKey();
    const existing = await ctx.db
      .query("simulationUsage")
      .withIndex("by_user_day", (q) =>
        q.eq("userId", userId).eq("yyyymmdd", today)
      )
      .first();
    const used = existing?.count ?? 0;
    if (used >= limit) {
      throw new Error(
        `daily simulator budget exhausted (${used}/${limit}). Resets at 00:00 UTC.`
      );
    }
    if (existing) {
      await ctx.db.patch(existing._id, { count: used + 1 });
    } else {
      await ctx.db.insert("simulationUsage", {
        userId,
        yyyymmdd: today,
        count: 1,
      });
    }
    return { tier, used: used + 1, limit, remaining: limit - (used + 1) };
  },
});
