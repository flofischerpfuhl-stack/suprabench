// ════════════════════════════════════════════════════════════
// Coverage-share formula tests (model side AND bench side).
//
// Verifies that
//   per-bench:  effectiveWeight(b) = Q·D·H · √(u_b / U*)
//   per-model:  supraScore(m)      = weightedMean(m) · √(W_m / W*)
// holds end-to-end against a live (mock) Convex runtime. Each test
// seeds a tiny dataset, calls the real internal.rankings.recomputeAll,
// then reads the resulting modelRankings rows OR the benches.listRanked
// public query.
//
// Scenarios covered:
//   1. Equal-coverage: all models tested on same benches → coverage
//      factor is 1 for everyone → ranking === order by weightedMean.
//
//   2. Sonnet-style sparse vs broad: a 1-bench model with top raw score
//      on that bench gets dropped below a 3-bench model with a lower
//      per-bench peak but broader coverage.
//
//   3. Top-covered model gets √factor = 1 (no self-penalty).
//
//   4. Adding a bench to the leading model bumps maxTotalWeight and
//      therefore reduces every other model's supraScore (IIA is
//      intentionally violated).
//
//   5. Vanity-bench leaderboard attack: a brand-new self-rated bench
//      with one creator upvote MUST NOT show up at #1 on the bench
//      leaderboard against an established bench with many community
//      upvotes — even if its raw Q·D·H is 100.
//
//   6. Vanity-bench SupraScore attack: same vanity bench can't be
//      used to vault an attacker model past a well-covered legit
//      model, because its bench-side √(u_b/U*) shrinkage caps its
//      contribution to the model's W_m and weightedMean.
// ════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { api, internal, setupTestDb } from "./_fixtures";

async function seedServiceUser(t: ReturnType<typeof setupTestDb>) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name: "coverage-share-fixture",
      email: "coverage-share@test.internal",
    } as any);
  });
}

async function seedBench(
  t: ReturnType<typeof setupTestDb>,
  userId: any,
  name: string
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("benches", {
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-"),
      description: `bench for ${name}`,
      url: `https://arxiv.org/abs/9999.${Math.floor(Math.random() * 99999)}`,
      isOfficial: true,
      tags: [],
      scaleMin: 0,
      scaleMax: 100,
      addedBy: userId,
      createdAt: Date.now(),
    });
  });
}

async function seedModel(
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

async function seedScore(
  t: ReturnType<typeof setupTestDb>,
  userId: any,
  modelId: any,
  benchId: any,
  value: number
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("modelScores", {
      modelId,
      benchId,
      rawScore: value,
      normalizedScore: value,
      sourceUrl: "https://example.com",
      accessedAt: Date.now(),
      submittedBy: userId,
      createdAt: Date.now(),
      upvotes: 1,
      downvotes: 0,
      submitterName: "coverage-share-fixture",
    });
  });
}

async function recompute(t: ReturnType<typeof setupTestDb>) {
  await t.mutation(internal.rankings.recomputeAll, {});
}

async function readRankings(t: ReturnType<typeof setupTestDb>) {
  return await t.run(async (ctx) => {
    return await ctx.db.query("modelRankings").collect();
  });
}

async function seedExtraUser(
  t: ReturnType<typeof setupTestDb>,
  name: string
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name,
      email: `${name}@coverage-share.test`,
    } as any);
  });
}

// Insert N upvotes onto a bench AND keep cachedNetUpvotes in sync —
// mirrors what entityVotes.cast → recomputeBenchNetUpvotesInline does
// in the production flow. Used to simulate "this bench has N distinct
// community endorsements". Pass `creator` so we record one of those
// votes as the auto-seeded creator vote.
async function seedBenchUpvotes(
  t: ReturnType<typeof setupTestDb>,
  benchId: any,
  voterIds: any[]
) {
  await t.run(async (ctx) => {
    for (const userId of voterIds) {
      await ctx.db.insert("entityVotes", {
        entityType: "bench",
        entityId: benchId as string,
        userId,
        value: 1,
      });
    }
    const all = await ctx.db
      .query("entityVotes")
      .withIndex("by_entity", (q: any) =>
        q.eq("entityType", "bench").eq("entityId", benchId as string)
      )
      .collect();
    let net = 0;
    for (const v of all) net += v.value;
    await ctx.db.patch(benchId, {
      cachedNetUpvotes: Math.max(0, net),
    });
  });
}

