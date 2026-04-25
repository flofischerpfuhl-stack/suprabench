// ════════════════════════════════════════════════════════════
// D1 migration regression tests.
//
// The phase-1 migration moved the score-read pass of the
// ranking rebuild from Convex to a Cloudflare-D1-backed worker.
// Both code paths feed the SAME pure compute kernel, so the
// SupraScore output must be byte-identical regardless of which
// driver is used.
//
// This file pins that invariant down with three layers:
//
//   1. ROUND-TRIP EQUIVALENCE — seed an ecosystem, compute
//      rankings via the legacy Convex-db driver, then re-run
//      the rebuild via the D1-action driver while a stubbed
//      `fetch` replays the same scores back through the
//      worker contract. The two ranking tables must agree on
//      every (modelId, supraScore, benchCount) tuple.
//
//   2. MIRROR PROTOCOL — verify that the mirror action POSTs
//      the right URL, the right Authorization header, and a
//      body that round-trips losslessly back to a Convex score
//      row. If the wire format ever drifts, this catches it
//      before the change reaches prod.
//
//   3. WORKER FAILURE MODES — when the worker returns 5xx, the
//      action surfaces an Error (so the scheduler retries it)
//      instead of silently dropping the mirror.
//
// All three layers stub `global.fetch`, so no live worker, no
// live D1, no network IO. Tests are hermetic and run in <2s.
// ════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, internal } from "./_fixtures";

const TEST_WORKER_URL = "https://fake-scores-worker.test";
const TEST_WORKER_SECRET = "test-secret-do-not-reuse-elsewhere";

beforeEach(() => {
  // Pin the env vars the scoresWorker module reads. Without
  // these the action throws before issuing any fetch, which
  // would mask the actual behaviour we're testing.
  vi.stubEnv("SCORES_WORKER_URL", TEST_WORKER_URL);
  vi.stubEnv("SCORES_WORKER_SECRET", TEST_WORKER_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ─── Seeding helpers (small, focused — bigger fixtures live in
//     coverage-share.test.ts; we want this file readable in one
//     screen so the equivalence assertion is the punchline). ──

async function newUser(t: ReturnType<typeof setupTestDb>, name: string) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name,
      email: `${name}@d1-migration.test`,
    } as any);
  });
}

async function newBench(
  t: ReturnType<typeof setupTestDb>,
  userId: any,
  name: string
) {
  return await t.run(async (ctx) => {
    const id = await ctx.db.insert("benches", {
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-"),
      description: `bench ${name}`,
      url: `https://arxiv.org/abs/2026.${Math.floor(Math.random() * 99999)}`,
      isOfficial: true,
      tags: [],
      scaleMin: 0,
      scaleMax: 100,
      addedBy: userId,
      createdAt: Date.now(),
    });
    // Pre-warm the bench cache so neither driver hits the
    // weight-fallback path. Mirrors what production does after
    // the first submission for any bench.
    await ctx.runMutation(internal.cache.recomputeBenchAggregates, {
      benchId: id,
    });
    return id;
  });
}

async function newModel(
  t: ReturnType<typeof setupTestDb>,
  userId: any,
  name: string,
  familyTag?: string
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("models", {
      name,
      provider: "TestLab",
      slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-"),
      familyTag,
      tags: [],
      addedBy: userId,
      createdAt: Date.now(),
    });
  });
}

async function newScore(
  t: ReturnType<typeof setupTestDb>,
  userId: any,
  modelId: any,
  benchId: any,
  rawScore: number,
  upvotes = 1,
  downvotes = 0
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("modelScores", {
      modelId,
      benchId,
      rawScore,
      normalizedScore: rawScore,
      sourceUrl: "https://example.com/source",
      accessedAt: Date.now(),
      submittedBy: userId,
      createdAt: Date.now(),
      upvotes,
      downvotes,
      submitterName: "d1-migration-test",
    });
  });
}

/**
 * Seed a tiny but adversarially-shaped ecosystem (sparse vs broad
 * coverage, mixed families, mixed validity from up/downvotes) and
 * return the IDs the assertions need. Re-used by every test in
 * this file so the equivalence claim is exercised against
 * non-trivial math, not a degenerate "everyone scored 80" case.
 */
