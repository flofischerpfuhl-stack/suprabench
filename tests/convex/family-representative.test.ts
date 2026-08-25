import { describe, expect, it } from "vitest";
import { internal, setupTestDb } from "./_fixtures";
import { FAMILY_REPRESENTATIVE_MIN_BENCHES } from "../../convex/rankings";

describe("family representative selection", () => {
  it("prefers the best sufficiently-covered concrete configuration", async () => {
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

    expect(result.family?.representativeModelId).toBe(seeded.coveredId);
    expect(result.family?.representativeName).toBe("Family Model (covered)");
    expect(result.family?.benchCount).toBe(FAMILY_REPRESENTATIVE_MIN_BENCHES);
    expect(result.family?.provisional).toBe(false);
    expect(result.family?.supraScore).toBe(result.covered?.supraScore);
    expect(result.family?.representativeModelId).not.toBe(seeded.sparseId);
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

    expect(family?.representativeModelId).toBe(modelId);
    expect(family?.benchCount).toBe(1);
    expect(family?.provisional).toBe(true);
  });
});
