// ════════════════════════════════════════════════════════════
//  SupraBench scores worker — D1-backed CRUD over modelScores.
//
//  Why this exists:
//    Convex is a great primary database but its bandwidth meter
//    is the binding constraint on the free tier. The ranking
//    recompute reads every modelScore on every submission, and
//    that single read pattern would push us over the 1 GB/mo
//    egress quota at ~6k visitors/month. D1 has no egress meter
//    on the free tier (5M reads/day, 100k writes/day), so we
//    park modelScores here and keep the rebuild cheap forever.
//
//  Consumed by:
//    Convex actions only (server-to-server). The browser never
//    talks to this worker, so we don't need CORS or per-user
//    auth — a single shared bearer secret is sufficient.
//
//  Routes (all require Authorization: Bearer <SCORES_SECRET>):
//    GET    /scores               → entire table (compact JSON)
//    GET    /scores/by-model/:id  → all scores for one model
//    GET    /scores/by-bench/:id  → all scores for one bench
//    POST   /scores               → upsert single row (body = score)
//    POST   /scores/bulk          → upsert N rows (body = { scores: [...] })
//    DELETE /scores/:convex_id    → delete by Convex id
//    GET    /health               → 200 ok (no auth) — for uptime checks
//
//  Idempotency:
//    All POSTs use INSERT…ON CONFLICT(convex_id) DO UPDATE so
//    Convex can safely retry after a transient failure.
// ════════════════════════════════════════════════════════════

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(body, init = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: { ...JSON_HEADERS, ...(init.headers || {}) } });
}

function unauthorized() {
  return json({ error: "unauthorized" }, { status: 401 });
}

function notFound() {
  return json({ error: "not_found" }, { status: 404 });
}

function badRequest(msg) {
  return json({ error: "bad_request", message: msg }, { status: 400 });
}

// Constant-time-ish comparison; not strictly needed (this isn't
// user input on a public surface) but cheap belt-and-braces.
function authOk(request, env) {
  const got = request.headers.get("authorization") || "";
  const want = `Bearer ${env.SCORES_SECRET}`;
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function rowFromBody(b, now) {
  // Coerce + validate a single score payload. Any missing required
  // field returns null; callers turn that into a 400.
  if (!b || typeof b !== "object") return null;
  const required = ["convex_id", "modelId", "benchId", "rawScore", "normalizedScore", "accessedAt", "submittedBy", "createdAt"];
  for (const k of required) if (b[k] === undefined || b[k] === null) return null;
  return {
    convex_id:       String(b.convex_id),
    modelId:         String(b.modelId),
    benchId:         String(b.benchId),
    rawScore:        Number(b.rawScore),
    normalizedScore: Number(b.normalizedScore),
    sourceUrl:       String(b.sourceUrl || ""),
    accessedAt:      Number(b.accessedAt),
    submittedBy:     String(b.submittedBy),
    createdAt:       Number(b.createdAt),
    upvotes:         Number(b.upvotes ?? 0),
    downvotes:       Number(b.downvotes ?? 0),
    submitterName:   b.submitterName == null ? null : String(b.submitterName),
    submitterImage:  b.submitterImage == null ? null : String(b.submitterImage),
    mirroredAt:      now,
  };
}

const UPSERT_SQL = `
  INSERT INTO modelScores (
    convex_id, modelId, benchId, rawScore, normalizedScore, sourceUrl,
    accessedAt, submittedBy, createdAt, upvotes, downvotes,
    submitterName, submitterImage, mirroredAt
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(convex_id) DO UPDATE SET
    modelId         = excluded.modelId,
    benchId         = excluded.benchId,
    rawScore        = excluded.rawScore,
    normalizedScore = excluded.normalizedScore,
    sourceUrl       = excluded.sourceUrl,
    accessedAt      = excluded.accessedAt,
    submittedBy     = excluded.submittedBy,
    createdAt       = excluded.createdAt,
    upvotes         = excluded.upvotes,
    downvotes       = excluded.downvotes,
    submitterName   = excluded.submitterName,
    submitterImage  = excluded.submitterImage,
    mirroredAt      = excluded.mirroredAt
`;

function bindUpsert(stmt, r) {
  return stmt.bind(
    r.convex_id, r.modelId, r.benchId, r.rawScore, r.normalizedScore, r.sourceUrl,
    r.accessedAt, r.submittedBy, r.createdAt, r.upvotes, r.downvotes,
    r.submitterName, r.submitterImage, r.mirroredAt,
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health" && request.method === "GET") {
      return json({ ok: true });
    }

    if (!authOk(request, env)) return unauthorized();

    if (path === "/scores" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT convex_id, modelId, benchId, rawScore, normalizedScore, sourceUrl, accessedAt, submittedBy, createdAt, upvotes, downvotes, submitterName, submitterImage FROM modelScores",
      ).all();
      return json({ scores: results });
    }

    if (path.startsWith("/scores/by-model/") && request.method === "GET") {
      const modelId = decodeURIComponent(path.slice("/scores/by-model/".length));
      if (!modelId) return badRequest("missing modelId");
      const { results } = await env.DB.prepare(
        "SELECT convex_id, modelId, benchId, rawScore, normalizedScore, sourceUrl, accessedAt, submittedBy, createdAt, upvotes, downvotes, submitterName, submitterImage FROM modelScores WHERE modelId = ?",
      ).bind(modelId).all();
      return json({ scores: results });
    }

    if (path.startsWith("/scores/by-bench/") && request.method === "GET") {
      const benchId = decodeURIComponent(path.slice("/scores/by-bench/".length));
      if (!benchId) return badRequest("missing benchId");
      const { results } = await env.DB.prepare(
        "SELECT convex_id, modelId, benchId, rawScore, normalizedScore, sourceUrl, accessedAt, submittedBy, createdAt, upvotes, downvotes, submitterName, submitterImage FROM modelScores WHERE benchId = ?",
      ).bind(benchId).all();
      return json({ scores: results });
    }

    if (path === "/scores" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const now = Date.now();
      const row = rowFromBody(body, now);
      if (!row) return badRequest("invalid score payload");
      await bindUpsert(env.DB.prepare(UPSERT_SQL), row).run();
      return json({ ok: true, convex_id: row.convex_id });
    }

    if (path === "/scores/bulk" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body || !Array.isArray(body.scores)) return badRequest("expected { scores: [...] }");
      const now = Date.now();
      const rows = [];
      for (const s of body.scores) {
        const r = rowFromBody(s, now);
        if (!r) return badRequest("invalid score in batch");
        rows.push(r);
      }
      // D1 batch is atomic — all-or-nothing per request, which
      // matches what the migration script wants (no half-mirrored
      // state if a single row blows up).
      const stmt = env.DB.prepare(UPSERT_SQL);
      const stmts = rows.map((r) => bindUpsert(stmt, r));
      if (stmts.length === 0) return json({ ok: true, count: 0 });
      await env.DB.batch(stmts);
      return json({ ok: true, count: rows.length });
    }

    if (path.startsWith("/scores/") && request.method === "DELETE") {
      const id = decodeURIComponent(path.slice("/scores/".length));
      if (!id) return badRequest("missing id");
      await env.DB.prepare("DELETE FROM modelScores WHERE convex_id = ?").bind(id).run();
      return json({ ok: true });
    }

    return notFound();
  },
};
