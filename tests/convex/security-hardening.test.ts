import { describe, expect, test } from "vitest";
import { setupTestDb, api } from "./_fixtures";

async function seedUser(t: ReturnType<typeof setupTestDb>) {
  return await t.run((ctx) =>
    ctx.db.insert("users", { name: "Security User", email: "security@test.internal" } as any)
  );
}

describe("URL hardening", () => {
  test("bench creation rejects javascript URLs", async () => {
    const t = setupTestDb();
    const userId = await seedUser(t);
    await expect(
      t.withIdentity({ subject: userId as unknown as string }).mutation(api.benches.create, {
        name: "Bad URL Bench",
        description: "Should fail",
        url: "javascript:alert(1)",
        scaleMin: 0,
        scaleMax: 100,
        tags: [],
      })
    ).rejects.toThrow(/invalid url|url must/i);
  });

  test("score submission rejects data URLs", async () => {
    const t = setupTestDb();
    const userId = await seedUser(t);
    const { modelId, benchId } = await t.run(async (ctx) => {
      const modelId = await ctx.db.insert("models", {
        name: "Secure Model",
        provider: "SecureLab",
        slug: "secure-model",
        tags: [],
        addedBy: userId,
        createdAt: Date.now(),
      } as any);
      await ctx.db.insert("modelRankings", {
        modelId,
        name: "Secure Model",
        provider: "SecureLab",
        slug: "secure-model",
        tags: [],
        supraScore: 0,
        benchCount: 0,
        updatedAt: Date.now(),
        hidden: false,
      } as any);
      const benchId = await ctx.db.insert("benches", {
        name: "Secure Bench",
        slug: "secure-bench",
        description: "secure",
        url: "https://example.com/bench",
        isOfficial: false,
        tags: [],
        scaleMin: 0,
        scaleMax: 100,
        addedBy: userId,
        createdAt: Date.now(),
      } as any);
      return { modelId, benchId };
    });

    await expect(
      t.withIdentity({ subject: userId as unknown as string }).mutation(api.submissions.submitOne, {
        modelId,
        benchId,
        rawScore: 50,
        sourceUrl: "data:text/html,<script>alert(1)</script>",
        accessedAt: Date.now(),
      })
    ).rejects.toThrow(/invalid source url|url must/i);
  });
});

describe("hidden content", () => {
  test("hidden models and benches are not returned by detail queries", async () => {
    const t = setupTestDb();
    const userId = await seedUser(t);
    await t.run(async (ctx) => {
      const modelId = await ctx.db.insert("models", {
        name: "Hidden Model",
        provider: "HiddenLab",
        slug: "hidden-model",
        tags: [],
        addedBy: userId,
        createdAt: Date.now(),
        hidden: true,
      } as any);
      await ctx.db.insert("modelRankings", {
        modelId,
        name: "Hidden Model",
        provider: "HiddenLab",
        slug: "hidden-model",
        tags: [],
        supraScore: 99,
        benchCount: 1,
        updatedAt: Date.now(),
        hidden: true,
      } as any);
      await ctx.db.insert("benches", {
        name: "Hidden Bench",
        slug: "hidden-bench",
        description: "hidden",
        url: "https://example.com/hidden",
        isOfficial: false,
        tags: [],
        scaleMin: 0,
        scaleMax: 100,
        addedBy: userId,
        createdAt: Date.now(),
        hidden: true,
      } as any);
    });

    await expect(t.query(api.models.getBySlug, { slug: "hidden-model" })).resolves.toBeNull();
    await expect(t.query(api.benches.getBySlug, { slug: "hidden-bench" })).resolves.toBeNull();
  });
});