async function seedEcosystem(t: ReturnType<typeof setupTestDb>) {
  const u = await newUser(t, "fixture");
  const u2 = await newUser(t, "voter");
  const bA = await newBench(t, u, "Bench-A");
  const bB = await newBench(t, u, "Bench-B");
  const bC = await newBench(t, u, "Bench-C");
  const m1 = await newModel(t, u, "Model-1", "Fam-X");
  const m2 = await newModel(t, u, "Model-2", "Fam-X"); // same family as m1
  const m3 = await newModel(t, u, "Model-3", "Fam-Y");
  const m4 = await newModel(t, u, "Model-4"); // no family
  // Sparse vs broad coverage:
  await newScore(t, u, m1, bA, 90);
  await newScore(t, u, m1, bB, 75);
  await newScore(t, u, m2, bA, 80);
  await newScore(t, u, m3, bA, 85);
  await newScore(t, u, m3, bB, 70);
  await newScore(t, u, m3, bC, 60);
  await newScore(t, u, m4, bC, 95);
  // One score that's been net-downvoted — must be excluded by
  // both drivers. If they disagree on validity handling, this
  // test pings the bug.
  await newScore(t, u, m2, bB, 99, /*ups*/ 0, /*downs*/ 3);
  // Refresh bench caches now that scores exist (mirrors the
  // post-submission path).
  await t.run(async (ctx) => {
    for (const id of [bA, bB, bC]) {
      await ctx.runMutation(internal.cache.recomputeBenchAggregates, {
        benchId: id,
      });
    }
  });
  return { u, u2, bA, bB, bC, m1, m2, m3, m4 };
}

async function readRankings(t: ReturnType<typeof setupTestDb>) {
  return await t.run(async (ctx) => {
    return await ctx.db.query("modelRankings").collect();
  });
}

async function readFamilyRankings(t: ReturnType<typeof setupTestDb>) {
  return await t.run(async (ctx) => {
    return await ctx.db.query("familyRankings").collect();
  });
}

// Map all Convex modelScores → the D1 wire format. The compute
// kernel is shape-agnostic so this is the *only* translation
// the worker round-trip is responsible for; this helper is what
// the stubbed `fetch` returns in the equivalence test.
async function dumpScoresAsD1Rows(t: ReturnType<typeof setupTestDb>) {
  return await t.run(async (ctx) => {
    const all = await ctx.db.query("modelScores").collect();
    return all.map((s) => ({
      convex_id: s._id as string,
      modelId: s.modelId as string,
      benchId: s.benchId as string,
      rawScore: s.rawScore,
      normalizedScore: s.normalizedScore,
      sourceUrl: s.sourceUrl,
      accessedAt: s.accessedAt,
      submittedBy: s.submittedBy as string,
      createdAt: s.createdAt,
      upvotes: s.upvotes,
      downvotes: s.downvotes,
      submitterName: s.submitterName ?? null,
      submitterImage: s.submitterImage ?? null,
    }));
  });
}

// ─── 1. ROUND-TRIP EQUIVALENCE ─────────────────────────────

