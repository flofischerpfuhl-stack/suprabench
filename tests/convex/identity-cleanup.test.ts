import { describe, expect, it } from "vitest";
import { internal, setupTestDb } from "./_fixtures";

async function seed(t: ReturnType<typeof setupTestDb>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "cleanup-fixture", email: "cleanup@test.internal" } as any);
    const bench = async (slug: string) =>
      await ctx.db.insert("benches", {
        name: slug, slug, description: "fixture", url: `https://example.com/${slug}`, isOfficial: true,
        tags: [], scaleMin: 0, scaleMax: 100, addedBy: userId, createdAt: Date.now(),
      });
    const config = async (name: string, familyTag: string, provider = "Lab") =>
      await ctx.db.insert("models", {
        name, provider, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), familyTag, tags: [], addedBy: userId, createdAt: Date.now(),
      });
    const score = async (modelId: any, benchId: any, value: number) =>
      await ctx.db.insert("modelScores", {
        modelId, benchId, rawScore: value, normalizedScore: value, sourceUrl: "https://example.com", accessedAt: Date.now(),
        submittedBy: userId, createdAt: Date.now(), upvotes: 1, downvotes: 0,
      });
    const a = await bench("bench-a"), b = await bench("bench-b");
    const plain = await config("Sol", "Sol"), max = await config("Sol (max)", "Sol"), alias = await config("Sol (adaptive max)", "Sol");
    const other = await config("Other (max)", "Other");
    return {
      a, b, plain, max, alias, other,
      dupOnA: await score(plain, a, 73), maxOnA: await score(max, a, 73),
      uniqueOnB: await score(plain, b, 50), aliasOnA: await score(alias, a, 73), otherOnB: await score(other, b, 10),
    };
  });
}

describe("migrations.applyIdentityCleanup", () => {
  it("dry run changes nothing and reports the plan", async () => {
    const t = setupTestDb(); const s = await seed(t);
    const out = await t.mutation(internal.migrations.applyIdentityCleanup, {
      dryRun: true,
      ops: [{ op: "deleteRow", scoreId: s.dupOnA, configuration: "Sol", benchSlug: "bench-a", rawScore: 73, reason: "unlabelled copy of the (max) row" }],
    });
    expect(out.archive).toHaveLength(1);
    expect(await t.run(async (ctx) => await ctx.db.get(s.dupOnA))).not.toBeNull();
  });

  it("deletes a duplicate, moves a unique row and drops the emptied configurations", async () => {
    const t = setupTestDb(); const s = await seed(t);
    await t.mutation(internal.migrations.applyIdentityCleanup, {
      dryRun: false,
      ops: [
        { op: "deleteRow", scoreId: s.dupOnA, configuration: "Sol", benchSlug: "bench-a", rawScore: 73, reason: "unlabelled copy of the (max) row" },
        { op: "deleteRow", scoreId: s.aliasOnA, configuration: "Sol (adaptive max)", benchSlug: "bench-a", rawScore: 73, reason: "alias configuration of (max)" },
        { op: "moveRow", scoreId: s.uniqueOnB, configuration: "Sol", benchSlug: "bench-b", rawScore: 50, toConfiguration: "Sol (max)", reason: "publisher lists this row as Max" },
        { op: "deleteEmptyConfiguration", configuration: "Sol", reason: "no rows left after cleanup" },
        { op: "deleteEmptyConfiguration", configuration: "Sol (adaptive max)", reason: "alias of Sol (max)" },
      ],
    });
    const after = await t.run(async (ctx) => ({
      moved: await ctx.db.get(s.uniqueOnB), dup: await ctx.db.get(s.dupOnA), plain: await ctx.db.get(s.plain), alias: await ctx.db.get(s.alias),
      kept: await ctx.db.get(s.maxOnA),
    }));
    expect(after.dup).toBeNull();
    expect(after.moved?.modelId).toBe(s.max);
    expect(after.plain).toBeNull();
    expect(after.alias).toBeNull();
    expect(after.kept).not.toBeNull();
  });

  it("refuses to lose information or cross model boundaries", async () => {
    const t = setupTestDb(); const s = await seed(t);
    const run = (ops: any[]) => t.mutation(internal.migrations.applyIdentityCleanup, { dryRun: false, ops });
    // only row of the model on bench-b
    await expect(run([{ op: "deleteRow", scoreId: s.uniqueOnB, configuration: "Sol", benchSlug: "bench-b", rawScore: 50, reason: "should be refused: last row" }])).rejects.toThrow(/without a row/);
    // stale expectation
    await expect(run([{ op: "deleteRow", scoreId: s.dupOnA, configuration: "Sol", benchSlug: "bench-a", rawScore: 99, reason: "should be refused: stale value" }])).rejects.toThrow(/does not match/);
    // target already has the cell
    await expect(run([{ op: "moveRow", scoreId: s.dupOnA, configuration: "Sol", benchSlug: "bench-a", rawScore: 73, toConfiguration: "Sol (max)", reason: "should be refused: cell taken" }])).rejects.toThrow(/already has a row/);
    // different model
    await expect(run([{ op: "moveRow", scoreId: s.uniqueOnB, configuration: "Sol", benchSlug: "bench-b", rawScore: 50, toConfiguration: "Other (max)", reason: "should be refused: other model" }])).rejects.toThrow(/different model/);
    // configuration not empty
    await expect(run([{ op: "deleteEmptyConfiguration", configuration: "Sol", reason: "should be refused: has rows" }])).rejects.toThrow(/still has/);
    // deleting both copies in one plan must not slip through
    await expect(run([
      { op: "deleteRow", scoreId: s.dupOnA, configuration: "Sol", benchSlug: "bench-a", rawScore: 73, reason: "first copy of three on bench-a" },
      { op: "deleteRow", scoreId: s.aliasOnA, configuration: "Sol (adaptive max)", benchSlug: "bench-a", rawScore: 73, reason: "second copy of three on bench-a" },
      { op: "deleteRow", scoreId: s.maxOnA, configuration: "Sol (max)", benchSlug: "bench-a", rawScore: 73, reason: "should be refused: last copy" },
    ])).rejects.toThrow(/without a row/);
  });
});
