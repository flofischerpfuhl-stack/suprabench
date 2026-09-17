#!/usr/bin/env node
// One-time dense backfill from Artificial Analysis (AA).
//
// Why: docs/research/RANKING_REALITY_AUDIT_2026-09-16.md §7.4 — the ranking only
// reflects the frontier when every frontier configuration is measured on the
// same hard benchmarks. AA publishes its full result matrix inside its pages
// (`self.__next_f` payload). This script reads that payload, diffs it against
// production, and writes ordinary curation batches (manifest + report +
// screenshots) that go through the normal validate → dry-run → apply gates.
//
//   node scripts/curation-aa-backfill.mjs <YYYY-MM-DD>
//
// It never writes to the database.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [runDate] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate ?? "")) throw new Error("usage: curation-aa-backfill.mjs YYYY-MM-DD");
const DEPLOYMENT = "upbeat-clam-790";
const AA = "https://artificialanalysis.ai";
const MAX_SCORES = 150, MAX_BENCHES = 5;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

// AA field → tracked benchmark (existing) or benchmark to admit (bench: {...})
const SOURCES = [
  { field: "hle", page: "humanitys-last-exam", slug: "humanity-s-last-exam", kind: "fraction" },
  { field: "scicode", page: "scicode", slug: "scicode", kind: "fraction" },
  { field: "lcr", page: "artificial-analysis-long-context-reasoning", slug: "aa-long-context-reasoning", kind: "fraction" },
  { field: "terminalbenchHard", page: "terminalbench-hard", slug: "terminal-bench-hard", kind: "fraction" },
  { field: "terminalBench21", page: "terminalbench-v2-1", slug: "terminal-bench-v2-1-aa-terminus-2", kind: "fraction" },
  { field: "apexAgents", page: "apex-agents-aa", slug: "apex-agents-aa", kind: "fraction" },
  { field: "automationBenchPartialScore", page: "automationbench-aa", slug: "automationbench-aa", kind: "fraction" },
  { field: "mmmuPro", page: "mmmu-pro", slug: "mmmu-pro", kind: "fraction" },
  { field: "briefcaseElo", page: "aa-briefcase", kind: "elo", bench: {
      name: "AA-Briefcase", description: "Artificial Analysis' private evaluation of long-horizon agentic knowledge work: multi-week business projects with many linked tasks and thousands of source files; deliverables (spreadsheets, presentations, memos) are compared pairwise by a panel of frontier-model judges and aggregated into an Elo rating. Stored as Elo on the publisher's index scale (500–2500).",
      scaleMin: 500, scaleMax: 2500, tags: ["agentic", "professional", "long-horizon", "tool-use"],
      rating: { relevance: 5, contamination: 5, discriminability: 5, reproducibility: 2, difficulty: 5 } } },
  { field: "gdpval", page: "gdpval-aa", kind: "elo", bench: {
      name: "GDPval-AA v2", description: "Artificial Analysis' agentic run of OpenAI's GDPval: economically valuable real-world tasks across 44 occupations and nine industries, completed with shell and browser access; outputs are compared blind and pairwise by a rotating panel of frontier-model judges, Elo anchored to human experts at 1000. Stored as Elo on the publisher's index scale (500–2500).",
      scaleMin: 500, scaleMax: 2500, tags: ["agentic", "professional", "tool-use"],
      rating: { relevance: 5, contamination: 3, discriminability: 4, reproducibility: 2, difficulty: 4 } } },
  { field: "terminalBench40", page: "terminalbench-4-0", kind: "fraction", bench: {
      name: "Terminal-Bench 4.0", description: "Terminal-Bench 4.0 (Laude Institute, Stanford and contributors) as run by Artificial Analysis: 66 hard terminal tasks across software, machine learning, science, operations, security, hardware and media in a real terminal with verification suites; pass@1 averaged over three repeats. Successor to Terminal-Bench 2.1 with recalibrated limits and eight saturated or flawed tasks removed.",
      scaleMin: 0, scaleMax: 1000, tags: ["agentic", "coding", "terminal", "tool-use"],
      rating: { relevance: 5, contamination: 3, discriminability: 5, reproducibility: 4, difficulty: 5 } } },
  { field: "omniscience", page: "omniscience", kind: "index", bench: {
      name: "AA-Omniscience", description: "Artificial Analysis' knowledge and hallucination benchmark: 6,000 questions across six domains with a held-out answer set. The Omniscience Index (−100 to 100) rewards correct answers, penalises hallucinated ones and does not penalise abstaining.",
      scaleMin: -100, scaleMax: 100, tags: ["knowledge", "reasoning"],
      rating: { relevance: 4, contamination: 5, discriminability: 5, reproducibility: 3, difficulty: 4 } } },
  { field: "gdpPdfAllPass", page: "gdp-pdf", kind: "fraction", bench: {
      name: "GDP.pdf", description: "GDP.pdf (Surge AI) as run by Artificial Analysis: long-context reasoning over 100 real professional PDF documents (4,592 pages, ten domains) graded against 1,275 expert-written atomic criteria. The headline score is the share of tasks on which every criterion passes.",
      scaleMin: 0, scaleMax: 1000, tags: ["long context", "professional", "reasoning"],
      rating: { relevance: 5, contamination: 4, discriminability: 5, reproducibility: 3, difficulty: 5 } } },
  { field: "critpt", page: "critpt", kind: "fraction", bench: {
      name: "CritPt", description: "CritPt as run by Artificial Analysis: 71 composite research-level physics challenges with held-out answers and automatic grading; frontier models solve well under half.",
      scaleMin: 0, scaleMax: 1000, tags: ["science", "reasoning", "physics"],
      rating: { relevance: 3, contamination: 5, discriminability: 4, reproducibility: 4, difficulty: 5 } } },
];
// AA short name → production model name (verified by identical values on ≥ 4 shared benchmarks, or same release)
const ALIASES = new Map([
  ["claude fable 5 (with fallback)", "Claude Fable 5 (adaptive max/fallback)"],
  ["glm-5.3-flash", "GLM-5.3-Flash (max)"],
  ["qwen3.8 2.4t a95b", "Qwen3.8 2.4T A95B (max)"],
  ["nemotron 3 ultra", "NVIDIA Nemotron 3 Ultra"],
]);
// Frontier-set models AA lists that production lacks entirely.
const NEW_MODELS = new Map([
  ["deepseek v4 pro 0813 (max)", { name: "DeepSeek V4 Pro 0813 (max)", provider: "DeepSeek", familyTag: "DeepSeek V4 Pro 0813", tags: ["reasoning", "open-weights"] }],
  ["gemini 3.5 flash-lite", { name: "Gemini 3.5 Flash-Lite", provider: "Google", familyTag: "Gemini 3.5 Flash-Lite", tags: ["multimodal"] }],
  ["inkling", { name: "Inkling (xhigh)", provider: "Thinking Machines", familyTag: "Inkling", tags: ["reasoning"] }],
  ["k2 horizon 375b a23b", { name: "K2 Horizon 375B A23B", provider: "MBZUAI IFM", familyTag: "K2 Horizon", tags: ["reasoning", "open-weights"] }],
]);

