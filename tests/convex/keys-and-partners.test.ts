// User-facing key mutations + partner-tier CLI mutations.

import { describe, test, expect } from "vitest";
import { setupTestDb } from "./_fixtures";
import { api, internal } from "../../convex/_generated/api";

describe("api.createKey (public mutation)", () => {
  test("requires sign-in", async () => {
    const t = setupTestDb();
    await expect(
      t.mutation(api.api.createKey, { name: "k1", tier: "starter" })
    ).rejects.toThrow(/not signed in/i);
  });

  test("rejects unknown tiers", async () => {
    const t = setupTestDb();
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "U", email: "u@t.test" } as any)
    );
    await expect(
      t
        .withIdentity({ subject: userId as unknown as string })
        .mutation(api.api.createKey, { name: "k1", tier: "magic" })
    ).rejects.toThrow(/unknown tier/i);
  });

  test("rejects partner tier (CLI-only)", async () => {
    const t = setupTestDb();
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "U", email: "u@t.test" } as any)
    );
    // Even WITH an active sub row for "partner", the createKey path
    // must refuse — PUBLIC_TIERS guards the allowed set.
    await t.run((ctx) =>
      ctx.db.insert("stripeSubscriptions", {
        userId,
        stripeCustomerId: "cus_x",
        stripeSubscriptionId: "sub_x",
        stripePriceId: "price_x",
        tier: "partner",
        status: "active",
        currentPeriodEnd: Date.now() + 1e9,
        cancelAtPeriodEnd: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any)
    );
    await expect(
      t
        .withIdentity({ subject: userId as unknown as string })
        .mutation(api.api.createKey, { name: "k1", tier: "partner" })
    ).rejects.toThrow(/not publicly subscribable/i);
  });

  test("requires active subscription for starter/pro/enterprise", async () => {
    const t = setupTestDb();
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "U", email: "u@t.test" } as any)
    );
    await expect(
      t
        .withIdentity({ subject: userId as unknown as string })
        .mutation(api.api.createKey, { name: "k1", tier: "starter" })
    ).rejects.toThrow(/no active starter subscription/i);
  });

  test("enforces per-tier maxKeys", async () => {
    const t = setupTestDb();
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", { name: "U", email: "u@t.test" } as any);
      await ctx.db.insert("stripeSubscriptions", {
        userId: uid,
        stripeCustomerId: "cus_x",
        stripeSubscriptionId: "sub_x",
        stripePriceId: "price_x",
        tier: "starter",
        status: "active",
        currentPeriodEnd: Date.now() + 1e9,
        cancelAtPeriodEnd: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);
      return uid;
    });
    const iden = { subject: userId as unknown as string };
    const r1 = await t
      .withIdentity(iden)
      .mutation(api.api.createKey, { name: "k1", tier: "starter" });
    expect(r1.plaintext).toMatch(/^sb_live_[0-9a-f]{64}$/);
    expect(r1.prefix).toMatch(/^sb_live_[0-9a-f]{8}$/);
    const [createdKey] = await t.withIdentity(iden).query(api.api.myKeys, {});
    const storedKey = await t.run((ctx) => ctx.db.get(createdKey._id));
    expect((storedKey as any).stripeSubscriptionId).toBe("sub_x");
    expect((storedKey as any).stripeSubscriptionStatus).toBe("active");
    // Starter maxKeys = 1 → second creation fails.
    await expect(
      t
        .withIdentity(iden)
        .mutation(api.api.createKey, { name: "k2", tier: "starter" })
    ).rejects.toThrow(/max 1 active keys/i);
  });

  test("revokeKey flips revokedAt and blocks subsequent API calls", async () => {
    const t = setupTestDb();
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", { name: "U", email: "u@t.test" } as any);
      await ctx.db.insert("stripeSubscriptions", {
        userId: uid,
        stripeCustomerId: "cus_x",
        stripeSubscriptionId: "sub_x",
        stripePriceId: "price_x",
        tier: "starter",
        status: "active",
        currentPeriodEnd: Date.now() + 1e9,
        cancelAtPeriodEnd: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);
      return uid;
    });
    const iden = { subject: userId as unknown as string };
    const { plaintext } = await t
      .withIdentity(iden)
      .mutation(api.api.createKey, { name: "k1", tier: "starter" });

    // Find it back via myKeys:
    const keys = await t.withIdentity(iden).query(api.api.myKeys, {});
    expect(keys.length).toBe(1);
    expect(keys[0].revoked).toBe(false);

    await t.withIdentity(iden).mutation(api.api.revokeKey, { apiKeyId: keys[0]._id });
    const afterKeys = await t.withIdentity(iden).query(api.api.myKeys, {});
    expect(afterKeys[0].revoked).toBe(true);

    // API call with revoked key now 401s:
    const res = await t.fetch("/v1/models", {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("revoked");
  });
});

