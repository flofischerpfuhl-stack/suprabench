#!/usr/bin/env node
// ════════════════════════════════════════════════════════════
// Seed runner.
//
// Reads scripts/seed-data.json (format: see SEED_PROMPT.md), chunks
// it so no single mutation exceeds Convex's 1 MB arg / 16 MB txn
// limit, and calls internal.seed.applyChunk one chunk at a time via
// `npx convex run`. Finally calls internal.seed.recomputeAll.
//
// Idempotent on repeat runs: the mutation itself dedupes by slug +
// (model, bench, sourceUrl).
//
// Usage (prod):
//   node scripts/run-seed.mjs            # → prod by default
//   node scripts/run-seed.mjs --dev      # → dev deployment
//   node scripts/run-seed.mjs --file=custom.json
//   node scripts/run-seed.mjs --dry-run  # validate only, no insert
// ════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Arg parsing ──
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const match = args.find((a) => a.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : dflt;
};

const env = flag("dev") ? "dev" : "prod";
const dryRun = flag("dry-run");
const filePath = resolve(
  __dirname,
  opt("file", "seed-data.json")
);

// ── Load & validate ──
if (!existsSync(filePath)) {
  console.error(`\x1b[31mFile not found: ${filePath}\x1b[0m`);
  console.error(
    `Hint: generate it first using scripts/SEED_PROMPT.md with Cursor Composer,`
  );
  console.error(
    `or copy scripts/seed-data.template.json → scripts/seed-data.json.`
  );
  process.exit(1);
}

let data;
try {
  data = JSON.parse(readFileSync(filePath, "utf-8"));
} catch (e) {
  console.error(`\x1b[31mInvalid JSON: ${e.message}\x1b[0m`);
  process.exit(1);
}

if (!Array.isArray(data)) {
  console.error(
    `\x1b[31mTop-level of seed data must be an array of bench-entries.\x1b[0m`
  );
  process.exit(1);
}