function slugify(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }
function convexRun(fn) {
  const cli = join(repoRoot, "node_modules", "convex", "bin", "main.js");
  const r = spawnSync(process.execPath, [cli, "run", fn, "{}", "--deployment", DEPLOYMENT, "--codegen", "disable"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${fn} failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
async function payload(url) {
  const html = await (await fetch(url, { headers: { "user-agent": UA } })).text();
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"(.*?)"\]\)<\/script>/gs)].map((m) => JSON.parse(`"${m[1]}"`));
  return chunks.join("");
}
function extractArray(txt, key) {
  let best = null;
  for (let at = txt.indexOf(key); at >= 0; at = txt.indexOf(key, at + 1)) {
    const start = at + key.length - 1; let depth = 0, inStr = false, esc = false, j = start;
    for (; j < txt.length; j++) { const ch = txt[j]; if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; } else if (ch === '"') inStr = true; else if (ch === "[") depth++; else if (ch === "]" && --depth === 0) break; }
    try { const arr = JSON.parse(txt.slice(start, j + 1)); if (Array.isArray(arr) && arr[0] && "intelligenceIndex" in arr[0] && (!best || arr.length > best.length)) best = arr; } catch { /* not the array we want */ }
  }
  if (!best) throw new Error(`payload key ${key} not found`);
  return best;
}