describe("partners:* admin mutations", () => {
  test("createPartnerKey mints a tier='partner' key", async () => {
    const t = setupTestDb();
    const r = await t.mutation(internal.partners.createPartnerKey, {
      name: "mysite.com",
    });
    expect(r.plaintext).toMatch(/^sb_live_[0-9a-f]{64}$/);
    expect(r.prefix).toMatch(/^sb_live_/);
    expect(r.monthlyQuota).toBeGreaterThan(0);
  });

  test("duplicate active name rejected, revoke unlocks re-create", async () => {
    const t = setupTestDb();
    await t.mutation(internal.partners.createPartnerKey, { name: "dup.com" });
    await expect(
      t.mutation(internal.partners.createPartnerKey, { name: "dup.com" })
    ).rejects.toThrow(/already exists/i);

    const list = await t.query(internal.partners.listPartnerKeys, {});
    const theOne = list.find((k: any) => k.name === "dup.com");
    expect(theOne).toBeDefined();
    await t.mutation(internal.partners.revokePartnerKey, {
      apiKeyId: theOne!._id,
    });

    // After revoke: creation OK again.
    const r2 = await t.mutation(internal.partners.createPartnerKey, {
      name: "dup.com",
    });
    expect(r2.plaintext).toBeDefined();
  });

  test("updatePartnerQuota patches quota + rpm, clamps extremes", async () => {
    const t = setupTestDb();
    await t.mutation(internal.partners.createPartnerKey, { name: "p.com" });
    const list = await t.query(internal.partners.listPartnerKeys, {});
    const id = list[0]._id;
    const r = await t.mutation(internal.partners.updatePartnerQuota, {
      apiKeyId: id,
      monthlyQuota: 99_999_999, // way above the 1M cap → clamped
      rpmLimit: 1, // below the 10 floor → clamped
    });
    expect(r.patch.monthlyQuota).toBe(1_000_000);
    expect(r.patch.rpmLimit).toBe(10);
  });

  test("updatePartnerQuota refuses non-partner keys", async () => {
    const t = setupTestDb();
    // Insert a non-partner key directly.
    const ownerUserId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "U", email: "u@t.test" } as any)
    );
    const apiKeyId = await t.run((ctx) =>
      ctx.db.insert("apiKeys", {
        hash: "x".repeat(64),
        prefix: "sb_live_xxxxxxxx",
        name: "pro-key",
        ownerUserId,
        tier: "pro" as any,
        monthlyQuota: 100_000,
        rpmLimit: 300,
        createdAt: Date.now(),
      } as any)
    );
    await expect(
      t.mutation(internal.partners.updatePartnerQuota, {
        apiKeyId,
        monthlyQuota: 500_000,
      })
    ).rejects.toThrow(/refusing to edit non-partner/i);
  });

  test("partner key works against /v1/models without Stripe", async () => {
    const t = setupTestDb();
    const r = await t.mutation(internal.partners.createPartnerKey, {
      name: "site.test",
    });
    const res = await t.fetch("/v1/models", {
      headers: { authorization: `Bearer ${r.plaintext}` },
    });
    // 200 (with empty body) or 200 with seeded data — just not 401/402.
    expect([200, 429]).toContain(res.status); // 429 only if a separate test left the quota exhausted in some shared state; vitest "isolate" default keeps it 200.
    if (res.status === 200) {
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });
});
