// Rate-limit + quota behaviour per docs/api/rate-limits.html.

import { describe, test, expect } from "vitest";
import { setupTestDb, seedKey, seedBaseDataset, buildRequest } from "./_fixtures";
import { internal, api } from "../../convex/_generated/api";

const BASE = "https://test.convex.site";

describe("rate limit (rpm)", () => {
  test("allows requests up to rpmLimit, blocks the next one with 429 rate_limited", async () => {
    const t = setupTestDb();
    await seedBaseDataset(t);
    const rpm = 5;
    const key = await seedKey(t, { tier: "starter", subStatus: "active", rpmLimit: rpm });

    const successes: number[] = [];
    let blockedCode: string | null = null;

    for (let i = 0; i < rpm + 3; i++) {
      const r = await t.fetch(...buildRequest(`${BASE}/v1/models`, { key }));
      if (r.status === 200) successes.push(r.status);
      else {
        blockedCode = (await r.json()).error?.code ?? null;
        break;
      }
    }
    expect(successes.length).toBe(rpm);
    expect(blockedCode).toBe("rate_limited");
  });
});

describe("monthly quota", () => {
  test("allows requests up to monthlyQuota, blocks the next with 429 quota_exceeded", async () => {
    const t = setupTestDb();
    await seedBaseDataset(t);
    const quota = 3;
    const key = await seedKey(t, {
      tier: "starter",
      subStatus: "active",
      monthlyQuota: quota,
      rpmLimit: 1_000,
    });

    let ok = 0;
    let lastStatus = 0;
    let lastCode: string | null = null;
    for (let i = 0; i < quota + 2; i++) {
      const r = await t.fetch(...buildRequest(`${BASE}/v1/models`, { key }));
      lastStatus = r.status;
      if (r.status === 200) ok++;
      else {
        lastCode = (await r.json()).error?.code ?? null;
        break;
      }
    }
    expect(ok).toBe(quota);
    expect(lastStatus).toBe(429);
    expect(lastCode).toBe("quota_exceeded");
  });

  test("consumeQuota increments the per-month bucket atomically", async () => {
    const t = setupTestDb();
    const key = await seedKey(t, {
      tier: "starter",
      subStatus: "active",
      monthlyQuota: 10,
      rpmLimit: 1000,
    });
    const yyyymm = new Date().toISOString().slice(0, 7);

    const r1 = await t.mutation(internal.api.consumeQuota, {
      apiKeyId: key.apiKeyId,
      yyyymm,
    });
    expect(r1).toBe(1);
    const r2 = await t.mutation(internal.api.consumeQuota, {
      apiKeyId: key.apiKeyId,
      yyyymm,
    });
    expect(r2).toBe(2);
  });

  test("consumeQuota returns null when at cap", async () => {
    const t = setupTestDb();
    const key = await seedKey(t, {
      tier: "starter",
      subStatus: "active",
      monthlyQuota: 1,
    });
    const yyyymm = new Date().toISOString().slice(0, 7);
    const r1 = await t.mutation(internal.api.consumeQuota, {
      apiKeyId: key.apiKeyId,
      yyyymm,
    });
    expect(r1).toBe(1);
    const r2 = await t.mutation(internal.api.consumeQuota, {
      apiKeyId: key.apiKeyId,
      yyyymm,
    });
    expect(r2).toBeNull();
  });
});

describe("myKeyUsage reports bucket correctly", () => {
  test("matches what consumeQuota incremented", async () => {
    const t = setupTestDb();
    const key = await seedKey(t, {
      tier: "starter",
      subStatus: "active",
      monthlyQuota: 1000,
    });
    const yyyymm = new Date().toISOString().slice(0, 7);
    await t.mutation(internal.api.consumeQuota, {
      apiKeyId: key.apiKeyId,
      yyyymm,
    });
    await t.mutation(internal.api.consumeQuota, {
      apiKeyId: key.apiKeyId,
      yyyymm,
    });
    const usage = await t
      .withIdentity({ subject: key.ownerUserId as unknown as string })
      .query(api.api.myKeyUsage, { apiKeyId: key.apiKeyId });
    expect(usage.used).toBe(2);
    expect(usage.quota).toBe(1000);
    expect(usage.yyyymm).toBe(yyyymm);
  });
});
