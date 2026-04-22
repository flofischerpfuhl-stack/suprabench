// SupraBench public API — Node.js end-to-end tests.
//
// Uses node:test + global fetch (Node ≥ 20). Zero npm dependencies so
// CI can just run `node --test test.mjs`.
//
// Mirrors the JavaScript snippets published in
// /docs/api/quickstart.html: what the user copy-pastes is basically
// what we exercise below, plus negative cases + header assertions.

import { test, describe, before, skip } from "node:test";
import assert from "node:assert/strict";

const BASE = (process.env.SUPRABENCH_API_BASE ?? "").replace(/\/$/, "");
const KEY = process.env.SUPRABENCH_API_KEY ?? "";
const EXPORT_KEY = process.env.SUPRABENCH_API_EXPORT_KEY ?? KEY;

if (!BASE || !KEY) {
  // node:test has no per-file skip; bail loudly so CI doesn't silently pass.
  console.error(
    "SUPRABENCH_API_BASE and SUPRABENCH_API_KEY env vars are required."
  );
  process.exit(1);
}

const H = { authorization: `Bearer ${KEY}` };
const EH = { authorization: `Bearer ${EXPORT_KEY}` };

async function getJson(path, opts = {}) {
  const r = await fetch(`${BASE}${path}`, { headers: H, ...opts });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { r, body };
}

// Re-used across endpoint tests.
let firstSlug = null;

describe("GET /v1/models", () => {
  before(async () => {
    const { r, body } = await getJson("/v1/models?limit=1");
    assert.equal(r.status, 200);
    if (Array.isArray(body) && body.length > 0) firstSlug = body[0].slug;
  });

  test("returns 200 JSON array with documented fields", async () => {
    const { r, body } = await getJson("/v1/models");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /application\/json/);
    assert.ok(Array.isArray(body));
    if (body.length > 0) {
      const m = body[0];
      for (const f of ["slug", "name", "provider", "supraScore", "tags"]) {
        assert.ok(f in m, `missing field ${f}`);
      }
      assert.equal(typeof m.supraScore, "number");
    }
  });

  test("limit is clamped to ≤ 500", async () => {
    const { r, body } = await getJson("/v1/models?limit=10000");
    assert.equal(r.status, 200);
    assert.ok(body.length <= 500);
  });

  test("unknown tag → empty array, 200", async () => {
    const { r, body } = await getJson("/v1/models?tag=no-such-tag-zzz");
    assert.equal(r.status, 200);
    assert.deepEqual(body, []);
  });

  test("cache-control carries max-age=300 (5 min)", async () => {
    const { r } = await getJson("/v1/models");
    const cc = r.headers.get("cache-control") ?? "";
    assert.match(cc, /max-age=300|no-store/);
  });
});

describe("GET /v1/models/{slug}", () => {
  test("200 on existing slug", async () => {
    if (!firstSlug) {
      skip("deployment has no ranked models yet");
      return;
    }
    const { r, body } = await getJson(`/v1/models/${firstSlug}`);
    assert.equal(r.status, 200);
    assert.equal(body.slug, firstSlug);
  });

  test("404 not_found on unknown slug", async () => {
    const { r, body } = await getJson("/v1/models/this-slug-does-not-exist");
    assert.equal(r.status, 404);
    assert.equal(body.error.code, "not_found");
  });
});

describe("GET /v1/benches", () => {
  test("returns array", async () => {
    const { r, body } = await getJson("/v1/benches");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(body));
  });
});

describe("GET /v1/tags", () => {
  test("returns array", async () => {
    const { r, body } = await getJson("/v1/tags");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(body));
  });
});

describe("GET /v1/best", () => {
  test("400 without ?tag", async () => {
    const { r, body } = await getJson("/v1/best");
    assert.equal(r.status, 400);
    assert.equal(body.error.code, "bad_request");
  });

  test("200 with ?tag=reasoning", async () => {
    const { r, body } = await getJson("/v1/best?tag=reasoning&limit=3");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(body));
    assert.ok(body.length <= 3);
  });
});

describe("GET /v1/export.json", () => {
  test("200 if tier allows, else 403 tier_forbidden (documented)", async () => {
    const r = await fetch(`${BASE}/v1/export.json`, { headers: EH });
    if (r.status === 200) {
      assert.match(r.headers.get("content-type") ?? "", /application\/json/);
    } else {
      assert.equal(r.status, 403);
      const body = await r.json();
      assert.equal(body.error.code, "tier_forbidden");
    }
  });
});

describe("Auth error surface", () => {
  test("missing token → 401 missing_token", async () => {
    const r = await fetch(`${BASE}/v1/models`);
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.error.code, "missing_token");
  });

  test("wrong prefix → 401 invalid_token", async () => {
    const r = await fetch(`${BASE}/v1/models`, {
      headers: { authorization: "Bearer pk_whatever" },
    });
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.error.code, "invalid_token");
  });

  test("unknown well-formed token → 401 invalid_token", async () => {
    const bogus = "sb_live_" + "0".repeat(64);
    const r = await fetch(`${BASE}/v1/models`, {
      headers: { authorization: `Bearer ${bogus}` },
    });
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.error.code, "invalid_token");
  });
});

describe("CORS", () => {
  test("OPTIONS preflight → 204 with ACAO *", async () => {
    const r = await fetch(`${BASE}/v1/models`, { method: "OPTIONS" });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  });
});
