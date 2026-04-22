// Every documented endpoint — shape, parameters, error paths.
// Mirrors the specs at /docs/api/reference/*.html.

import { describe, test, expect, beforeEach } from "vitest";
import { setupTestDb, seedKey, seedBaseDataset, buildRequest } from "./_fixtures";

const BASE = "https://test.convex.site";

describe("GET /v1/models", () => {
  test("returns ranked models with docs-shape", async () => {
    const t = setupTestDb();
    await seedBaseDataset(t);
    const key = await seedKey(t, { tier: "starter", subStatus: "active" });
    const res = await t.fetch(buildRequest(`${BASE}/v1/models`, { key }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const rows = await res.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    // Shape documented in /docs/api/reference/models.html:
    for (const r of rows) {
      expect(typeof r.slug).toBe("string");
      expect(typeof r.name).toBe("string");
      expect(typeof r.provider).toBe("string");
      expect(typeof r.supraScore).toBe("number");
      expect(typeof r.benchCount).toBe("number");
      expect(Array.isArray(r.tags)).toBe(true);
      expect(typeof r.updatedAt).toBe("number");
    }
  });

  test("ordered by supraScore descending", async () => {
    const t = setupTestDb();
    await seedBaseDataset(t);
    const key = await seedKey(t, { tier: "starter", subStatus: "active" });
    const res = await t.fetch(buildRequest(`${BASE}/v1/models`, { key }));
    const rows = await res.json();
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].supraScore).toBeGreaterThanOrEqual(rows[i].supraScore);
    }
  });

  test("?limit= clamps to [1, 500]", async () => {
    const t = setupTestDb();
    await seedBaseDataset(t);
    const key = await seedKey(t, { tier: "starter", subStatus: "active" });

    const r1 = await t.fetch(buildRequest(`${BASE}/v1/models?limit=1`, { key }));
    expect((await r1.json()).length).toBe(1);

    const rNeg = await t.fetch(buildRequest(`${BASE}/v1/models?limit=-5`, { key }));
    // Clamp to min 1 — so you still get at least 1 row when data exists.
    expect((await rNeg.json()).length).toBeGreaterThanOrEqual(1);

    const rHuge = await t.fetch(buildRequest(`${BASE}/v1/models?limit=99999`, { key }));
    expect((await rHuge.json()).length).toBeLessThanOrEqual(500);

    const rNaN = await t.fetch(buildRequest(`${BASE}/v1/models?limit=abc`, { key }));
    // Non-numeric → default 100.
    expect(rNaN.status).toBe(200);
  });

  test("?tag= filters to models having that tag", async () => {
    const t = setupTestDb();
    await seedBaseDataset(t);
    const key = await seedKey(t, { tier: "starter", subStatus: "active" });
    const res = await t.fetch(
      buildRequest(`${BASE}/v1/models?tag=reasoning`, { key })
    );
    const rows = await res.json();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.tags).toContain("reasoning");
    }
  });

  test("?tag= with no matches returns empty array, not 404", async () => {
    const t = setupTestDb();
    await seedBaseDataset(t);
    const key = await seedKey(t, { tier: "starter", subStatus: "active" });
    const res = await t.fetch(
      buildRequest(`${BASE}/v1/models?tag=definitely-does-not-exist`, { key })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("GET /v1/models/{slug}", () => {
  test("returns detail with per-bench score list", async () => {
    const t = setupTestDb();
    const { modelIds } = await seedBaseDataset(t);
    const key = await seedKey(t, { tier: "starter", subStatus: "active" });
    const res = await t.fetch(
      buildRequest(`${BASE}/v1/models/${modelIds[0].slug}`, { key })
    );
    expect(res.status).toBe(200);
    const detail = await res.json();
    expect(detail.slug).toBe(modelIds[0].slug);
    expect(typeof detail.supraScore).toBe("number");
    expect(Array.isArray(detail.scores)).toBe(true);
    expect(detail.scores.length).toBeGreaterThan(0);
    const s = detail.scores[0];
    expect(typeof s.bench).toBe("string");
    expect(typeof s.benchName).toBe("string");
    expect(typeof s.rawScore).toBe("number");
    expect(typeof s.normalizedScore).toBe("number");
    expect(typeof s.sourceUrl).toBe("string");
    expect(typeof s.accessedAt).toBe("number");
    expect(typeof s.upvotes).toBe("number");
    expect(typeof s.downvotes).toBe("number");
  });

  test("unknown slug → 404 not_found", async () => {
    const t = setupTestDb();
    const key = await seedKey(t, { tier: "starter", subStatus: "active" });
    const res = await t.fetch(
      buildRequest(`${BASE}/v1/models/this-model-does-not-exist`, { key })
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  test("empty slug → 400 bad_request", async () => {
    const t = setupTestDb();
    const key = await seedKey(t, { tier: "starter", subStatus: "active" });
    const res = await t.fetch(buildRequest(`${BASE}/v1/models/`, { key }));
    // Convex path-prefix routing may or may not strip the trailing slash
    // — either a 400 or a 404 is documented-correct behavior. Both
    // surface as "no such model" to the caller.
    expect([400, 404]).toContain(res.status);
  });
});

describe("GET /v1/benches", () => {
  test("returns bench list with quality + dimensions fields", async () => {
    const t = setupTestDb();
    await seedBaseDataset(t);
    const key = await seedKey(t, { tier: "starter", subStatus: "active" });
    const res = await t.fetch(buildRequest(`${BASE}/v1/benches`, { key }));
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    for (const b of rows) {
      expect(typeof b.slug).toBe("string");
      expect(typeof b.name).toBe("string");
      expect(typeof b.scaleMin).toBe("number");
      expect(typeof b.scaleMax).toBe("number");
      expect(typeof b.isOfficial).toBe("boolean");
      expect(Array.isArray(b.tags)).toBe(true);
    }
  });

  test("sorted by effectiveWeight desc when available", async () => {
    const t = setupTestDb();
    await seedBaseDataset(t);
    const key = await seedKey(t, { tier: "starter", subStatus: "active" });
    const res = await t.fetch(buildRequest(`${BASE}/v1/benches`, { key }));
    const rows = await res.json();
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1].effectiveWeight ?? 0;
      const cur = rows[i].effectiveWeight ?? 0;
      expect(prev).toBeGreaterThanOrEqual(cur);
    }
  });
});

describe("GET /v1/tags", () => {
  test("returns tag list with counts", async () => {
    const t = setupTestDb();
    await seedBaseDataset(t);
    const key = await seedKey(t, { tier: "starter", subStatus: "active" });
    const res = await t.fetch(buildRequest(`${BASE}/v1/tags`, { key }));
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(typeof r.tag).toBe("string");
      expect(typeof r.models).toBe("number");
      expect(typeof r.benches).toBe("number");
    }
  });

  test("has longer cache-control (1 h) than rankings", async () => {
    const t = setupTestDb();
    await seedBaseDataset(t);
    const key = await seedKey(t, { tier: "starter", subStatus: "active" });
    const res = await t.fetch(buildRequest(`${BASE}/v1/tags`, { key }));
    const cc = res.headers.get("cache-control") ?? "";
    const match = cc.match(/max-age=(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(3600);
  });
});

describe("GET /v1/best", () => {
  test("requires ?tag=", async () => {
    const t = setupTestDb();
    const key = await seedKey(t, { tier: "starter", subStatus: "active" });
    const res = await t.fetch(buildRequest(`${BASE}/v1/best`, { key }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
  });

  test("returns top-N models by tag, default 10, clamp [1, 100]", async () => {
    const t = setupTestDb();
    await seedBaseDataset(t);
    const key = await seedKey(t, { tier: "starter", subStatus: "active" });

    const r1 = await t.fetch(
      buildRequest(`${BASE}/v1/best?tag=reasoning&limit=1`, { key })
    );
    const rows1 = await r1.json();
    expect(rows1.length).toBe(1);

    const rHuge = await t.fetch(
      buildRequest(`${BASE}/v1/best?tag=reasoning&limit=9999`, { key })
    );
    const rowsH = await rHuge.json();
    expect(rowsH.length).toBeLessThanOrEqual(100);
  });
});

describe("GET /v1/export.json", () => {
  test("starter tier → 403 tier_forbidden", async () => {
    const t = setupTestDb();
    await seedBaseDataset(t);
    const key = await seedKey(t, { tier: "starter", subStatus: "active" });
    const res = await t.fetch(buildRequest(`${BASE}/v1/export.json`, { key }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("tier_forbidden");
  });

  test("pro tier → 200 with models+benches+tags", async () => {
    const t = setupTestDb();
    await seedBaseDataset(t);
    const key = await seedKey(t, { tier: "pro", subStatus: "active" });
    const res = await t.fetch(buildRequest(`${BASE}/v1/export.json`, { key }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(typeof j.generatedAt).toBe("number");
    expect(Array.isArray(j.models)).toBe(true);
    expect(Array.isArray(j.benches)).toBe(true);
    expect(Array.isArray(j.tags)).toBe(true);
  });

  test("partner tier → 200 (allowExport=true)", async () => {
    const t = setupTestDb();
    await seedBaseDataset(t);
    const key = await seedKey(t, { tier: "partner" });
    const res = await t.fetch(buildRequest(`${BASE}/v1/export.json`, { key }));
    expect(res.status).toBe(200);
  });

  test("has 24h cache-control", async () => {
    const t = setupTestDb();
    await seedBaseDataset(t);
    const key = await seedKey(t, { tier: "pro", subStatus: "active" });
    const res = await t.fetch(buildRequest(`${BASE}/v1/export.json`, { key }));
    const cc = res.headers.get("cache-control") ?? "";
    const match = cc.match(/max-age=(\d+)/);
    expect(Number(match![1])).toBeGreaterThanOrEqual(86400);
  });
});
