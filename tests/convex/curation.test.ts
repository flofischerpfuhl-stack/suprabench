import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRIMARY_ADMIN_EMAIL } from "../../convex/admin";
import { internal, setupTestDb as rawSetupTestDb } from "./_fixtures";

const RUN_ID = "2026-08-02";
const REPORT_PATH = `public/reports/curation/${RUN_ID}/index.html`;
const SOURCE_URL = "https://example.com/leaderboard";

const activeDbs: Array<ReturnType<typeof rawSetupTestDb>> = [];

function setupTestDb() {
  const t = rawSetupTestDb();
  activeDbs.push(t);
  return t;
}

beforeEach(() => {
  activeDbs.length = 0;
  vi.stubEnv("SCORES_WORKER_URL", "https://fake-scores-worker.test");
  vi.stubEnv("SCORES_WORKER_SECRET", "test-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ scores: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
  );
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const t of activeDbs) {
    try {
      await t.finishAllScheduledFunctions(() => {});
    } catch {
      // Mirror/rebuild behavior has its own integration suite. Here we only
      // drain scheduled functions so they cannot outlive the test database.
    }
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function seedAdmin(t: ReturnType<typeof setupTestDb>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Florian",
      email: PRIMARY_ADMIN_EMAIL,
    } as any)
  );
}

function evidence(sourceUrl = SOURCE_URL) {
  return [{
    sourceUrl,
    screenshotUrl: sourceUrl,
    screenshotPath: `public/reports/curation/${RUN_ID}/screenshots/leaderboard.png`,
  }];
}

function newBatch(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    reportPath: REPORT_PATH,
    dryRun: false,
    models: [{
      name: "Example Model 2",
      provider: "Example AI",
      familyTag: "Example",
      tags: ["reasoning", "reasoning"],
    }],
    benches: [{
      name: "Example Bench",
      slug: "example-bench",
      description: "A reproducible example benchmark.",
      url: SOURCE_URL,
      scaleMin: 0,
      scaleMax: 100,
      tags: ["reasoning"],
      rating: {
        relevance: 4,
        contamination: 3,
        discriminability: 4,
        reproducibility: 5,
        difficulty: 4,
      },
    }],
    scores: [{
      modelName: "Example Model 2",
      benchSlug: "example-bench",
      rawScore: 72.5,
      sourceUrl: SOURCE_URL,
      accessedAt: 1_780_000_000_000,
      operation: "insert" as const,
    }],
    evidence: evidence(),
    ...overrides,
  };
}

describe("curation.applyBatch", () => {
  it("accepts an additional same-day batch id and rejects malformed ids", async () => {
    const t = setupTestDb();
    await seedAdmin(t);
    const suffixed = "2026-08-02-b";
    const batch = newBatch({
      runId: suffixed,
      reportPath: `public/reports/curation/${suffixed}/index.html`,
      dryRun: true,
      evidence: [{
        sourceUrl: SOURCE_URL,
        screenshotUrl: SOURCE_URL,
        screenshotPath: `public/reports/curation/${suffixed}/screenshots/leaderboard.png`,
      }],
    });
    const plan = await t.mutation(internal.curation.applyBatch, batch as any);
    expect(plan.runId).toBe(suffixed);
    for (const bad of ["2026-08-02-B", "2026-08-02-bb", "2026-08-02b", "latest"]) {
      await expect(
        t.mutation(internal.curation.applyBatch, {
          ...(batch as any),
          runId: bad,
          reportPath: `public/reports/curation/${bad}/index.html`,
        })
      ).rejects.toThrow(/runId/);
    }
  });

  it("requires screenshot-backed evidence for every score", async () => {
    const t = setupTestDb();
    await seedAdmin(t);

    await expect(
      t.mutation(internal.curation.applyBatch, newBatch({ dryRun: true, evidence: [] }))
    ).rejects.toThrow("no screenshot-backed evidence");
  });

  it("dry-runs operation semantics before writing", async () => {
    const t = setupTestDb();
    await seedAdmin(t);

    const result = await t.mutation(
      internal.curation.applyBatch,
      newBatch({ dryRun: true })
    );
    expect(result).toMatchObject({
      dryRun: true,
      modelsToCreate: ["Example Model 2"],
      benchesToCreate: ["example-bench"],
      scoresToInsert: ["Example Model 2 | example-bench"],
      scoresToReplace: [],
      scoresToRefresh: [],
      scoresUnchanged: [],
    });

    const counts = await t.run(async (ctx) => ({
      models: (await ctx.db.query("models").collect()).length,
      benches: (await ctx.db.query("benches").collect()).length,
      scores: (await ctx.db.query("modelScores").collect()).length,
    }));
    expect(counts).toEqual({ models: 0, benches: 0, scores: 0 });
  });

  it("creates a complete, evidence-backed batch and is idempotent", async () => {
    const t = setupTestDb();
    await seedAdmin(t);

    const first = await t.mutation(internal.curation.applyBatch, newBatch());
    expect(first).toMatchObject({
      createdModels: ["Example Model 2"],
      createdBenches: ["example-bench"],
      insertedScores: ["Example Model 2 | example-bench"],
      replacedScores: [],
      mirroredScores: 1,
    });

    const second = await t.mutation(internal.curation.applyBatch, newBatch());
    expect(second).toMatchObject({
      createdModels: [],
      createdBenches: [],
      insertedScores: [],
      unchangedScores: ["Example Model 2 | example-bench"],
      mirroredScores: 0,
    });

    const rows = await t.run(async (ctx) => ({
      models: await ctx.db.query("models").collect(),
      benches: await ctx.db.query("benches").collect(),
      scores: await ctx.db.query("modelScores").collect(),
      votes: await ctx.db.query("votes").collect(),
      ratings: await ctx.db.query("benchQualityRatings").collect(),
    }));
    expect(rows.models).toHaveLength(1);
    expect(rows.models[0].tags).toEqual(["reasoning"]);
    expect(rows.benches).toHaveLength(1);
    expect(rows.benches[0].tags).toEqual(["reasoning"]);
    expect(rows.scores).toHaveLength(1);
    expect(rows.votes).toHaveLength(1);
    expect(rows.ratings).toHaveLength(1);
  });

  it("requires an explicit, newer replacement for a changed value", async () => {
    const t = setupTestDb();
    await seedAdmin(t);
    await t.mutation(internal.curation.applyBatch, newBatch());

    const changedInsert = newBatch({
      dryRun: true,
      scores: [{
        ...newBatch().scores[0],
        rawScore: 74,
        accessedAt: 1_780_000_001_000,
      }],
    });
    await expect(
      t.mutation(internal.curation.applyBatch, changedInsert)
    ).rejects.toThrow("use operation=replace");

    const staleReplace = newBatch({
      dryRun: true,
      scores: [{
        ...newBatch().scores[0],
        rawScore: 74,
        operation: "replace" as const,
      }],
    });
    await expect(
      t.mutation(internal.curation.applyBatch, staleReplace)
    ).rejects.toThrow("Replacement is not newer");

    const replacement = newBatch({
      scores: [{
        ...newBatch().scores[0],
        rawScore: 74,
        accessedAt: 1_780_000_001_000,
        operation: "replace" as const,
      }],
    });
    const result = await t.mutation(internal.curation.applyBatch, replacement);
    expect(result).toMatchObject({
      replacedScores: ["Example Model 2 | example-bench"],
      mirroredScores: 1,
    });
    const scores = await t.run(async (ctx) => ctx.db.query("modelScores").collect());
    expect(scores).toHaveLength(1);
    expect(scores[0].rawScore).toBe(74);
  });
});