describe("D1 driver produces identical rankings to Convex driver", () => {
  it("model rankings match across both drivers", async () => {
    const t = setupTestDb();
    await seedEcosystem(t);

    // Path A: legacy mutation (reads scores from Convex db).
    await t.mutation(internal.rankings.recomputeAll, {});
    const fromConvex = (await readRankings(t)).map((r) => ({
      modelId: r.modelId,
      name: r.name,
      supraScore: r.supraScore,
      benchCount: r.benchCount,
      hidden: r.hidden ?? false,
    }));

    // Reset rankings so path B can't accidentally pass on stale rows.
    await t.run(async (ctx) => {
      const all = await ctx.db.query("modelRankings").collect();
      for (const r of all) await ctx.db.delete(r._id);
    });

    // Path B: D1-action driver, with `fetch` stubbed to replay
    // the same scores back. We capture every fetch call so the
    // protocol assertions in the next describe block can also
    // inspect it without re-mocking.
    const d1Rows = await dumpScoresAsD1Rows(t);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        const u = new URL(url);
        if (u.pathname === "/scores" && (init?.method ?? "GET") === "GET") {
          return new Response(JSON.stringify({ scores: d1Rows }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        // The action shouldn't POST/DELETE anything during a
        // pure read-and-rebuild — fail loudly if it does.
        throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
      })
    );

    await t.action(internal.rankings.recomputeFromD1, {});

    const fromD1 = (await readRankings(t)).map((r) => ({
      modelId: r.modelId,
      name: r.name,
      supraScore: r.supraScore,
      benchCount: r.benchCount,
      hidden: r.hidden ?? false,
    }));

    // Sort both by modelId for a stable comparison; the rankings
    // table doesn't preserve insert order.
    fromConvex.sort((a, b) => String(a.modelId).localeCompare(String(b.modelId)));
    fromD1.sort((a, b) => String(a.modelId).localeCompare(String(b.modelId)));

    expect(fromD1).toEqual(fromConvex);
  });

  it("family rankings match across both drivers", async () => {
    const t = setupTestDb();
    await seedEcosystem(t);

    await t.mutation(internal.rankings.recomputeAll, {});
    const familiesFromConvex = (await readFamilyRankings(t)).map((r) => ({
      familyTag: r.familyTag,
      provider: r.provider,
      supraScore: r.supraScore,
      benchCount: r.benchCount,
      modelCount: r.modelCount,
    }));

    await t.run(async (ctx) => {
      for (const r of await ctx.db.query("modelRankings").collect()) {
        await ctx.db.delete(r._id);
      }
      for (const r of await ctx.db.query("familyRankings").collect()) {
        await ctx.db.delete(r._id);
      }
    });

    const d1Rows = await dumpScoresAsD1Rows(t);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ scores: d1Rows }), { status: 200 })
      )
    );

    await t.action(internal.rankings.recomputeFromD1, {});
    const familiesFromD1 = (await readFamilyRankings(t)).map((r) => ({
      familyTag: r.familyTag,
      provider: r.provider,
      supraScore: r.supraScore,
      benchCount: r.benchCount,
      modelCount: r.modelCount,
    }));

    const sortKey = (r: { familyTag: string; provider: string }) =>
      `${r.familyTag}\u0000${r.provider}`;
    familiesFromConvex.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    familiesFromD1.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

    expect(familiesFromD1).toEqual(familiesFromConvex);
  });

  it("downvoted scores are excluded by both drivers", async () => {
    // Specifically guards the validity check (upvotes > downvotes).
    // The seed ecosystem includes a m2/bB row at value 99 with
    // 0/3 votes; if either driver counts it, m2's supraScore and
    // benchCount will diverge from the other.
    const t = setupTestDb();
    const { m2 } = await seedEcosystem(t);

    await t.mutation(internal.rankings.recomputeAll, {});
    const m2Convex = (await readRankings(t)).find(
      (r) => String(r.modelId) === String(m2)
    )!;

    await t.run(async (ctx) => {
      for (const r of await ctx.db.query("modelRankings").collect()) {
        await ctx.db.delete(r._id);
      }
    });

    const d1Rows = await dumpScoresAsD1Rows(t);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ scores: d1Rows }), { status: 200 })
      )
    );
    await t.action(internal.rankings.recomputeFromD1, {});
    const m2D1 = (await readRankings(t)).find(
      (r) => String(r.modelId) === String(m2)
    )!;

    expect(m2D1.benchCount).toBe(m2Convex.benchCount);
    // m2 has only ONE valid score (m2/bA) — the bB row is downvoted.
    expect(m2D1.benchCount).toBe(1);
  });
});

// ─── 2. MIRROR PROTOCOL ────────────────────────────────────

