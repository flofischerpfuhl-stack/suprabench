#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_MODELS = 30;
const MAX_BENCHES = 5;
// One run may be split into several batches (YYYY-MM-DD, YYYY-MM-DD-b, …);
// each batch is validated, dry-run and applied on its own.
const MAX_SCORES = 150;
const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}(-[a-z])?$/;
const MAX_EVIDENCE = 60;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function fail(message) {
  throw new Error(message);
}

function publicHttpUrl(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a URL`);
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    fail(`${label} is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    fail(`${label} must use http or https`);
  }
  if (parsed.username || parsed.password) fail(`${label} must not contain credentials`);
  return parsed.toString();
}

function array(value, label, max) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (value.length > max) fail(`${label} exceeds the limit of ${max}`);
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required`);
  return value.trim();
}

function assertInside(parent, child, label) {
  const rel = relative(parent, child);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    fail(`${label} must be below ${parent}`);
  }
}

function validateImage(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) fail(`${label} is missing: ${path}`);
  if (statSync(path).size < 100) fail(`${label} is unexpectedly small: ${path}`);
  const lower = path.toLowerCase();
  const ext = [...IMAGE_EXTENSIONS].find((candidate) => lower.endsWith(candidate));
  if (!ext) fail(`${label} has an unsupported extension: ${path}`);
  const bytes = readFileSync(path).subarray(0, 12);
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  const jpeg = bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
  const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!png && !jpeg && !webp) fail(`${label} is not a valid PNG, JPEG, or WebP file: ${path}`);
}

function validateNoSecrets(text, label) {
  const patterns = [
    /sb_live_[0-9a-f]{32,}/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /CONVEX_DEPLOY_KEY\s*[=:]\s*\S+/i,
    /SCORES_WORKER_SECRET\s*[=:]\s*\S+/i,
  ];
  for (const pattern of patterns) {
    if (pattern.test(text)) fail(`${label} appears to contain a secret (${pattern})`);
  }
}

function loadRun(inputPath) {
  const candidate = resolve(inputPath);
  if (!existsSync(candidate)) fail(`Run path not found: ${candidate}`);
  const manifestPath = statSync(candidate).isDirectory() ? join(candidate, "manifest.json") : candidate;
  if (!existsSync(manifestPath)) fail(`Manifest not found: ${manifestPath}`);
  const runDir = dirname(manifestPath);
  const manifestText = readFileSync(manifestPath, "utf8");
  validateNoSecrets(manifestText, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    fail(`Invalid manifest JSON: ${error.message}`);
  }

  if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1");
  const runId = nonEmptyString(manifest.runId, "runId");
  if (!RUN_ID_PATTERN.test(runId)) fail("runId must use YYYY-MM-DD or YYYY-MM-DD-<letter> for an additional batch");
  if (basename(runDir) !== runId) fail(`Run directory must be named ${runId}`);
  const expectedReportPath = `public/reports/curation/${runId}/index.html`;
  if (manifest.reportPath !== expectedReportPath) fail(`reportPath must be ${expectedReportPath}`);
  if (Number.isNaN(Date.parse(manifest.generatedAt))) fail("generatedAt must be an ISO date-time");

  const reportFile = join(runDir, "index.html");
  if (!existsSync(reportFile)) fail(`HTML report is missing: ${reportFile}`);
  const reportHtml = readFileSync(reportFile, "utf8");
  validateNoSecrets(reportHtml, "index.html");
  if (!/<html[\s>]/i.test(reportHtml) || !/<title[\s>]/i.test(reportHtml)) {
    fail("index.html must be a complete HTML report with a title");
  }

  const models = array(manifest.models, "models", MAX_MODELS);
  const benches = array(manifest.benches, "benches", MAX_BENCHES);
  const scores = array(manifest.scores, "scores", MAX_SCORES);
  const evidence = array(manifest.evidence, "evidence", MAX_EVIDENCE);
  const sources = array(manifest.sources, "sources", 100);
  array(manifest.learnings, "learnings", 30).forEach((item, index) =>
    nonEmptyString(item, `learnings[${index}]`)
  );

  const sourceUrls = new Set();
  sources.forEach((source, index) => {
    nonEmptyString(source.title, `sources[${index}].title`);
    sourceUrls.add(publicHttpUrl(source.url, `sources[${index}].url`));
    if (Number.isNaN(Date.parse(source.accessedAt))) {
      fail(`sources[${index}].accessedAt must be an ISO date-time`);
    }
  });

  const evidenceUrls = new Set();
  evidence.forEach((row, index) => {
    const sourceUrl = publicHttpUrl(row.sourceUrl, `evidence[${index}].sourceUrl`);
    publicHttpUrl(row.screenshotUrl, `evidence[${index}].screenshotUrl`);
    if (!sourceUrls.has(sourceUrl)) fail(`Evidence source is absent from sources: ${sourceUrl}`);
    evidenceUrls.add(sourceUrl);

    const expectedPrefix = `public/reports/curation/${runId}/screenshots/`;
    if (typeof row.screenshotPath !== "string" || !row.screenshotPath.startsWith(expectedPrefix)) {
      fail(`evidence[${index}].screenshotPath must start with ${expectedPrefix}`);
    }
    const screenshotFile = resolve(runDir, relative(`public/reports/curation/${runId}`, row.screenshotPath));
    assertInside(join(runDir, "screenshots"), screenshotFile, `evidence[${index}].screenshotPath`);
    validateImage(screenshotFile, `evidence[${index}] screenshot`);
    const relativeScreenshot = `screenshots/${basename(screenshotFile)}`;
    if (!reportHtml.includes(relativeScreenshot)) {
      fail(`HTML report does not reference ${relativeScreenshot}`);
    }
    if (!reportHtml.includes(sourceUrl)) fail(`HTML report does not link evidence source ${sourceUrl}`);
  });

  benches.forEach((bench, index) => {
    const url = publicHttpUrl(bench.url, `benches[${index}].url`);
    if (!evidenceUrls.has(url)) fail(`Benchmark lacks screenshot evidence: ${url}`);
  });
  scores.forEach((score, index) => {
    const url = publicHttpUrl(score.sourceUrl, `scores[${index}].sourceUrl`);
    if (!evidenceUrls.has(url)) fail(`Score lacks screenshot evidence: ${url}`);
  });

  return {
    manifestPath,
    runDir,
    payload: {
      runId,
      reportPath: expectedReportPath,
      dryRun: true,
      models,
      benches,
      scores,
      evidence,
    },
    counts: {
      models: models.length,
      benches: benches.length,
      scores: scores.length,
      evidence: evidence.length,
      sources: sources.length,
    },
  };
}

function runConvex(payload, deployment) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const convexCli = join(repoRoot, "node_modules", "convex", "bin", "main.js");
  if (!existsSync(convexCli)) {
    fail("Convex CLI is missing; run npm ci before a curation run");
  }
  const result = spawnSync(
    process.execPath,
    [convexCli, "run", "--deployment", deployment, "curation:applyBatch", JSON.stringify(payload)],
    { cwd: repoRoot, stdio: "inherit", shell: false }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function usage() {
  console.error("Usage: node scripts/curation-run.mjs <validate|dry-run|apply> <run-dir-or-manifest> [--deployment <name>]");
  process.exit(2);
}

try {
  const [command, inputPath, ...rest] = process.argv.slice(2);
  if (!command || !inputPath || !["validate", "dry-run", "apply"].includes(command)) usage();
  const deploymentIndex = rest.indexOf("--deployment");
  const deployment = deploymentIndex >= 0 ? rest[deploymentIndex + 1] : undefined;
  if ((command === "dry-run" || command === "apply") && !deployment) usage();
  if (command === "apply" && process.env.SUPRABENCH_ALLOW_APPLY !== "1") {
    fail("Set SUPRABENCH_ALLOW_APPLY=1 for the apply step after reviewing the dry-run output");
  }

  const run = loadRun(inputPath);
  console.log(JSON.stringify({ ok: true, manifest: run.manifestPath, ...run.counts }, null, 2));
  if (command === "dry-run") runConvex({ ...run.payload, dryRun: true }, deployment);
  if (command === "apply") runConvex({ ...run.payload, dryRun: false }, deployment);
} catch (error) {
  console.error(`Curation run failed: ${error.message}`);
  process.exit(1);
}
