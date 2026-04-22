// Auth middleware — every negative path the docs promise (see
// public/docs/api/authentication.html + public/docs/api/errors.html).

import { describe, test, expect } from "vitest";
import { setupTestDb, seedKey, buildRequest } from "./_fixtures";

const BASE = "https://test.convex.site";

describe("auth middleware", () => {
  test("missing Authorization header → 401 missing_token", async () => {
    const t = setupTestDb();
    const res = await t.fetch(...buildRequest(`${BASE}/v1/models`));
    expect(res.status).toBe(401);
    const j = await res.json();
    expect(j.error.code).toBe("missing_token");
  });

  test("non-Bearer scheme → 401 missing_token", async () => {
    const t = setupTestDb();
    const res = await t.fetch(...buildRequest(`${BASE}/v1/models`, {
        headers: { authorization: "Basic dXNlcjpwYXNz" },
      })
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("missing_token");
  });

  test("wrong prefix → 401 invalid_token_format", async () => {
    const t = setupTestDb();
    const res = await t.fetch(...buildRequest(`${BASE}/v1/models`, {
        headers: { authorization: "Bearer pk_test_whatever" },
      })
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("invalid_token_format");
  });

  test("unknown token → 401 invalid_token", async () => {
    const t = setupTestDb();
    const fake = "sb_live_" + "0".repeat(64);
    const res = await t.fetch(...buildRequest(`${BASE}/v1/models`, {
        headers: { authorization: `Bearer ${fake}` },
      })
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("invalid_token");
  });

  test("revoked key → 401 revoked", async () => {
    const t = setupTestDb();
    const key = await seedKey(t, { revokedAt: Date.now() - 1000 });
    const res = await t.fetch(...buildRequest(`${BASE}/v1/models`, { key }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("revoked");
  });

  test("past-due subscription → 402 subscription_inactive", async () => {
    const t = setupTestDb();
    const key = await seedKey(t, { tier: "starter", subStatus: "past_due" });
    const res = await t.fetch(...buildRequest(`${BASE}/v1/models`, { key }));
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe("subscription_inactive");
  });

  test("canceled subscription → 402 subscription_inactive", async () => {
    const t = setupTestDb();
    const key = await seedKey(t, { tier: "pro", subStatus: "canceled" });
    const res = await t.fetch(...buildRequest(`${BASE}/v1/models`, { key }));
    expect(res.status).toBe(402);
  });

  test("partner tier SKIPS subscription check even with missing sub status", async () => {
    const t = setupTestDb();
    const key = await seedKey(t, { tier: "partner" /* no subStatus */ });
    const res = await t.fetch(...buildRequest(`${BASE}/v1/models`, { key }));
    // Not 402. Could be 200 (healthy dataset) or 200 with empty body —
    // just not a subscription-inactive response.
    expect(res.status).not.toBe(402);
  });

  test("partner tier with bogus subscription status ALSO bypasses check", async () => {
    const t = setupTestDb();
    const key = await seedKey(t, { tier: "partner", subStatus: "canceled" });
    const res = await t.fetch(...buildRequest(`${BASE}/v1/models`, { key }));
    expect(res.status).not.toBe(402);
  });

  test("active subscription on paid tier → 200", async () => {
    const t = setupTestDb();
    const key = await seedKey(t, { tier: "starter", subStatus: "active" });
    const res = await t.fetch(...buildRequest(`${BASE}/v1/models`, { key }));
    expect(res.status).toBe(200);
  });

  test("response has CORS + Cache-Control + vary headers", async () => {
    const t = setupTestDb();
    const key = await seedKey(t, { tier: "starter", subStatus: "active" });
    const res = await t.fetch(...buildRequest(`${BASE}/v1/models`, { key }));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("vary")).toContain("authorization");
    const cc = res.headers.get("cache-control");
    expect(cc).toMatch(/public, max-age=\d+/);
  });

  test("OPTIONS preflight returns 204 + CORS headers", async () => {
    const t = setupTestDb();
    const res = await t.fetch("/v1/models", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "authorization"
    );
  });
});
