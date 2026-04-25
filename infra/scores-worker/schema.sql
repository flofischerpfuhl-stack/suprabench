-- ════════════════════════════════════════════════════════════
--  D1 schema for modelScores (offloaded from Convex).
--
--  Convex remains the primary store during phase-1 of the
--  migration; D1 is a read replica fed by mirror actions and
--  consumed by the ranking-recompute action to keep score
--  reads off the Convex bandwidth meter.
--
--  IDs:
--    convex_id  = Convex document _id (string).
--                 We keep the same ID so writes from any path
--                 (mirror, batch backfill) stay idempotent and
--                 we can dual-read during cutover.
--    modelId / benchId / submittedBy = Convex document IDs as
--                 opaque strings; D1 doesn't validate, the
--                 Worker is the source of truth for shape.
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS modelScores (
  convex_id        TEXT PRIMARY KEY,
  modelId          TEXT NOT NULL,
  benchId          TEXT NOT NULL,
  rawScore         REAL NOT NULL,
  normalizedScore  REAL NOT NULL,
  sourceUrl        TEXT NOT NULL DEFAULT '',
  accessedAt       INTEGER NOT NULL,
  submittedBy      TEXT NOT NULL,
  createdAt        INTEGER NOT NULL,
  upvotes          INTEGER NOT NULL DEFAULT 0,
  downvotes        INTEGER NOT NULL DEFAULT 0,
  submitterName    TEXT,
  submitterImage   TEXT,
  -- Mirror bookkeeping. Lets us tell when a row was last seen
  -- by the mirror action so a future delta-sync cron can find
  -- drift cheaply (WHERE updatedAt < <cutoff>).
  mirroredAt       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scores_model        ON modelScores(modelId);
CREATE INDEX IF NOT EXISTS idx_scores_bench        ON modelScores(benchId);
CREATE INDEX IF NOT EXISTS idx_scores_model_bench  ON modelScores(modelId, benchId);
CREATE INDEX IF NOT EXISTS idx_scores_submitter    ON modelScores(submittedBy, createdAt);
