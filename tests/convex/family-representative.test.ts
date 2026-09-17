import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { internal, setupTestDb } from "./_fixtures";
import {
  FAMILY_REPRESENTATIVE_MIN_BENCHES,
  rankWithCore,
} from "../../convex/rankings";
import {
  bootstrapPairedValidationDifference,
} from "../../scripts/lib/pairwise-ranking.mjs";

const DIMS = {
  relevance: 5,
  contamination: 5,
  discriminability: 5,
  reproducibility: 5,
  difficulty: 5,
};
const bench = (id: string, extra: Record<string, unknown> = {}) => ({
  _id: id,
  hidden: false,
  tags: [] as string[],
  cachedHeadroom: 1,
  cachedNetUpvotes: 1,
  cachedRaterCount: 1,
  cachedDimensions: DIMS,
  ...extra,
});
const model = (id: string, familyTag: string, provider = "P") => ({
  _id: id,
  name: id,
  slug: id.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  provider,
  familyTag,
  tags: [] as string[],
});
const score = (modelId: string, benchId: string, normalizedScore: number) => ({
  modelId,
  benchId,
  normalizedScore,
  upvotes: 1,
  downvotes: 0,
});
const family = (result: ReturnType<typeof rankWithCore>, tag: string) =>
  result.families.find((row) => row.familyTag === tag)!;
const config = (result: ReturnType<typeof rankWithCore>, id: string) =>
  result.configs.find((row) => row.modelId === id)!;