// ── 1. read AA ──────────────────────────────────────────────
const accessedAt = Date.now();
const full = extractArray(await payload(`${AA}/leaderboards/models`), '"models":[');
const detail = extractArray(await payload(`${AA}/evaluations/terminalbench-4-0`), '"initialModels":[');
const aaBySlug = new Map(full.map((m) => [m.slug, { ...m }]));
for (const d of detail) aaBySlug.set(d.slug, { ...(aaBySlug.get(d.slug) ?? {}), ...d });
const aaModels = [...aaBySlug.values()].filter((m) => !m.deprecated);
console.log(`AA: ${full.length} listed, ${detail.length} with full evaluation fields, ${aaModels.length} not deprecated`);

// ── 2. read production ──────────────────────────────────────
const prod = convexRun("rankings:_loadInputsForRebuild");
const prodScores = convexRun("scoresWorker:_loadAllScores");
const benchBySlug = new Map(prod.benches.map((b) => [b.slug, b]));
const modelByLower = new Map(prod.models.filter((m) => !m.hidden).map((m) => [m.name.toLowerCase(), m]));
const haveCell = new Set(prodScores.map((s) => `${s.modelId}|${s.benchId}`));

// ── 3. diff ─────────────────────────────────────────────────
const rows = []; const skipped = [];
const newModelsUsed = new Map();
for (const a of aaModels) {
  const key = (a.shortName ?? a.name).toLowerCase();
  const existing = modelByLower.get(key) ?? (ALIASES.has(key) ? modelByLower.get(ALIASES.get(key).toLowerCase()) : undefined);
  const fresh = existing ? undefined : NEW_MODELS.get(key);
  if (!existing && !fresh) continue;
  for (const src of SOURCES) {
    const v = a[src.field]; if (typeof v !== "number") continue;
    const bench = src.bench ? { slug: slugify(src.bench.name), ...src.bench } : benchBySlug.get(src.slug);
    if (!bench) throw new Error(`tracked bench missing in production: ${src.slug}`);
    if (existing && !src.bench && haveCell.has(`${existing._id}|${bench._id}`)) continue; // cell already present (any source)
    let raw;
    if (src.kind === "elo") raw = Math.round(v);
    else if (src.kind === "index") raw = Math.round(v * 10) / 10;
    else raw = bench.scaleMax === 1000 ? Math.round(v * 1000) : Math.round(v * 1000) / 10; // 0.1 % precision, as displayed by AA
    if (raw < bench.scaleMin || raw > bench.scaleMax) { skipped.push(`${a.shortName} | ${bench.slug} | ${raw} outside ${bench.scaleMin}–${bench.scaleMax} (publisher clamps it)`); continue; }
    const modelName = existing ? existing.name : fresh.name;
    if (fresh) newModelsUsed.set(fresh.name, fresh);
    rows.push({ modelName, aaName: a.shortName ?? a.name, benchSlug: bench.slug, benchName: bench.name, rawScore: raw, sourceUrl: `${AA}/evaluations/${src.page}`, page: src.page, field: src.field, aaValue: v, newBench: Boolean(src.bench), frontier: detail.some((d) => d.slug === a.slug) });
  }
}
console.log(`cells to insert: ${rows.length} (${rows.filter((r) => r.newBench).length} on new benches); new models: ${[...newModelsUsed.keys()].join(", ") || "none"}; skipped: ${skipped.length}`);

// ── 4. pack sources into batches ────────────────────────────
const groups = new Map(); for (const r of rows) (groups.get(r.page) ?? groups.set(r.page, []).get(r.page)).push(r);
const ordered = [...groups.entries()].sort((x, y) => y[1].length - x[1].length);
const batches = [];
for (const [page, list] of ordered) {
  const isNew = list[0].newBench ? 1 : 0;
  let b = batches.find((x) => x.rows.length + list.length <= MAX_SCORES && x.newBenches + isNew <= MAX_BENCHES);
  if (!b) { b = { rows: [], pages: [], newBenches: 0 }; batches.push(b); }
  b.rows.push(...list); b.pages.push(page); b.newBenches += isNew;
}

