// ════════════════════════════════════════════════════════════
// SupraScore coverage-share formula tests.
//
// Verifies that `supraScore = weightedMean × √(totalWeight / maxTotalWeight)`
// actually holds end-to-end against a live (mock) Convex runtime. Each
// test seeds a tiny dataset, calls the real internal.rankings.recomputeAll,
// then reads the resulting modelRankings rows.
//
// Scenarios covered:
//   1. Equal-coverage: all models tested on same benches → coverage
//      factor is 1 for everyone → ranking === order by weightedMean.
//      (Smoke-test that the old behaviour still holds when there's no
//       coverage asymmetry.)
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
// ════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { setupTestDb, internal } from "./_fixtures";

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
