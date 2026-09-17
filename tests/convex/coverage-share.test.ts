// ════════════════════════════════════════════════════════════
// SupraScore end-to-end tests (model side AND bench side).
//
// Each test seeds a tiny dataset, calls the real
// internal.rankings.recomputeAll, then reads the resulting
// modelRankings rows OR the benches.listRanked public query.
//
//   per-bench:  effectiveWeight(b) = Q·D·H · (u_b / U*)      (Bench Score)
//   per-model:  pairwise duels on every bench → one regularized
//               Bradley-Terry fit → expected win rate vs the top-10 field
//               (public/js/supra-rank-core.js)
//
// Scenarios covered:
//   1. Same benches for everyone → order follows the duel record.
//   2. Sparse vs broad: a one-bench entry that loses its only duel cannot
//      outrank the broad model; and at realistic field size a one-bench
//      winner cannot take #1 from broadly tested models.
//   3. Untested is not negative evidence: a bench only one model ran
//      produces no duel and moves nobody.
//   4. Vanity-bench leaderboard attack (bench side, u_b/U*).
//   5. Vanity-bench SupraScore attack (model side).
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
// purely the upvote-share, not the underlying Q score.
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

describe("SupraScore pairwise formula", () => {
  it("same benches for everyone: order follows the duel record", async () => {
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
    // Scores are expected win rates against the field, so they are strictly
    // ordered, stay inside (0, 100) and are symmetric around the middle model.
    expect(rows[0].supraScore).toBeGreaterThan(rows[1].supraScore);
    expect(rows[1].supraScore).toBeGreaterThan(rows[2].supraScore);
    expect(rows[1].supraScore).toBeCloseTo(50, 0);
    expect(rows[0].supraScore + rows[2].supraScore).toBeCloseTo(100, 0);
  });

  it("scale does not matter: 5 % can lead a bench just like 95 %", async () => {
    const t = setupTestDb();
    const u = await seedServiceUser(t);
    const hard = await seedBench(t, u, "Hard Bench");
    const easy = await seedBench(t, u, "Easy Bench");
    const a = await seedModel(t, u, "WinsHard");
    const b = await seedModel(t, u, "WinsEasy");
    // A leads the hard bench with tiny numbers; B leads the easy bench with
    // huge numbers. A raw-percentage mean would crown B (95/2 vs 9/2).
    await seedScore(t, u, a, hard, 5);
    await seedScore(t, u, b, hard, 2);
    await seedScore(t, u, a, easy, 90);
    await seedScore(t, u, b, easy, 95);

    await recompute(t);
    const rows = await readRankings(t);
    const rowA = rows.find((r) => r.name === "WinsHard")!;
    const rowB = rows.find((r) => r.name === "WinsEasy")!;
    // One win each on equally weighted benches → a tie, not a rout.
    expect(rowA.supraScore).toBeCloseTo(rowB.supraScore, 0);
  });

  it("sparse entry that loses its only duel cannot outrank the broad model", async () => {
    const t = setupTestDb();
    const u = await seedServiceUser(t);
    const bA = await seedBench(t, u, "Bench A");
    const bB = await seedBench(t, u, "Bench B");
    const bC = await seedBench(t, u, "Bench C");
    const sonnet = await seedModel(t, u, "Sparse Sonnet");
    await seedScore(t, u, sonnet, bA, 97.7);
    const broad = await seedModel(t, u, "Broad GPT");
    await seedScore(t, u, broad, bA, 97.9);
    await seedScore(t, u, broad, bB, 88);
    await seedScore(t, u, broad, bC, 85);

    await recompute(t);
    const rows = (await readRankings(t)).sort(
      (a, b) => b.supraScore - a.supraScore
    );
    expect(rows[0].name).toBe("Broad GPT");
  });

  it("one-bench winner cannot take #1 from a broadly tested field", async () => {
    // Twelve models on six benches, strictly ordered. A newcomer posts a
    // perfect score on exactly one bench. It beats everyone there, but the
    // regularized fit keeps a single result from outranking models that
    // won across the board.
    const t = setupTestDb();
    const u = await seedServiceUser(t);
    const benches = [];
    for (let i = 0; i < 6; i++) benches.push(await seedBench(t, u, `Field Bench ${i}`));
    for (let m = 0; m < 12; m++) {
      const id = await seedModel(t, u, `Field Model ${String(m).padStart(2, "0")}`);
      for (const b of benches) await seedScore(t, u, id, b, 90 - m * 5);
    }
    const peak = await seedModel(t, u, "One Bench Peak");
    await seedScore(t, u, peak, benches[0], 100);

    await recompute(t);
    const rows = (await readRankings(t)).sort(
      (a, b) => b.supraScore - a.supraScore
    );
    expect(rows[0].name).toBe("Field Model 00");
    expect(rows.findIndex((r) => r.name === "One Bench Peak")).toBeGreaterThan(0);
  });

  it("untested is not negative evidence: a solo bench moves nobody", async () => {
    const t = setupTestDb();
    const u = await seedServiceUser(t);
    const b1 = await seedBench(t, u, "b1");
    const b2 = await seedBench(t, u, "b2");
    const leader = await seedModel(t, u, "LeadModel");
    const follower = await seedModel(t, u, "FollowerModel");
    await seedScore(t, u, leader, b1, 80);
    await seedScore(t, u, follower, b1, 80);

    await recompute(t);
    const before = await readRankings(t);
    // Leader now also runs a bench nobody else has touched: no duel exists
    // there, so neither model's score may change.
    await seedScore(t, u, leader, b2, 80);
    await recompute(t);
    const after = await readRankings(t);
    for (const name of ["LeadModel", "FollowerModel"]) {
      expect(after.find((r) => r.name === name)!.supraScore).toBe(
        before.find((r) => r.name === name)!.supraScore
      );
    }
    expect(after.find((r) => r.name === "LeadModel")!.benchCount).toBe(2);
  });

  it("Vanity-bench leaderboard attack: 1-upvote bench cannot outrank a 6-upvote bench at equal Q·D·H", async () => {
    // The Bench Leaderboard (benches.listRanked) is what users land on
    // when browsing the catalog. Without the bench-side u_b/U*
    // multiplier, an attacker can mint a bench, self-rate it 5/5/5/5,
    // and immediately appear at #1 with a Q·D·H product of 100. With
    // the shrinkage in place, that bench's *displayed* effective
    // weight is multiplied by 1 / U* where U* is the legit
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
    // Legit is the top-upvoted bench → trust factor 1 → no penalty.
    expect(legitRow.effectiveWeight).toBeCloseTo(legitRow.rawWeight, 0);
    // Vanity has 1/6 upvote share → factor 1/6 → ~16.7.
    expect(vanityRow.effectiveWeight).toBeLessThan(20);
    expect(vanityRow.effectiveWeight).toBeGreaterThan(15);
  });

  it("Vanity-bench SupraScore attack: cannot vault a model past a well-covered competitor", async () => {
    // Same shape as the leaderboard test, but verifying the attack
    // also fails in the SupraScore path. Attacker model has only
    // scores on its own vanity bench; legit model has scores on a
    // well-upvoted bench. Even though both raw weights are 100, the
    // bench-side u_b/U* shrinks the vanity bench's ability weight,
    // and evidence confidence keeps the single-bench estimate from
    // being treated as a full-strength 100.
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
    const otherLegit = await seedModel(t, creatorLegit, "OtherLegitModel");
    await seedScore(t, creatorLegit, otherLegit, legitBench, 60);
    await seedScore(t, creatorAttacker, attackerModel, vanityBench, 100);

    await recompute(t);
    const rows = (await readRankings(t)).sort(
      (a, b) => b.supraScore - a.supraScore
    );
    expect(rows[0].name).toBe("LegitModel");
    const attackerRow = rows.find((r) => r.name === "AttackerModel")!;
    // The attacker is alone on its vanity bench, so that bench produces no
    // duel at all: a self-reported 100 there is worth nothing.
    expect(attackerRow.supraScore).toBeLessThanOrEqual(
      rows.find((r) => r.name === "LegitModel")!.supraScore
    );
  });
});