describe("unified pairwise ranking: configurations and families", () => {
  it("lets a community-endorsed new benchmark outweigh an old one-vote benchmark", () => {
    const models = [model("old-winner", "Old winner", "A"), model("new-winner", "New winner", "B")];
    const scores = [
      score("old-winner", "old", 90),
      score("new-winner", "old", 80),
      score("old-winner", "new", 80),
      score("new-winner", "new", 90),
    ];
    const rated = (id: string, cachedNetUpvotes: number) =>
      bench(id, { cachedNetUpvotes, cachedRaterCount: 10 });

    const oldConsensus = rankWithCore({ models, benches: [rated("old", 10), rated("new", 1)], scores });
    const newConsensus = rankWithCore({ models, benches: [rated("old", 1), rated("new", 10)], scores });

    expect(family(oldConsensus, "Old winner").supraScore).toBeGreaterThan(
      family(oldConsensus, "New winner").supraScore
    );
    expect(family(newConsensus, "New winner").supraScore).toBeGreaterThan(
      family(newConsensus, "Old winner").supraScore
    );
  });

  it("a saturated benchmark counts for less than an open one", () => {
    const models = ["X", "Y", "Z"].map((id) => model(id, id));
    const result = rankWithCore({
      models,
      benches: [bench("saturated", { cachedHeadroom: 0.1 }), bench("open")],
      scores: [
        score("X", "saturated", 99), score("Y", "saturated", 98), score("Z", "saturated", 97),
        score("Y", "open", 40), score("X", "open", 30), score("Z", "open", 20),
      ],
    });
    // X wins the saturated bench, Y wins the open one: Y must rank first.
    expect(config(result, "Y").supraScore).toBeGreaterThan(config(result, "X").supraScore);
  });

  it("family score is the score of its best configuration from the same fit", () => {
    const models = [model("Alpha (high)", "Alpha", "A"), model("Alpha (max)", "Alpha", "A"), model("Beta", "Beta", "B")];
    const benches = ["one", "two", "three"].map((id) => bench(id));
    const result = rankWithCore({
      models,
      benches,
      scores: [
        score("Alpha (high)", "one", 70), score("Alpha (high)", "two", 70), score("Alpha (high)", "three", 70),
        score("Alpha (max)", "one", 90), score("Alpha (max)", "two", 90), score("Alpha (max)", "three", 90),
        score("Beta", "one", 80), score("Beta", "two", 80), score("Beta", "three", 80),
      ],
    });
    const alpha = family(result, "Alpha");
    expect(alpha.representativeName).toBe("Alpha (max)");
    expect(alpha.supraScore).toBe(config(result, "Alpha (max)").supraScore);
    expect(alpha.benchCount).toBe(3);
    expect(alpha.modelCount).toBe(2);
    expect(alpha.supraScore).toBeGreaterThan(family(result, "Beta").supraScore);
    // The weaker configuration keeps its own, lower row.
    expect(config(result, "Alpha (high)").supraScore).toBeLessThan(family(result, "Beta").supraScore);
  });

  it("a cherry-picked configuration cannot speak for its family", () => {
    // "K (cherry)" lists only the one bench where K wins. It may look great
    // as a row, but it covers a quarter of the family's bench weight, so the
    // family is represented by the fully tested configuration.
    const models = [model("K (max)", "K"), model("K (cherry)", "K"), model("R1", "R1"), model("R2", "R2")];
    const benches = ["a", "b", "c", "d"].map((id) => bench(id));
    const scores = [
      score("K (max)", "a", 90), score("K (max)", "b", 50), score("K (max)", "c", 50), score("K (max)", "d", 50),
      score("K (cherry)", "a", 90),
      ...["a", "b", "c", "d"].flatMap((b) => [score("R1", b, 80), score("R2", b, 70)]),
    ];
    const result = rankWithCore({ models, benches, scores });
    expect(config(result, "K (cherry)").supraScore).toBeGreaterThan(config(result, "K (max)").supraScore);
    expect(family(result, "K").representativeName).toBe("K (max)");
    expect(family(result, "K").supraScore).toBe(config(result, "K (max)").supraScore);
    expect(family(result, "K").supraScore).toBeLessThan(family(result, "R1").supraScore);
  });

  it("falls back to the widest configuration when none covers half the family", () => {
    const models = [model("F (a)", "F"), model("F (b)", "F"), model("F (c)", "F"), model("G", "G")];
    const benches = ["one", "two", "three"].map((id) => bench(id));
    const result = rankWithCore({
      models,
      benches,
      scores: [
        score("F (a)", "one", 90), score("F (b)", "two", 60), score("F (c)", "three", 60),
        score("G", "one", 80), score("G", "two", 80), score("G", "three", 80),
      ],
    });
    // Each F configuration covers a third: the family still gets a row.
    expect(family(result, "F").representativeName).toBeDefined();
    expect(family(result, "F").supraScore).toBeGreaterThan(0);
  });

  it("tag filters restrict the fit to matching benches", () => {
    const models = [model("CodeKing", "CodeKing"), model("MathKing", "MathKing")];
    const benches = [bench("code", { tags: ["coding"] }), bench("math", { tags: ["math"] })];
    const scores = [
      score("CodeKing", "code", 90), score("MathKing", "code", 50),
      score("CodeKing", "math", 50), score("MathKing", "math", 90),
    ];
    const onlyCode = rankWithCore({
      models, benches, scores,
      benchFilter: (b: any) => b.tags.includes("coding"),
    });
    expect(config(onlyCode, "CodeKing").supraScore).toBeGreaterThan(config(onlyCode, "MathKing").supraScore);
    expect(config(onlyCode, "MathKing").benchCount).toBe(1);
  });

  it("hidden models and invalid submissions take no part in the fit", () => {
    const models = [model("A", "A"), model("B", "B"), { ...model("Ghost", "Ghost"), hidden: true }];
    const result = rankWithCore({
      models,
      benches: [bench("one")],
      scores: [
        score("A", "one", 60), score("B", "one", 50), score("Ghost", "one", 99),
        { ...score("B", "one", 99), upvotes: 0, downvotes: 1 },
      ],
    });
    expect(result.configs.find((row) => row.modelId === "Ghost")).toBeUndefined();
    expect(family(result, "Ghost").hidden).toBe(true);
    expect(config(result, "A").supraScore).toBeGreaterThan(config(result, "B").supraScore);
  });

  it("is monotone: improving one result never lowers the configuration", () => {
    const models = ["A", "B", "C"].map((id) => model(id, id));
    const benches = ["one", "two"].map((id) => bench(id));
    const base = [
      score("A", "one", 50), score("B", "one", 60), score("C", "one", 70),
      score("A", "two", 50), score("B", "two", 60), score("C", "two", 70),
    ];
    const before = rankWithCore({ models, benches, scores: base });
    const improved = base.map((row) =>
      row.modelId === "A" && row.benchId === "two" ? { ...row, normalizedScore: 65 } : row
    );
    const after = rankWithCore({ models, benches, scores: improved });
    expect(config(after, "A").supraScore).toBeGreaterThan(config(before, "A").supraScore);
  });

  it("the browser build of the core is the same file and needs no runtime", () => {
    // public/js/supra-rank-core.js is served verbatim to browsers. It must
    // load in a bare context (no require, no window, no Convex) and produce
    // exactly what the server computes.
    const source = readFileSync(
      resolve(__dirname, "../../public/js/supra-rank-core.js"),
      "utf8"
    );
    const sandbox: Record<string, unknown> = {};
    sandbox.globalThis = sandbox;
    vm.runInNewContext(source, sandbox);
    const browserCore = sandbox.SupraRankCore as { rank: (input: unknown) => any };
    const input = {
      models: ["A", "B", "C"].map((id) => model(id, id)),
      benches: ["one", "two"].map((id) => bench(id)),
      scores: [
        score("A", "one", 90), score("B", "one", 80), score("C", "one", 70),
        score("B", "two", 90), score("A", "two", 80), score("C", "two", 10),
      ],
    };
    const server = rankWithCore(input);
    const browser = browserCore.rank(input);
    expect(browser.configs.map((row: any) => [row.modelId, row.supraScore])).toEqual(
      server.configs.map((row) => [row.modelId, row.supraScore])
    );
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

  it("persists the representative configuration on the family row", async () => {
    const t = setupTestDb();
    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "family-fixture",
        email: "family-fixture@test.internal",
      } as any);
      const benchIds = [];
      for (let index = 0; index < FAMILY_REPRESENTATIVE_MIN_BENCHES; index++) {
        benchIds.push(await ctx.db.insert("benches", {
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
        }));
      }
      const mk = async (name: string, familyTag: string) =>
        await ctx.db.insert("models", {
          name,
          provider: "TestLab",
          slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          familyTag,
          tags: [],
          addedBy: userId,
          createdAt: Date.now(),
        });
      const sparseId = await mk("Family Model (one-bench peak)", "Family Model");
      const coveredId = await mk("Family Model (covered)", "Family Model");
      const rivalId = await mk("Rival Model", "Rival");
      const addScore = async (modelId: any, benchId: any, value: number) =>
        await ctx.db.insert("modelScores", {
          modelId,
          benchId,
          rawScore: value,
          normalizedScore: value,
          sourceUrl: "https://example.com/family-score",
          accessedAt: Date.now(),
          submittedBy: userId,
          createdAt: Date.now(),
          upvotes: 1,
          downvotes: 0,
        });
      await addScore(sparseId, benchIds[0], 99);
      for (const benchId of benchIds) {
        await addScore(coveredId, benchId, 80);
        await addScore(rivalId, benchId, 70);
      }
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

    expect(result.family?.aggregationMethod).toBe("best-configuration-pairwise");
    // The one-bench peak covers a third of the family's benches, so the
    // covered configuration represents the family.
    expect(result.family?.representativeModelId).toBe(seeded.coveredId);
    expect(result.family?.representativeName).toBe("Family Model (covered)");
    expect(result.family?.benchCount).toBe(FAMILY_REPRESENTATIVE_MIN_BENCHES);
    expect(result.family?.provisional).toBe(false);
    expect(result.family?.supraScore).toBe(result.covered?.supraScore);
  });

  it("keeps a sparse family visible but marks it provisional", async () => {
    const t = setupTestDb();
    await t.run(async (ctx) => {
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
    });

    await t.mutation(internal.rankings.recomputeAll, {});
    const row = await t.run(async (ctx) =>
      await ctx.db
        .query("familyRankings")
        .withIndex("by_family_provider", (q) =>
          q.eq("familyTag", "Sparse Family").eq("provider", "TestLab")
        )
        .unique()
    );

    expect(row?.aggregationMethod).toBe("best-configuration-pairwise");
    expect(row?.representativeName).toBe("Sparse Family Model");
    expect(row?.benchCount).toBe(1);
    expect(row?.provisional).toBe(true);
  });
});
