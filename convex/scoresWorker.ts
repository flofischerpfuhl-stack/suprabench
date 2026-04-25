// ════════════════════════════════════════════════════════════
//  Cloudflare-D1 mirror for the modelScores table.
//
//  Phase-1 architecture (this file):
//    Convex modelScores stays the primary store. Every write to
//    a score row is followed by a scheduled action that pushes
//    the new value to a Cloudflare Worker, which persists it in
//    a D1 SQLite table indexed by Convex _id.
//
//    The ranking recompute action then *reads* its score input
//    from D1 instead of Convex, which is the whole point — D1
//    has no egress meter on the free tier and Convex's 1 GB/mo
//    bandwidth is the binding constraint that drove this
//    migration in the first place.
//
//  Why mirror, not cut over yet:
//    Other read paths (api.ts, simulator, listByUser, vote.cast,
//    cache.recomputeBenchAggregatesInline, …) still read from
//    Convex modelScores. Those will move in phase 2. Until then
//    we keep both copies in sync so we can toggle the rebuild's
//    source freely without coordinating with every reader.
//
//  Eventual-consistency window:
//    The mirror runs as a scheduler-runAfter(0, …) action, so
//    D1 lags Convex by one event-loop tick under nominal load
//    and by however long the worker fetch takes (~50 ms p50)
//    in the worst case. The ranking recompute itself runs as a
//    scheduled action, so by the time it fires, the mirror has
//    almost always settled. Edge case (rebuild fires before
//    mirror): the recompute sees the previous score snapshot,
//    rankings are slightly stale for one tick. Acceptable.
//
//  Auth:
//    Single shared bearer secret (SCORES_WORKER_SECRET) held in
//    Convex env vars + the worker's secret store. Server-to-
//    server only — the browser never touches this URL.
// ════════════════════════════════════════════════════════════

import { v } from "convex/values";
import {
  internalAction,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// ── Score row shape exchanged with the worker ───────────────
// Mirrors infra/scores-worker/schema.sql. Keep field names
// identical to the Convex doc shape so the mapper is trivial.
export interface D1ScoreRow {
  convex_id: string;
  modelId: string;
  benchId: string;
  rawScore: number;
  normalizedScore: number;
  sourceUrl: string;
  accessedAt: number;
  submittedBy: string;
  createdAt: number;
  upvotes: number;
  downvotes: number;
  submitterName: string | null;
  submitterImage: string | null;
}

function rowFromConvexDoc(s: any): D1ScoreRow {
  return {
    convex_id: s._id as string,
    modelId: s.modelId as string,
    benchId: s.benchId as string,
    rawScore: s.rawScore,
    normalizedScore: s.normalizedScore,
    sourceUrl: s.sourceUrl ?? "",
    accessedAt: s.accessedAt,
    submittedBy: s.submittedBy as string,
    createdAt: s.createdAt,
    upvotes: s.upvotes,
    downvotes: s.downvotes,
    submitterName: s.submitterName ?? null,
    submitterImage: s.submitterImage ?? null,
  };
}

// ── HTTP helpers (run inside Convex actions only) ───────────

function workerEnv(): { url: string; secret: string } {
  const url = process.env.SCORES_WORKER_URL;
  const secret = process.env.SCORES_WORKER_SECRET;
  if (!url || !secret) {
    throw new Error(
      "SCORES_WORKER_URL / SCORES_WORKER_SECRET env var missing — " +
        "run `npx convex env set SCORES_WORKER_URL …` and `… SECRET …` " +
        "(see infra/scores-worker/README.md for setup)."
    );
  }
  return { url: url.replace(/\/$/, ""), secret };
}

async function workerFetch(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<Response> {
  const { url, secret } = workerEnv();
  const res = await fetch(`${url}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${secret}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return res;
}

async function pushOneScore(row: D1ScoreRow): Promise<void> {
  const res = await workerFetch("/scores", { method: "POST", body: row });
  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`scores worker POST /scores failed ${res.status}: ${text}`);
  }
}

async function pushScoresBulk(rows: D1ScoreRow[]): Promise<void> {
  if (rows.length === 0) return;
  // Worker enforces atomic batches via D1 batch(); 100 rows at a
  // time keeps us comfortably under the 100 KB request body cap
  // (each row is ≈ 0.4 KB JSON).
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const res = await workerFetch("/scores/bulk", {
      method: "POST",
      body: { scores: slice },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      throw new Error(
        `scores worker POST /scores/bulk failed ${res.status} (chunk @ ${i}): ${text}`
      );
    }
  }
}

async function deleteOneScore(convexId: string): Promise<void> {
  const res = await workerFetch(`/scores/${encodeURIComponent(convexId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(
      `scores worker DELETE /scores/${convexId} failed ${res.status}: ${text}`
    );
  }
}

export async function fetchAllScoresFromD1(): Promise<D1ScoreRow[]> {
  const res = await workerFetch("/scores");
  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`scores worker GET /scores failed ${res.status}: ${text}`);
  }
  const j = (await res.json()) as { scores: D1ScoreRow[] };
  return j.scores ?? [];
}

// ── Internal queries (read Convex side for mirror payloads) ─

export const _loadScoreById = internalQuery({
  args: { id: v.id("modelScores") },
  handler: async (ctx, { id }) => {
    const s = await ctx.db.get(id);
    return s ? rowFromConvexDoc(s) : null;
  },
});

export const _loadAllScores = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("modelScores").collect();
    return all.map(rowFromConvexDoc);
  },
});