// Local validation — catches format errors before they waste a Convex
// round-trip. Full schema validation also runs inside applyChunk.
const problems = [];
let totalScores = 0;
for (let i = 0; i < data.length; i++) {
  const b = data[i];
  const pfx = `entries[${i}] (${b?.name ?? "?"})`;
  if (!b || typeof b !== "object") {
    problems.push(`${pfx}: not an object`);
    continue;
  }
  for (const f of ["name", "description", "url"]) {
    if (typeof b[f] !== "string" || !b[f].trim())
      problems.push(`${pfx}: missing string ${f}`);
  }
  if (typeof b.scaleMin !== "number" || typeof b.scaleMax !== "number")
    problems.push(`${pfx}: scaleMin/scaleMax must be numbers`);
  if (b.scaleMax !== undefined && b.scaleMin !== undefined && b.scaleMax <= b.scaleMin)
    problems.push(`${pfx}: scaleMax (${b.scaleMax}) must be > scaleMin (${b.scaleMin})`);
  if (!Array.isArray(b.scores)) {
    problems.push(`${pfx}: scores must be an array`);
    continue;
  }
  for (let j = 0; j < b.scores.length; j++) {
    const s = b.scores[j];
    const sp = `${pfx} → scores[${j}] (${s?.model?.name ?? "?"})`;
    if (!s.model || !s.model.name || !s.model.provider)
      problems.push(`${sp}: model.name + model.provider required`);
    if (typeof s.rawScore !== "number" || !Number.isFinite(s.rawScore))
      problems.push(`${sp}: rawScore must be a finite number`);
    if (typeof s.sourceUrl !== "string" || !/^https?:\/\//.test(s.sourceUrl))
      problems.push(`${sp}: sourceUrl must be an http(s) URL`);
    if (typeof s.accessedAt !== "number" || s.accessedAt <= 0)
      problems.push(`${sp}: accessedAt must be a Unix-ms number (e.g. Date.now() when you captured it)`);
    if (s.rawScore < b.scaleMin || s.rawScore > b.scaleMax)
      problems.push(`${sp}: rawScore ${s.rawScore} outside [${b.scaleMin}, ${b.scaleMax}]`);
    totalScores++;
  }
}

if (problems.length > 0) {
  console.error(`\x1b[31mFound ${problems.length} problems:\x1b[0m`);
  for (const p of problems.slice(0, 40)) console.error("  - " + p);
  if (problems.length > 40) console.error(`  ... and ${problems.length - 40} more`);
  process.exit(1);
}

console.log(
  `\x1b[32m✓\x1b[0m Loaded ${data.length} benchmarks with ${totalScores} total scores from ${filePath}`
);

if (dryRun) {
  console.log(`\x1b[33mDry-run: not calling Convex.\x1b[0m`);
  process.exit(0);
}

// ── Chunking ──
// Keep each chunk < 800 KB serialized. One bench with 60 scores
// averages ~45 KB so "≤ 4 benches per chunk" is a safe default.
const CHUNK_SIZE_BENCHES = 4;

const chunks = [];
for (let i = 0; i < data.length; i += CHUNK_SIZE_BENCHES) {
  chunks.push(data.slice(i, i + CHUNK_SIZE_BENCHES));
}

// ── Invoke Convex one chunk at a time ──
const convexArgs = env === "prod" ? "--prod" : "";

function runConvex(fn, argsObj) {
  const argJson = JSON.stringify(argsObj);
  // `convex run` takes args as a positional JSON string. We have to
  // shell-quote it, which is fine as long as the chunk stays under
  // the OS argv cap (~128 KB on Linux). Chunks are sized for that.
  const quoted = "'" + argJson.replace(/'/g, "'\\''") + "'";
  try {
    const out = execSync(
      `npx convex run ${convexArgs} ${fn} ${quoted} --no-push`,
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 16 * 1024 * 1024,
      }
    );
    // `convex run` prints the function's return value as pretty-
    // formatted JSON (often multi-line). Try the whole stdout first,
    // then progressively trim status-line prefixes until it parses.
    const trimmed = out.trim();
    try { return JSON.parse(trimmed); } catch {}
    const nlIdx = trimmed.indexOf("\n");
    if (nlIdx > 0) {
      try { return JSON.parse(trimmed.slice(nlIdx + 1).trim()); } catch {}
    }
    return null;
  } catch (e) {
    throw new Error(`convex run ${fn} failed: ${e.message}`);
  }
}

// Pre-create the service user so the first chunk isn't bottle-necked
// by the ensureServiceUser race-condition guard inside each entry.
console.log(`\x1b[36m→\x1b[0m Ensuring service user exists…`);
runConvex("seed:ensureServiceUser", {});

const totals = {
  benchesCreated: 0, benchesReused: 0,
  modelsCreated: 0, modelsReused: 0,
  scoresInserted: 0, scoresSkipped: 0,
  errors: [],
};

for (let i = 0; i < chunks.length; i++) {
  console.log(
    `\x1b[36m→\x1b[0m Applying chunk ${i + 1}/${chunks.length} (${chunks[i].length} benches, ${chunks[i].reduce((n, b) => n + b.scores.length, 0)} scores)…`
  );
  const stats = runConvex("seed:applyChunk", { entries: chunks[i] });
  totals.benchesCreated  += stats.benchesCreated;
  totals.benchesReused   += stats.benchesReused;
  totals.modelsCreated   += stats.modelsCreated;
  totals.modelsReused    += stats.modelsReused;
  totals.scoresInserted  += stats.scoresInserted;
  totals.scoresSkipped   += stats.scoresSkipped;
  totals.errors.push(...stats.errors);
}

console.log(`\x1b[36m→\x1b[0m Recomputing rankings + caches…`);
runConvex("seed:recomputeAll", {});

console.log(`\n\x1b[1mSummary (${env}):\x1b[0m`);
console.log(`  benches: +${totals.benchesCreated} new, ${totals.benchesReused} reused`);
console.log(`  models:  +${totals.modelsCreated} new, ${totals.modelsReused} reused`);
console.log(`  scores:  +${totals.scoresInserted} inserted, ${totals.scoresSkipped} skipped (dupes)`);
if (totals.errors.length > 0) {
  console.log(`\n\x1b[33m⚠  ${totals.errors.length} row-level errors:\x1b[0m`);
  for (const e of totals.errors.slice(0, 20)) console.log("  - " + e);
  if (totals.errors.length > 20) console.log(`  ... and ${totals.errors.length - 20} more`);
}
console.log();
