import { describe, expect, it } from "vitest";
import { internal, setupTestDb } from "./_fixtures";

async function seed(t: ReturnType<typeof setupTestDb>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "rename-fixture", email: "rename@test.internal" } as any);
    const mk = async (name: string, slug: string) =>
      await ctx.db.insert("benches", {
        name, slug, description: "fixture", url: `https://example.com/${slug}`, isOfficial: true,
        tags: [], scaleMin: 0, scaleMax: 100, addedBy: userId, createdAt: Date.now(),
      });
    const benchId = await mk("Suite v1 (Codex)", "suite-v1-codex");
    await mk("Other Suite", "other-suite");
    const modelId = await ctx.db.insert("models", {
      name: "M", provider: "P", slug: "m", tags: [], addedBy: userId, createdAt: Date.now(),
    });
    await ctx.db.insert("modelScores", {
      modelId, benchId, rawScore: 50, normalizedScore: 50, sourceUrl: "https://example.com",
      accessedAt: Date.now(), submittedBy: userId, createdAt: Date.now(), upvotes: 1, downvotes: 0,
    });
    return { benchId };
  });
}

describe("migrations.renameBench", () => {
  it("renames name, slug and description and keeps the scores attached", async () => {
    const t = setupTestDb();
    const { benchId } = await seed(t);
    const result = await t.mutation(internal.migrations.renameBench, {
      slug: "suite-v1-codex", newName: "Suite v1", newDescription: "All harnesses.",
    });
    expect(result.to.slug).toBe("suite-v1");
    const after = await t.run(async (ctx) => ({
      bench: await ctx.db.get(benchId),
      scores: await ctx.db.query("modelScores").withIndex("by_bench", (q) => q.eq("benchId", benchId)).collect(),
    }));
    expect(after.bench?.name).toBe("Suite v1");
    expect(after.bench?.slug).toBe("suite-v1");
    expect(after.bench?.description).toBe("All harnesses.");
    expect(after.scores).toHaveLength(1);
  });

  it("refuses a slug collision and an unknown benchmark", async () => {
    const t = setupTestDb();
    await seed(t);
    await expect(
      t.mutation(internal.migrations.renameBench, { slug: "suite-v1-codex", newName: "Other Suite" })
    ).rejects.toThrow(/already in use/);
    await expect(
      t.mutation(internal.migrations.renameBench, { slug: "nope", newName: "X" })
    ).rejects.toThrow(/not found/);
  });
});
