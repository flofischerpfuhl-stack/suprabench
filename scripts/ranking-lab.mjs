#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  auditFamilyTags,
  analyzeLeaveOneBenchOut,
  auditTargetPairEvidence,
  buildRanking,
  compareTargetOrder,
  describeBenchRatings,
} from "./lib/ranking-lab-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) options[key] = true;
    else {
      options[key] = value;
      index += 1;
    }
  }
  return { command, options };
}

function runConvex(deployment, functionName) {
  const cli = resolve(repoRoot, "node_modules", "convex", "bin", "main.js");
  if (!existsSync(cli)) throw new Error("Convex CLI missing; run npm ci first");
  const result = spawnSync(
    process.execPath,
    [cli, "run", functionName, "{}", "--deployment", deployment, "--codegen", "disable"],
    { cwd: repoRoot, encoding: "utf8", shell: false },
  );
  if (result.status !== 0) {
    throw new Error(`${functionName} failed:\n${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Could not parse ${functionName} output: ${error.message}`);
  }
}

function sanitizeSnapshot(input, scoreRows, deployment) {
  const models = input.models.map((model) => ({
    _id: String(model._id),
    name: model.name,
    slug: model.slug,
    provider: model.provider,
    familyTag: model.familyTag ?? null,
    tags: model.tags ?? [],
    hidden: Boolean(model.hidden),
  }));
  const benches = input.benches.map((bench) => ({
    _id: String(bench._id),
    name: bench.name,
    slug: bench.slug,
    tags: bench.tags ?? [],
    hidden: Boolean(bench.hidden),
    cachedQualityScore: bench.cachedQualityScore ?? null,
    cachedDimensions: bench.cachedDimensions ?? null,
    cachedRaterCount: bench.cachedRaterCount ?? 0,
    cachedDifficultyMultiplier: bench.cachedDifficultyMultiplier ?? null,
    cachedHeadroom: bench.cachedHeadroom ?? null,
    cachedFrontierMean: bench.cachedFrontierMean ?? null,
    cachedModelCount: bench.cachedModelCount ?? null,
    cachedNetUpvotes: bench.cachedNetUpvotes ?? 1,
    cachedEffectiveWeight: bench.cachedEffectiveWeight ?? null,
  }));
  const scores = scoreRows.map((score) => ({
    modelId: String(score.modelId),
    benchId: String(score.benchId),
    normalizedScore: score.normalizedScore,
    upvotes: score.upvotes,
    downvotes: score.downvotes,
  }));
  const payload = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    deployment,
    models,
    benches,
    scores,
  };
  const canonical = JSON.stringify(payload);
  return {
    ...payload,
    sha256: createHash("sha256").update(canonical).digest("hex"),
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function snapshotCommand(options) {
  const deployment = options.deployment ?? "upbeat-clam-790";
  const output = resolve(repoRoot, options.out ?? ".ranking-lab/snapshot.json");
  const inputs = runConvex(deployment, "rankings:_loadInputsForRebuild");
  const scores = runConvex(deployment, "scoresWorker:_loadAllScores");
  const snapshot = sanitizeSnapshot(inputs, scores, deployment);
  await writeJson(output, snapshot);
  console.log(JSON.stringify({
    ok: true,
    output,
    capturedAt: snapshot.capturedAt,
    sha256: snapshot.sha256,
    models: snapshot.models.length,
    benches: snapshot.benches.length,
    scores: snapshot.scores.length,
  }, null, 2));
}

function scenarioGrid(searchSpace) {
  const keys = Object.keys(searchSpace);
  const rows = [{}];
  for (const key of keys) {
    const next = [];
    for (const row of rows) {
      for (const value of searchSpace[key]) next.push({ ...row, [key]: value });
    }
    rows.splice(0, rows.length, ...next);
  }
  return rows;
}

function compactRow(row) {
  return {
    family: row.familyTag,
    rank: row.rank,
    score: row.score,
    capability: row.weightedMean,
    confidence: row.confidence,
    benches: row.benchCount,
    familyBenches: row.familyBenchCount,
    models: row.modelCount,
    representative: row.representative,
    eligible: row.eligible,
    provisionalRank: row.provisionalRank,
  };
}

function markdownReport(result) {
  const lines = [
    "# SupraBench ranking lab",
    "",
    `Snapshot: ${result.snapshot.capturedAt} · ${result.snapshot.sha256}`,
    "",
    "## Bench rating participation",
    "",
    `- Benchmarks: ${result.ratingParticipation.benchCount}`,
    `- Rater counts: ${JSON.stringify(result.ratingParticipation.raterCounts)}`,
    `- Net upvotes: ${JSON.stringify(result.ratingParticipation.netUpvotes)}`,
    "",
  ];
  for (const scenario of result.scenarios) {
    lines.push(
      `## ${scenario.name}`,
      "",
      `Target pair agreement: ${(scenario.target.agreement * 100).toFixed(1)}% · top-${result.targetOrder.length} recall: ${(scenario.target.topKRecall * 100).toFixed(1)}% · capped rank error: ${scenario.target.meanCappedRankError.toFixed(2)}`,
      "",
    );
    lines.push("| Desired family | Rank | Score | Capability | Confidence | Representative benches | Family benches | Representative |", "|---|---:|---:|---:|---:|---:|---:|---|");
    for (const row of scenario.target.rows) {
      const rank = row.eligible === false ? `provisional ${row.provisionalRank}` : (row.rank ?? "—");
      lines.push(`| ${row.familyTag} | ${rank} | ${row.score ?? "—"} | ${row.weightedMean ?? "—"} | ${row.confidence ?? "—"} | ${row.benchCount ?? "—"} | ${row.familyBenchCount ?? "—"} | ${row.representative ?? ""} |`);
    }
    lines.push("", "Top 12:", "");
    for (const row of scenario.top) {
      const rank = row.eligible ? `${row.rank}.` : `P${row.provisionalRank}.`;
      lines.push(`${rank} ${row.family} — ${row.score} (${row.benches} benches, confidence ${row.confidence})`);
    }
    lines.push("");
    lines.push(
      `Leave-one-benchmark-out: mean rank move ${scenario.robustness.meanAbsoluteRankMove.toFixed(2)} · pairwise stability ${(scenario.robustness.meanPairwiseStability * 100).toFixed(1)}% · worst bench ${scenario.robustness.worstBench}`,
      "",
    );
  }
  lines.push("## Highest structural matches", "");
  for (const row of result.search.slice(0, 12)) {
    lines.push(`- top-${result.targetOrder.length} ${(row.topKRecall * 100).toFixed(1)}%, rank error ${row.meanCappedRankError.toFixed(2)}, pair agreement ${(row.agreement * 100).toFixed(1)}% — ${JSON.stringify(row.scenario)}`);
  }
  lines.push("", "## Adjacent target-pair evidence", "");
  for (const row of result.targetPairEvidence) {
    lines.push(
      `- ${row.higher} > ${row.lower}: ${row.commonBenchCount} common representative benches; ${row.higherWins}-${row.lowerWins}-${row.ties} wins-losses-ties`,
    );
  }
  lines.push("", "## Family-tag audit", "", `Mismatches: ${result.familyAudit.filter((row) => row.differs).length}/${result.familyAudit.length}`, "");
  for (const row of result.familyAudit.filter((row) => row.differs)) {
    lines.push(`- ${row.name}: \`${row.current}\` → \`${row.inferred}\``);
  }
  return `${lines.join("\n")}\n`;
}

async function analyzeCommand(options) {
  const snapshotPath = resolve(repoRoot, options.snapshot ?? ".ranking-lab/snapshot.json");
  const configPath = resolve(repoRoot, options.config ?? "scripts/ranking-lab-scenarios.json");
  const output = resolve(repoRoot, options.out ?? ".ranking-lab/analysis.json");
  const markdown = resolve(repoRoot, options.markdown ?? ".ranking-lab/analysis.md");
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const scenarios = config.scenarios.map((scenario) => {
    const ranking = buildRanking(snapshot, { ...scenario, familyOverrides: config.familyOverrides });
    const target = compareTargetOrder(ranking.familyRanking, config.targetOrder);
    const robustness = analyzeLeaveOneBenchOut(
      snapshot,
      { ...scenario, familyOverrides: config.familyOverrides },
      config.targetOrder,
    );
    return {
      name: scenario.name,
      settings: ranking.scenario,
      target,
      robustness,
      top: ranking.familyRanking.slice(0, 12).map(compactRow),
      families: ranking.familyRanking.map(compactRow),
    };
  });
  const search = scenarioGrid(config.searchSpace).map((scenario, index) => {
    const ranking = buildRanking(snapshot, {
      name: `grid-${index + 1}`,
      priorRaters: config.searchPriorRaters ?? 3,
      familyOverrides: config.familyOverrides,
      ...scenario,
    });
    const target = compareTargetOrder(ranking.familyRanking, config.targetOrder);
    return {
      agreement: target.agreement,
      topKRecall: target.topKRecall,
      meanCappedRankError: target.meanCappedRankError,
      missing: target.missing,
      scenario,
    };
  }).sort(
    (left, right) =>
      right.topKRecall - left.topKRecall ||
      left.meanCappedRankError - right.meanCappedRankError ||
      right.agreement - left.agreement ||
      left.missing.length - right.missing.length,
  );

  const result = {
    generatedAt: new Date().toISOString(),
    snapshot: {
      capturedAt: snapshot.capturedAt,
      sha256: snapshot.sha256,
      deployment: snapshot.deployment,
      models: snapshot.models.length,
      benches: snapshot.benches.length,
      scores: snapshot.scores.length,
    },
    targetOrder: config.targetOrder,
    ratingParticipation: describeBenchRatings(snapshot),
    scenarios,
    search,
    targetPairEvidence: auditTargetPairEvidence(
      snapshot,
      {
        scoreTransform: "percentile",
        ratingMode: "current",
        confidenceMode: "separate",
        familyConfidenceMode: "family-union",
        familyAggregation: "best-config",
        taxonomyMode: "inferred",
        representativeMinBenchCount: 3,
      },
      config.targetOrder,
    ),
    familyAudit: auditFamilyTags(snapshot, config.familyOverrides),
  };
  await writeJson(output, result);
  await mkdir(dirname(markdown), { recursive: true });
  await writeFile(markdown, markdownReport(result), "utf8");
  console.log(JSON.stringify({ ok: true, output, markdown, scenarios: scenarios.length, searched: search.length }, null, 2));
}

function usage() {
  console.log(`Usage:
  npm run ranking:lab -- snapshot [--deployment upbeat-clam-790] [--out .ranking-lab/snapshot.json]
  npm run ranking:lab -- analyze [--snapshot .ranking-lab/snapshot.json] [--config scripts/ranking-lab-scenarios.json]

snapshot reads models/benches once and scores once, sanitizes the result, and writes an immutable local file.
analyze never contacts the database; every scenario runs against that file.`);
}

const { command, options } = parseArgs(process.argv.slice(2));
if (command === "snapshot") await snapshotCommand(options);
else if (command === "analyze") await analyzeCommand(options);
else if (command === "help" || command === "--help" || command === "-h") usage();
else throw new Error(`Unknown command: ${command}`);
