import { describe, expect, it } from "vitest";
import { internal, setupTestDb } from "./_fixtures";
import {
  buildPairwiseFamilyRankings,
  FAMILY_REPRESENTATIVE_MIN_BENCHES,
} from "../../convex/rankings";
import {
  bootstrapPairedValidationDifference,
  buildFamilyAggregateSnapshot,
  buildPairwiseRanking,
} from "../../scripts/lib/pairwise-ranking.mjs";

describe("opponent-adjusted family ceiling", () => {
  it("lets a community-endorsed new benchmark outweigh an old one-vote benchmark", () => {
    const models = [
      { _id: "old-winner", name: "Old winner", provider: "A", familyTag: "Old winner" },
      { _id: "new-winner", name: "New winner", provider: "B", familyTag: "New winner" },
    ];
    const bench = (id: string, cachedNetUpvotes: number) => ({
      _id: id,
      hidden: false,
      cachedHeadroom: 1,
      cachedNetUpvotes,
      cachedRaterCount: 10,
      cachedDimensions: {
        relevance: 5,
        contamination: 5,
        discriminability: 5,
        reproducibility: 5,
        difficulty: 5,
      },
    });
    const score = (modelId: string, benchId: string, normalizedScore: number) => ({
      modelId,
      benchId,
      normalizedScore,
      upvotes: 1,
      downvotes: 0,
    });
    const scores = [
      score("old-winner", "old", 90),
      score("new-winner", "old", 80),
      score("old-winner", "new", 80),
      score("new-winner", "new", 90),
    ];

    const oldConsensus = buildPairwiseFamilyRankings({
      models,
      benches: [bench("old", 10), bench("new", 1)],
      scores,
    }).rows.sort((left, right) => right.supraScore - left.supraScore);
    const newConsensus = buildPairwiseFamilyRankings({
      models,
      benches: [bench("old", 1), bench("new", 10)],
      scores,
    }).rows.sort((left, right) => right.supraScore - left.supraScore);

    expect(oldConsensus[0].familyTag).toBe("Old winner");
    expect(newConsensus[0].familyTag).toBe("New winner");
  });

  it("bootstraps held-out benchmark differences as paired samples", () => {
    const candidate = {
      runs: [
        { benchId: "one", accuracy: 0.8, heldOutQuality: 1 },
        { benchId: "two", accuracy: 0.6, heldOutQuality: 1 },
      ],
    };
    const baseline = {
      runs: [
        { benchId: "one", accuracy: 0.7, heldOutQuality: 1 },
        { benchId: "two", accuracy: 0.4, heldOutQuality: 1 },
      ],
    };
    const result = bootstrapPairedValidationDifference(candidate, baseline, {
      samples: 1_000,
      seed: 7,
    });
    expect(result.difference).toBeCloseTo(0.15);
    expect(result.interval95[0]).toBeGreaterThan(0);
    expect(result.positiveRate).toBe(1);
  });

  it("uses the best configuration per benchmark without changing concrete rows", () => {
    const models = [
      { _id: "a1", name: "Alpha (high)", provider: "A", familyTag: "Alpha" },
      { _id: "a2", name: "Alpha (max)", provider: "A", familyTag: "Alpha" },
      { _id: "b1", name: "Beta", provider: "B", familyTag: "Beta" },
    ];
    const benches = ["one", "two", "three"].map((id) => ({
      _id: id,
      hidden: false,
      cachedHeadroom: 1,
      cachedNetUpvotes: 1,
      cachedRaterCount: 1,
      cachedDimensions: {
        relevance: 5,
        contamination: 5,
        discriminability: 5,
        reproducibility: 5,
        difficulty: 5,
      },
    }));
    const score = (modelId: string, benchId: string, normalizedScore: number) => ({
      modelId,
      benchId,
      normalizedScore,
      upvotes: 1,
      downvotes: 0,
    });
    const scores = [
      score("a1", "one", 90),
      score("a1", "two", 10),
      score("a2", "one", 20),
      score("a2", "two", 90),
      score("a2", "three", 90),
      score("b1", "one", 80),
      score("b1", "two", 80),
      score("b1", "three", 80),
    ];

    const result = buildPairwiseFamilyRankings({ models, benches, scores });
    const alpha = result.rows.find((row) => row.familyTag === "Alpha")!;
    const beta = result.rows.find((row) => row.familyTag === "Beta")!;
    expect(alpha.benchCount).toBe(3);
    expect(alpha.supraScore).toBeGreaterThan(beta.supraScore);
    expect(result.ceilingScores.filter((row) => row.familyTag === "Alpha"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ benchId: "one", score: 90 }),
        expect.objectContaining({ benchId: "two", score: 90 }),
        expect.objectContaining({ benchId: "three", score: 90 }),
      ]));
    expect(scores.find((row) => row.modelId === "a1" && row.benchId === "two")?.normalizedScore)
      .toBe(10);
  });

  it("keeps the production Newton solver in rank parity with the offline reference", () => {
    const models = [
      { _id: "a", name: "Alpha (max)", provider: "A", familyTag: "Alpha", hidden: false },
      { _id: "b", name: "Beta (max)", provider: "B", familyTag: "Beta", hidden: false },
      { _id: "c", name: "Gamma (max)", provider: "C", familyTag: "Gamma", hidden: false },
    ];
    const benches = ["one", "two", "three"].map((id) => ({
      _id: id,
      name: id,
      slug: id,
      hidden: false,
      cachedHeadroom: 1,
      cachedNetUpvotes: 1,
      cachedRaterCount: 1,
      cachedDimensions: {
        relevance: 4,
        contamination: 4,
        discriminability: 4,
        reproducibility: 4,
        difficulty: 4,
      },
    }));
    const values = [
      ["a", "one", 90], ["b", "one", 80], ["c", "one", 70],
      ["b", "two", 90], ["a", "two", 80], ["c", "two", 70],
      ["a", "three", 90], ["c", "three", 80], ["b", "three", 70],
    ];
    const scores = values.map(([modelId, benchId, normalizedScore]) => ({
      modelId: modelId as string,
      benchId: benchId as string,
      normalizedScore: normalizedScore as number,
      upvotes: 1,
      downvotes: 0,
    }));
    const snapshot = { models, benches, scores };
    const production = buildPairwiseFamilyRankings(snapshot).rows
      .sort((left, right) => right.supraScore - left.supraScore)
      .map((row) => row.familyTag);
    const offline = buildPairwiseRanking(
      buildFamilyAggregateSnapshot(snapshot, "max"),
      {
        outcomeMode: "binary",
        benchmarkWeightMode: "bayesian",
        priorRaters: 3,
        regularization: 0.15,
        iterations: 2_000,
        representativeMinBenchCount: 1,
      },
    ).familyRanking.map((row) => row.familyTag);
    expect(production).toEqual(offline);
  });

  it("combines the best concrete result on each family benchmark", async () => {
    const t = setupTestDb();
    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "family-fixture",
        email: "family-fixture@test.internal",
      } as any);
      const benchIds = [];
      for (let index = 0; index < FAMILY_REPRESENTATIVE_MIN_BENCHES; index++) {
        const benchId = await ctx.db.insert("benches", {
          name: `Family Bench ${index + 1}`,
          slug: `family-bench-${index + 1}`,
          description: "family representative fixture",
          url: `https://example.com/family-bench-${index + 1}`,
          isOfficial: true,
          tags: [],
          scaleMin: 0,
          scaleMax: 100,
          addedBy: userId,
          createdAt: Date.now(),
          cachedEffectiveWeight: 50,
          cachedNetUpvotes: 1,
          cachedModelCount: 2,
        });
        benchIds.push(benchId);
      }
      const sparseId = await ctx.db.insert("models", {
        name: "Family Model (one-bench peak)",
        provider: "TestLab",
        slug: "family-model-one-bench-peak",
        familyTag: "Family Model",
        tags: [],
        addedBy: userId,
        createdAt: Date.now(),
      });
      const coveredId = await ctx.db.insert("models", {
        name: "Family Model (covered)",
        provider: "TestLab",
        slug: "family-model-covered",
        familyTag: "Family Model",
        tags: [],
        addedBy: userId,
        createdAt: Date.now(),
      });
      const addScore = async (modelId: any, benchId: any, score: number) =>
        await ctx.db.insert("modelScores", {
          modelId,
          benchId,
          rawScore: score,
          normalizedScore: score,
          sourceUrl: "https://example.com/family-score",
          accessedAt: Date.now(),
          submittedBy: userId,
          createdAt: Date.now(),
          upvotes: 1,
          downvotes: 0,
        });
      await addScore(sparseId, benchIds[0], 99);
      for (const benchId of benchIds) await addScore(coveredId, benchId, 80);
      return { sparseId, coveredId };
    });

    await t.mutation(internal.rankings.recomputeAll, {});
    const result = await t.run(async (ctx) => ({
      family: await ctx.db
        .query("familyRankings")
        .withIndex("by_family_provider", (q) =>
          q.eq("familyTag", "Family Model").eq("provider", "TestLab")
        )
        .unique(),
      covered: await ctx.db
        .query("modelRankings")
        .withIndex("by_model", (q) => q.eq("modelId", seeded.coveredId))
        .unique(),
    }));

    expect(result.family?.aggregationMethod).toBe("family-ceiling-pairwise");
    expect(result.family?.representativeModelId).toBeUndefined();
    expect(result.family?.representativeName).toBeUndefined();
    expect(result.family?.benchCount).toBe(FAMILY_REPRESENTATIVE_MIN_BENCHES);
    expect(result.family?.provisional).toBe(false);
    expect(result.family?.supraScore).toBe(50);
    expect(result.covered?.supraScore).not.toBeUndefined();
    expect(seeded.sparseId).not.toBe(seeded.coveredId);
  });

  it("keeps a sparse family visible but marks its best member provisional", async () => {
    const t = setupTestDb();
    const modelId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "sparse-family-fixture",
        email: "sparse-family-fixture@test.internal",
      } as any);
      const benchId = await ctx.db.insert("benches", {
        name: "Sparse Family Bench",
        slug: "sparse-family-bench",
        description: "sparse family fixture",
        url: "https://example.com/sparse-family-bench",
        isOfficial: true,
        tags: [],
        scaleMin: 0,
        scaleMax: 100,
        addedBy: userId,
        createdAt: Date.now(),
        cachedEffectiveWeight: 50,
        cachedNetUpvotes: 1,
        cachedModelCount: 1,
      });
      const id = await ctx.db.insert("models", {
        name: "Sparse Family Model",
        provider: "TestLab",
        slug: "sparse-family-model",
        familyTag: "Sparse Family",
        tags: [],
        addedBy: userId,
        createdAt: Date.now(),
      });
      await ctx.db.insert("modelScores", {
        modelId: id,
        benchId,
        rawScore: 90,
        normalizedScore: 90,
        sourceUrl: "https://example.com/sparse-family-score",
        accessedAt: Date.now(),
        submittedBy: userId,
        createdAt: Date.now(),
        upvotes: 1,
        downvotes: 0,
      });
      return id;
    });

    await t.mutation(internal.rankings.recomputeAll, {});
    const family = await t.run(async (ctx) =>
      await ctx.db
        .query("familyRankings")
        .withIndex("by_family_provider", (q) =>
          q.eq("familyTag", "Sparse Family").eq("provider", "TestLab")
        )
        .unique()
    );

    expect(family?.aggregationMethod).toBe("family-ceiling-pairwise");
    expect(family?.representativeModelId).toBeUndefined();
    expect(family?.benchCount).toBe(1);
    expect(family?.provisional).toBe(true);
    expect(modelId).toBeDefined();
  });
});