// ── 5. write artifacts ──────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const createdModels = new Set();
batches.forEach((batch, index) => {
  const runId = index === 0 ? runDate : `${runDate}-${String.fromCharCode(97 + index)}`;
  const dir = join(repoRoot, "public", "reports", "curation", runId); const shots = join(dir, "screenshots"); mkdirSync(shots, { recursive: true });
  const evidence = [], sources = [];
  for (const page of batch.pages) {
    const url = `${AA}/evaluations/${page}`; const file = join(shots, `${page}.png`);
    // Reuse a screenshot taken earlier in the same run; retry slow pages.
    for (let attempt = 0; attempt < 3 && !existsSync(file); attempt++) {
      spawnSync("/usr/bin/google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=1400,3600", "--virtual-time-budget=20000", `--user-agent=${UA}`, `--screenshot=${file}`, url], { encoding: "utf8", timeout: 180000 });
    }
    if (!existsSync(file)) throw new Error(`screenshot failed for ${url}`);
    sources.push({ title: `Artificial Analysis — ${groups.get(page)[0].benchName}`, url, accessedAt: new Date(accessedAt).toISOString() });
    evidence.push({ sourceUrl: url, screenshotUrl: `${url}#score`, screenshotPath: `public/reports/curation/${runId}/screenshots/${page}.png` });
  }
  const benches = SOURCES.filter((s) => s.bench && batch.pages.includes(s.page)).map((s) => ({ name: s.bench.name, slug: slugify(s.bench.name), description: s.bench.description, url: `${AA}/evaluations/${s.page}`, scaleMin: s.bench.scaleMin, scaleMax: s.bench.scaleMax, tags: s.bench.tags, rating: s.bench.rating }));
  const modelNames = new Set(batch.rows.map((r) => r.modelName));
  const models = [...newModelsUsed.values()].filter((m) => modelNames.has(m.name) && !createdModels.has(m.name));
  // a model created in an earlier batch of this run must still be declared identically (idempotent) — declare it again
  const redeclared = [...newModelsUsed.values()].filter((m) => modelNames.has(m.name) && createdModels.has(m.name));
  for (const m of models) createdModels.add(m.name);
  const manifest = {
    schemaVersion: 1, runId, generatedAt: new Date().toISOString(), reportPath: `public/reports/curation/${runId}/index.html`,
    sources, evidence, models: [...models, ...redeclared], benches,
    scores: batch.rows.map((r) => ({ modelName: r.modelName, benchSlug: r.benchSlug, rawScore: r.rawScore, sourceUrl: r.sourceUrl, accessedAt, operation: "insert" })),
    learnings: [
      "Artificial Analysis embeds its complete result matrix in the page payload (self.__next_f → models / initialModels, one field per evaluation); read the full table from there instead of the visible top rows, and keep the screenshot as proof of page, benchmark version and chart.",
      "Import every published cell of a configuration at once under ONE production model name. AA short names map as: 'Claude Fable 5 (with fallback)' = 'Claude Fable 5 (adaptive max/fallback)', 'GLM-5.3-Flash' = 'GLM-5.3-Flash (max)', 'Qwen3.8 2.4T A95B' = 'Qwen3.8 2.4T A95B (max)', 'Nemotron 3 Ultra' = 'NVIDIA Nemotron 3 Ultra'.",
      "Elo benchmarks (AA-Briefcase, GDPval-AA v2) are stored as raw Elo on scale 500–2500, the publisher's own index normalisation; rows below 500 are clamped to zero by the publisher and are not imported. AA-Omniscience is stored as the index on scale −100…100.",
      "Terminal-Bench Hard, APEX-Agents-AA and Tau2-Bench Telecom receive no new frontier rows at the publisher any more; do not spend budget on them. Terminal-Bench 4.0 is the successor of Terminal-Bench v2.1.",
      "A run may use several batches (YYYY-MM-DD, -b, -c …) of up to 150 rows each; never drop verified rows because a batch is full.",
    ],
  };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const byBench = new Map(); for (const r of batch.rows) (byBench.get(r.benchName) ?? byBench.set(r.benchName, []).get(r.benchName)).push(r);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SupraBench curation — ${runId} — dense frontier backfill</title>
<style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#090c12;color:#f3f6fb}body{max-width:1080px;margin:0 auto;padding:56px 24px;line-height:1.6}h1{font-size:clamp(1.8rem,5vw,3rem);line-height:1.1}p,li{color:#aab5c7}a{color:#8ad5ff}table{border-collapse:collapse;width:100%;font-size:.85rem;margin:12px 0 28px}th,td{border-bottom:1px solid #2b3445;padding:6px 8px;text-align:left}th{color:#f3f6fb}img{max-width:100%;border:1px solid #2b3445;border-radius:10px;margin:8px 0 24px}code{color:#ffd27d}.new{color:#8ce6b2}</style></head>
<body><main>
<p>SUPRABENCH · CURATION RUN · ${esc(runId)} · batch ${index + 1} of ${batches.length}</p>
<h1>Dense frontier backfill from Artificial Analysis</h1>
<p>The ranking audit of 16–17 September 2026 showed that SupraBench under-measured the current frontier: Claude Fable 5.1 had five benchmark cells in production while its publisher-run results covered fifteen, results of one release were scattered over several configuration names, and the benchmarks on which every frontier release is measured today had been deferred run after run. This batch inserts cells that Artificial Analysis publishes and production lacked. Nothing is replaced or removed; existing cells — whatever their source — are left untouched.</p>
<p>Values were read from the result matrix embedded in the publisher's pages (payload <code>self.__next_f</code>, arrays <code>models</code> and <code>initialModels</code>) at ${esc(new Date(accessedAt).toISOString())} and rounded to the precision the publisher displays (0.1 %, whole Elo points, 0.1 index points). The screenshots below document page, benchmark version and chart at read time.</p>
<h2>Summary</h2>
<ul><li>${batch.rows.length} score rows inserted across ${batch.pages.length} sources (${batch.rows.filter((r) => r.frontier).length} belong to the publisher's 30 default frontier models).</li>
<li>New benchmarks in this batch: ${benches.length ? benches.map((b) => `<span class="new">${esc(b.name)}</span>`).join(", ") : "none"}.</li>
<li>New models in this batch: ${models.length ? models.map((m) => `<span class="new">${esc(m.name)}</span>`).join(", ") : "none"}.</li></ul>
${benches.length ? `<h2>Benchmarks admitted</h2><table><thead><tr><th>Benchmark</th><th>Scale stored</th><th>Rating (relevance / contamination resistance / discriminability / reproducibility / difficulty)</th><th>Why</th></tr></thead><tbody>${benches.map((b) => `<tr><td><a href="${esc(b.url)}">${esc(b.name)}</a></td><td>${b.scaleMin} … ${b.scaleMax}</td><td>${b.rating.relevance} / ${b.rating.contamination} / ${b.rating.discriminability} / ${b.rating.reproducibility} / ${b.rating.difficulty}</td><td>${esc(b.description)}</td></tr>`).join("")}</tbody></table>
<p>All six benchmarks admitted in this run are components of the Artificial Analysis Intelligence Index v4.3 and are run by the publisher on every current frontier release. Private or judge-graded sets are admitted under the same rule that admitted APEX-Agents-AA, AA-LCR and AutomationBench-AA; the uncertainty is priced into the reproducibility rating (2–3) instead of a deferral.</p>` : ""}
<h2>Source evidence</h2>
${batch.pages.map((page) => `<h3><a href="${AA}/evaluations/${page}">${AA}/evaluations/${page}</a></h3><img src="screenshots/${page}.png" alt="Screenshot of ${esc(page)} at read time" loading="lazy">`).join("\n")}
<h2>Inserted rows</h2>
${[...byBench.entries()].map(([name, list]) => `<h3>${esc(name)} — ${list.length} rows</h3><table><thead><tr><th>Production model</th><th>Publisher row</th><th>Publisher value</th><th>Stored raw score</th></tr></thead><tbody>${list.sort((x, y) => y.rawScore - x.rawScore).map((r) => `<tr><td>${esc(r.modelName)}</td><td>${esc(r.aaName)}</td><td>${r.aaValue}</td><td>${r.rawScore}</td></tr>`).join("")}</tbody></table>`).join("\n")}
${index === 0 && skipped.length ? `<h2>Not imported</h2><ul>${skipped.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
<h2>Validation</h2>
<p>Generated by <code>scripts/curation-aa-backfill.mjs</code>; validated with <code>npm run curation:validate</code>, dry-run against <code>${DEPLOYMENT}</code>, applied once, D1 mirror drift checked afterwards. See the commit that publishes this report for the recorded results.</p>
<p><a href="../">All curation reports</a> · <a href="/">SupraBench</a></p>
</main></body></html>
`;
  writeFileSync(join(dir, "index.html"), html);
  console.log(`${runId}: ${batch.rows.length} rows, ${benches.length} new benches, ${models.length} new models, sources: ${batch.pages.join(", ")}`);
});