// Self-rate a bench 5/5/5/5/5 from one user — used by both legit and
// vanity benches in the leaderboard test so the differentiator is
// purely the upvote-coverage-share, not the underlying Q score.
async function seedBenchRating(
  t: ReturnType<typeof setupTestDb>,
  benchId: any,
  userId: any,
  vals: {
    relevance?: number;
    contamination?: number;
    discriminability?: number;
    reproducibility?: number;
    difficulty?: number;
  } = {}
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("benchQualityRatings", {
      benchId,
      userId,
      relevance: vals.relevance ?? 5,
      contamination: vals.contamination ?? 5,
      discriminability: vals.discriminability ?? 5,
      reproducibility: vals.reproducibility ?? 5,
      difficulty: vals.difficulty ?? 5,
    });
  });
}

// Run the same recompute that entityVotes/score mutations schedule.
// Without this the listRanked fallback path uses qualityScore (live
// computed from ratings) which is fine for our tests, but the model
// ranking path needs the cached Q·D·H to be present.
async function refreshBenchAggregates(
  t: ReturnType<typeof setupTestDb>,
  benchId: any
) {
  await t.mutation(internal.cache.recomputeBenchAggregates, { benchId });
}

describe("SupraScore coverage-share formula", () => {
  it("C5 all-equal-coverage: ranking follows weightedMean", async () => {
    const t = setupTestDb();
    const u = await seedServiceUser(t);
    const b = await seedBench(t, u, "Equal Bench");
    const mHigh = await seedModel(t, u, "HighModel");
    const mMid = await seedModel(t, u, "MidModel");
    const mLow = await seedModel(t, u, "LowModel");
    await seedScore(t, u, mHigh, b, 90);
    await seedScore(t, u, mMid, b, 70);
    await seedScore(t, u, mLow, b, 50);

    await recompute(t);
    const rows = (await readRankings(t)).sort(
      (a, b) => b.supraScore - a.supraScore
    );
    expect(rows.map((r) => r.name)).toEqual(["HighModel", "MidModel", "LowModel"]);
    // All three have the same totalWeight (1 bench each) so share=1
    // and supraScore === weightedMean === raw score.
    expect(rows[0].supraScore).toBeCloseTo(90, 0);
    expect(rows[1].supraScore).toBeCloseTo(70, 0);
    expect(rows[2].supraScore).toBeCloseTo(50, 0);
  });

  it("Sonnet regression: 1-bench peak loses to 3-bench broad coverage", async () => {
    const t = setupTestDb();
    const u = await seedServiceUser(t);
    const bA = await seedBench(t, u, "Bench A");
    const bB = await seedBench(t, u, "Bench B");
    const bC = await seedBench(t, u, "Bench C");
    // Sparse: one bench, very high score
    const sonnet = await seedModel(t, u, "Sparse Sonnet");
    await seedScore(t, u, sonnet, bA, 97.7);
    // Broad: three benches, moderate scores — always tested, never top
    const broad = await seedModel(t, u, "Broad GPT");
    await seedScore(t, u, broad, bA, 97.9);
    await seedScore(t, u, broad, bB, 88);
    await seedScore(t, u, broad, bC, 85);

    await recompute(t);
    const rows = (await readRankings(t)).sort(
      (a, b) => b.supraScore - a.supraScore
    );
    expect(rows[0].name).toBe("Broad GPT");
    // Sparse should be demoted substantially (score cut by roughly √(1/3))
    const sparseRow = rows.find((r) => r.name === "Sparse Sonnet")!;
    expect(sparseRow.supraScore).toBeLessThan(80);
    // And the broad model keeps its full weightedMean because it's the
    // top-covered → no self-penalty.
    const broadRow = rows.find((r) => r.name === "Broad GPT")!;
    expect(broadRow.supraScore).toBeGreaterThanOrEqual(85);
  });

  it("Top-covered model has coverage factor of 1 (no self-penalty)", async () => {
    const t = setupTestDb();
    const u = await seedServiceUser(t);
    const b1 = await seedBench(t, u, "b1");
    const b2 = await seedBench(t, u, "b2");
    const leader = await seedModel(t, u, "LeadModel");
    const follower = await seedModel(t, u, "FollowerModel");
    // Leader tested twice, follower once
    await seedScore(t, u, leader, b1, 80);
    await seedScore(t, u, leader, b2, 80);
    await seedScore(t, u, follower, b1, 80);

    await recompute(t);
    const rows = await readRankings(t);
    const leaderRow = rows.find((r) => r.name === "LeadModel")!;
    // Leader's supraScore equals its weightedMean (80) within rounding
    expect(leaderRow.supraScore).toBeCloseTo(80, 0);
    // Follower shrunk by √(1/2) ≈ 0.707 → ~56.6
    const followerRow = rows.find((r) => r.name === "FollowerModel")!;
    expect(followerRow.supraScore).toBeGreaterThan(50);
    expect(followerRow.supraScore).toBeLessThan(70);
  });

  it("Vanity-bench leaderboard attack: 1-upvote bench cannot outrank a 6-upvote bench at equal Q·D·H", async () => {
    // The Bench Leaderboard (benches.listRanked) is what users land on
    // when browsing the catalog. Without the bench-side √(u_b/U*)
    // shrinkage, an attacker can mint a bench, self-rate it 5/5/5/5,
    // and immediately appear at #1 with a Q·D·H product of 100. With
    // the shrinkage in place, that bench's *displayed* effective
    // weight is multiplied by √(1 / U*) where U* is the legit
    // leader's upvote count.
    const t = setupTestDb();
    const creatorLegit = await seedServiceUser(t);
    const creatorAttacker = await seedExtraUser(t, "attacker");
    const voters = [
      await seedExtraUser(t, "voter1"),
      await seedExtraUser(t, "voter2"),
      await seedExtraUser(t, "voter3"),
      await seedExtraUser(t, "voter4"),
      await seedExtraUser(t, "voter5"),
    ];

    const legitBench = await seedBench(t, creatorLegit, "Legit Bench");
    const vanityBench = await seedBench(t, creatorAttacker, "Vanity Bench");

    // Both benches: identical 5/5/5/5/5 self-rating → Q=100, D=1.0,
    // H=1.0 (no models scored). Raw effectiveWeight = 100 in both.
    await seedBenchRating(t, legitBench, creatorLegit);
    await seedBenchRating(t, vanityBench, creatorAttacker);

    // Auto-seed creator votes (production path runs this from the
    // create() mutation; the in-memory test bypasses it).
    await seedBenchUpvotes(t, legitBench, [creatorLegit, ...voters]);
    await seedBenchUpvotes(t, vanityBench, [creatorAttacker]);

    await refreshBenchAggregates(t, legitBench);
    await refreshBenchAggregates(t, vanityBench);

    const list = await t.query(api.benches.listRanked, {});
    expect(list[0].name).toBe("Legit Bench");
    const vanityRow = list.find((b) => b.name === "Vanity Bench")!;
    const legitRow = list.find((b) => b.name === "Legit Bench")!;
    // Legit is the top-upvoted bench → coverage factor 1 → no penalty.
    expect(legitRow.effectiveWeight).toBeCloseTo(legitRow.rawWeight, 0);
    // Vanity has 1/6 upvote share → factor √(1/6) ≈ 0.408 → ~40.8.
    expect(vanityRow.effectiveWeight).toBeLessThan(50);
    expect(vanityRow.effectiveWeight).toBeGreaterThan(35);
  });

  it("Vanity-bench SupraScore attack: cannot vault a model past a well-covered competitor", async () => {
    // Same shape as the leaderboard test, but verifying the attack
    // also fails in the SupraScore path. Attacker model has only
    // scores on its own vanity bench; legit model has scores on a
    // well-upvoted bench. Even though both raw weights are 100, the
    // bench-side √(u_b/U*) shrinks the vanity bench's contribution
    // to the attacker's W_m, and the model-side √(W_m/W*) compounds
    // the penalty.
    const t = setupTestDb();
    const creatorLegit = await seedServiceUser(t);
    const creatorAttacker = await seedExtraUser(t, "attacker2");
    const voters = [
      await seedExtraUser(t, "v2-1"),
      await seedExtraUser(t, "v2-2"),
      await seedExtraUser(t, "v2-3"),
      await seedExtraUser(t, "v2-4"),
      await seedExtraUser(t, "v2-5"),
    ];

    const legitBench = await seedBench(t, creatorLegit, "Established");
    const vanityBench = await seedBench(t, creatorAttacker, "Vanity");
    await seedBenchRating(t, legitBench, creatorLegit);
    await seedBenchRating(t, vanityBench, creatorAttacker);
    await seedBenchUpvotes(t, legitBench, [creatorLegit, ...voters]);
    await seedBenchUpvotes(t, vanityBench, [creatorAttacker]);
    await refreshBenchAggregates(t, legitBench);
    await refreshBenchAggregates(t, vanityBench);

    const legitModel = await seedModel(t, creatorLegit, "LegitModel");
    const attackerModel = await seedModel(t, creatorAttacker, "AttackerModel");
    // Legit gets 80 on the established bench. Attacker self-reports
    // a perfect 100 on its own vanity bench.
    await seedScore(t, creatorLegit, legitModel, legitBench, 80);
    await seedScore(t, creatorAttacker, attackerModel, vanityBench, 100);

    await recompute(t);
    const rows = (await readRankings(t)).sort(
      (a, b) => b.supraScore - a.supraScore
    );
    expect(rows[0].name).toBe("LegitModel");
    const attackerRow = rows.find((r) => r.name === "AttackerModel")!;
    // Vanity bench's raw 100 contributes only 100·√(1/6)≈40.8 of
    // weight, AND attacker's W_m is below the legit model's, so the
    // outer model-side √-share drags the score even lower.
    expect(attackerRow.supraScore).toBeLessThan(80);
  });

  it("IIA: adding a bench to the leader reduces every other model's score", async () => {
    const t = setupTestDb();
    const u = await seedServiceUser(t);
    const b1 = await seedBench(t, u, "shared");
    const b2 = await seedBench(t, u, "b2-leader-only");
    const b3 = await seedBench(t, u, "b3-leader-only");
    const leader = await seedModel(t, u, "Leader");
    const peer = await seedModel(t, u, "Peer");
    await seedScore(t, u, leader, b1, 80);
    await seedScore(t, u, leader, b2, 80);
    await seedScore(t, u, peer, b1, 90);

    await recompute(t);
    const peerBefore = (await readRankings(t)).find((r) => r.name === "Peer")!
      .supraScore;

    // Add a third bench only to the leader → maxTotalWeight grows
    await seedScore(t, u, leader, b3, 80);
    await recompute(t);
    const peerAfter = (await readRankings(t)).find((r) => r.name === "Peer")!
      .supraScore;

    // Peer was tested on 1/2 then 1/3 of the bench-weight after the
    // leader's expansion → peerAfter must be strictly lower.
    expect(peerAfter).toBeLessThan(peerBefore);
  });
});