describe("mirrorScoreById POSTs the worker contract correctly", () => {
  it("sends bearer secret + correct body shape", async () => {
    const t = setupTestDb();
    const u = await newUser(t, "mirror-fixture");
    const b = await newBench(t, u, "Mirror Bench");
    const m = await newModel(t, u, "Mirror Model");
    const sId = await newScore(t, u, m, b, 77);

    // Capture every fetch invocation. The action issues exactly
    // ONE POST /scores; nothing else should hit the wire.
    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({ ok: true, convex_id: sId }),
          { status: 200 }
        );
      })
    );

    await t.action(internal.scoresWorker.mirrorScoreById, { id: sId });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${TEST_WORKER_URL}/scores`);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.authorization).toBe(
      `Bearer ${TEST_WORKER_SECRET}`
    );
    expect(calls[0].init.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(calls[0].init.body as string);
    // All required fields the D1 schema expects must be present
    // and round-trippable. Missing any of these would cause the
    // worker to reject the row with HTTP 400.
    expect(body.convex_id).toBe(sId);
    expect(body.modelId).toBe(m);
    expect(body.benchId).toBe(b);
    expect(body.rawScore).toBe(77);
    expect(body.normalizedScore).toBe(77);
    expect(body.upvotes).toBe(1);
    expect(body.downvotes).toBe(0);
    expect(typeof body.createdAt).toBe("number");
    expect(typeof body.accessedAt).toBe("number");
    expect(body.submittedBy).toBe(u);
  });

  it("mirrorScoresAndRebuild bulk-uploads then schedules the rebuild", async () => {
    const t = setupTestDb();
    const u = await newUser(t, "bulk-fixture");
    const b = await newBench(t, u, "Bulk Bench");
    const m = await newModel(t, u, "Bulk Model");
    const ids = [
      await newScore(t, u, m, b, 60),
      await newScore(t, u, m, b, 70),
      await newScore(t, u, m, b, 80),
    ];

    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        calls.push({ url, init });
        // /scores/bulk responds with { ok, count }; /scores
        // (GET) needs to return the seeded rows so the chained
        // recomputeFromD1 can complete cleanly.
        if (url.endsWith("/scores/bulk") && init?.method === "POST") {
          return new Response(JSON.stringify({ ok: true, count: 3 }), {
            status: 200,
          });
        }
        if (url.endsWith("/scores") && (init?.method ?? "GET") === "GET") {
          const rows = await dumpScoresAsD1Rows(t);
          return new Response(JSON.stringify({ scores: rows }), {
            status: 200,
          });
        }
        throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
      })
    );

    await t.action(internal.scoresWorker.mirrorScoresAndRebuild, {
      scoreIds: ids,
    });
    // Drain the chained recomputeFromD1 the action schedules,
    // otherwise it fires after the test ends and raises a
    // "Write outside of transaction" unhandled rejection.
    // The whole chain (rebuild → persist mutation) has already
    // been covered by the equivalence suite above; here we only
    // care that the *bulk POST* shape is right, but we still need
    // to wait so the scheduler queue is empty at teardown.
    await new Promise((r) => setTimeout(r, 20));
    await t.finishAllScheduledFunctions(() => {});

    // The bulk path must batch — one POST /scores/bulk, not three
    // POST /scores calls. Otherwise we lose D1 batch atomicity AND
    // pay 3× the worker requests for no reason.
    const bulkCalls = calls.filter(
      (c) => c.url.endsWith("/scores/bulk") && c.init.method === "POST"
    );
    const singleCalls = calls.filter(
      (c) => c.url === `${TEST_WORKER_URL}/scores` && c.init.method === "POST"
    );
    expect(bulkCalls).toHaveLength(1);
    expect(singleCalls).toHaveLength(0);

    const body = JSON.parse(bulkCalls[0].init.body as string);
    expect(body.scores).toHaveLength(3);
    expect(body.scores.map((s: any) => s.convex_id).sort()).toEqual(
      [...ids].sort()
    );
  });
});

// ─── 3. WORKER FAILURE MODES ───────────────────────────────

describe("worker failures surface as errors so the scheduler retries", () => {
  it("mirrorScoreById throws on non-2xx response", async () => {
    const t = setupTestDb();
    const u = await newUser(t, "failmode");
    const b = await newBench(t, u, "Fail Bench");
    const m = await newModel(t, u, "Fail Model");
    const sId = await newScore(t, u, m, b, 50);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("internal server error", { status: 500 })
      )
    );

    await expect(
      t.action(internal.scoresWorker.mirrorScoreById, { id: sId })
    ).rejects.toThrow(/POST \/scores failed 500/);
  });

  it("recomputeFromD1 throws on worker failure", async () => {
    const t = setupTestDb();
    await seedEcosystem(t);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("d1 unavailable", { status: 503 })
      )
    );

    await expect(
      t.action(internal.rankings.recomputeFromD1, {})
    ).rejects.toThrow(/GET \/scores failed 503/);
  });

  it("missing env vars surface a helpful error, not a network failure", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("SCORES_WORKER_URL", "");
    vi.stubEnv("SCORES_WORKER_SECRET", "");

    const t = setupTestDb();
    await expect(
      t.action(internal.rankings.recomputeFromD1, {})
    ).rejects.toThrow(/SCORES_WORKER_URL/);
  });
});