// ── Mirror actions (called from mutations via scheduler) ────

// Mirror a single score by Convex id. Idempotent (worker
// upserts), so repeated invocations from a retry are safe.
export const mirrorScoreById = internalAction({
  args: { id: v.id("modelScores") },
  handler: async (ctx, { id }) => {
    const row = await ctx.runQuery(internal.scoresWorker._loadScoreById, { id });
    if (!row) return { ok: false, reason: "score not found" };
    await pushOneScore(row);
    return { ok: true };
  },
});

// Combined: mirror N scores to D1, THEN schedule the rankings
// recompute. The two-step chain matters because the recompute
// reads scores from D1 — if it fires before the mirror commits,
// it'd see a stale snapshot. By doing them inside one action we
// guarantee the rebuild only starts after every relevant row is
// in D1, with zero coordination needed at the mutation site.
//
// Fire from a mutation via:
//   ctx.scheduler.runAfter(
//     0,
//     internal.scoresWorker.mirrorScoresAndRebuild,
//     { scoreIds: [...] }
//   );
export const mirrorScoresAndRebuild = internalAction({
  args: { scoreIds: v.array(v.id("modelScores")) },
  handler: async (ctx, { scoreIds }) => {
    if (scoreIds.length > 0) {
      const rows: D1ScoreRow[] = [];
      for (const id of scoreIds) {
        const r = await ctx.runQuery(internal.scoresWorker._loadScoreById, {
          id,
        });
        if (r) rows.push(r);
      }
      await pushScoresBulk(rows);
    }
    // Schedule the rebuild as a follow-up rather than awaiting
    // it inline. Lets this action commit quickly and spreads the
    // CPU burst across two action runs (each with its own 256
    // MiB / 30 s budget).
    await ctx.scheduler.runAfter(0, internal.rankings.recomputeFromD1, {});
    return { mirrored: scoreIds.length };
  },
});

// Delete a score from the mirror. Used by admin/cleanup paths
// where the Convex row is gone and we want D1 to follow.
export const deleteScoreFromMirror = internalAction({
  args: { convexId: v.string() },
  handler: async (_ctx, { convexId }) => {
    await deleteOneScore(convexId);
    return { ok: true };
  },
});

// ── One-shot migration: copy every Convex modelScore → D1 ───
//
// Run from CLI after deploying the worker:
//   npx convex run --prod scoresWorker:migrateAllToD1 '{}'
//
// Idempotent (UPSERT on convex_id). Re-run to re-sync if the
// mirror drifts.
export const migrateAllToD1 = internalAction({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.runQuery(internal.scoresWorker._loadAllScores, {});
    await pushScoresBulk(rows);
    return { mirrored: rows.length };
  },
});

// ── Verification: row counts + a sampled hash ──────────────
// Cheap smoke test the operator can run after the migration to
// confirm the mirror matches the source. Hash is not used for
// security, only as a "did anything drift" signal.
export const verifyMirror = internalAction({
  args: {},
  handler: async (ctx) => {
    const convexRows = await ctx.runQuery(internal.scoresWorker._loadAllScores, {});
    const d1Rows = await fetchAllScoresFromD1();
    const convexIds = new Set(convexRows.map((r) => r.convex_id));
    const d1Ids = new Set(d1Rows.map((r) => r.convex_id));
    const onlyInConvex = [...convexIds].filter((id) => !d1Ids.has(id));
    const onlyInD1 = [...d1Ids].filter((id) => !convexIds.has(id));
    return {
      convexCount: convexRows.length,
      d1Count: d1Rows.length,
      onlyInConvex,
      onlyInD1,
      drift: onlyInConvex.length + onlyInD1.length,
    };
  },
});
