#!/usr/bin/env node
// Sync publishers that expose a complete machine-readable result table:
//   • DeepSWE            https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json
//   • Agents' Last Exam  https://agents-last-exam.org/api/demo/leaderboard  (split "full")
//
// Diffs the full tables against production and writes ordinary curation
// batches (manifest + report + screenshots): `insert` for published cells of
// configurations that already exist in production, `replace` where production
// holds a rounded or outdated value of the same source row. It creates no
// configurations and never writes to the database — run the normal
// validate → dry-run → apply gates on its output.
//
//   node scripts/curation-source-sync.mjs <YYYY-MM-DD> [first-batch-letter]
//
// Rules applied (docs/curation/SCHEDULED_TASK_PROMPT.md §4–6):
//   - exact source value at 0.1 % precision, never the rounded display value
//   - every source row whose configuration exists, not only the "Best" row
//   - no uniform harness on ALE → best row per (model, effort) across harnesses;
//     runs covering < 95 % of the split's tasks are skipped (unfinished runs)
//   - a cell that already has a row from any source is never inserted twice
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [runDate, firstLetter] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate ?? "")) throw new Error("usage: curation-source-sync.mjs YYYY-MM-DD [letter]");
const batchOffset = firstLetter ? firstLetter.charCodeAt(0) - 97 : 0;
const DEPLOYMENT = "upbeat-clam-790";
const MAX_SCORES = 150;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function convexRun(fn) {
  const cli = join(repoRoot, "node_modules", "convex", "bin", "main.js");
  const r = spawnSync(process.execPath, [cli, "run", fn, "{}", "--deployment", DEPLOYMENT, "--codegen", "disable"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${fn} failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const getJson = async (url) => (await fetch(url, { headers: { "user-agent": UA } })).json();

// ── sources → [{benchSlug, page, modelKey, label, raw, note}] ──
const SOURCES = [
  {
    benchSlug: "deepswe", page: "https://deepswe.datacurve.ai/", title: "DeepSWE v1.1 leaderboard",
    data: "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json",
    rows: (j) => j.rows.map((r) => ({ modelKey: norm(r.model + (r.reasoning_effort ?? "")), label: `${r.model} [${r.reasoning_effort ?? "-"}]`, raw: Math.round(r.pass_at_1 * 1000), note: r.harness })),
  },
  {
    benchSlug: "agents-last-exam-v1", page: "https://agents-last-exam.org/leaderboard", title: "Agents' Last Exam v1 leaderboard",
    data: "https://agents-last-exam.org/api/demo/leaderboard",
    rows: (j, skipped) => {
      const effort = (v) => (v ?? "").replace(/^(reasoning|thinking|effort)-/, "");
      const best = new Map();
      for (const r of j.rows.filter((x) => x.split === "full")) {
        const label = `${r.model} [${effort(r.harnessVariant) || "-"}] via ${r.harness}`;
        if (r.tasks < 0.95 * r.splitTasks) { skipped.push(`ALE ${label}: run covers ${r.tasks}/${r.splitTasks} tasks`); continue; }
        const key = norm(r.model.replace(/^anthropic-/, "") + effort(r.harnessVariant));
        if (!best.has(key) || r.passRate > best.get(key).passRate) best.set(key, { ...r, label });
      }
      return [...best.entries()].map(([modelKey, r]) => ({ modelKey, label: r.label, raw: Math.round(r.passRate * 1000), note: r.harness }));
    },
  },
];

const accessedAt = Date.now();
const prod = convexRun("rankings:_loadInputsForRebuild");
const prodScores = convexRun("scoresWorker:_loadAllScores");
const benchBySlug = new Map(prod.benches.map((b) => [b.slug, b]));
const modelByKey = new Map(prod.models.filter((m) => !m.hidden).map((m) => [norm(m.name), m]));
const modelById = new Map(prod.models.map((m) => [m._id, m]));

const ops = [], skipped = [], cleanup = [], perSource = [];
for (const src of SOURCES) {
  const bench = benchBySlug.get(src.benchSlug);
  if (!bench) throw new Error(`benchmark missing in production: ${src.benchSlug}`);
  if (bench.scaleMin !== 0 || bench.scaleMax !== 1000) throw new Error(`${src.benchSlug}: expected scale 0–1000`);
  const rows = src.rows(await getJson(src.data), skipped);
  const cells = new Map(); // modelId -> [score rows]
  for (const s of prodScores) if (s.benchId === bench._id) (cells.get(s.modelId) ?? cells.set(s.modelId, []).get(s.modelId)).push(s);
  let inserts = 0, replaces = 0, same = 0, noConfig = 0;
  for (const r of rows) {
    const model = modelByKey.get(r.modelKey);
    if (!model) { noConfig++; continue; }
    const existing = cells.get(model._id) ?? [];
    if (existing.length === 0) { ops.push({ ...r, src, modelName: model.name, operation: "insert", sourceUrl: src.page }); inserts++; continue; }
    if (existing.length > 1) { skipped.push(`${model.name} | ${src.benchSlug}: ${existing.length} production rows for one cell — needs identity cleanup first`); continue; }
    const row = existing[0];
    if (row.rawScore === r.raw) { same++; continue; }
    if (Math.abs(row.rawScore - r.raw) > 15) { skipped.push(`${model.name} | ${src.benchSlug}: production ${row.rawScore} vs source ${r.raw} differs by more than 1.5 points — check the configuration mapping by hand`); continue; }
    ops.push({ ...r, src, modelName: model.name, operation: "replace", sourceUrl: row.sourceUrl, previous: row.rawScore }); replaces++;
  }
  // older unlabelled rows that duplicate a labelled configuration of the same model
  for (const [modelId, list] of cells) {
    const m = modelById.get(modelId); if (!m || /\(/.test(m.name)) continue;
    for (const [otherId, otherList] of cells) {
      const o = modelById.get(otherId); if (!o || otherId === modelId || o.familyTag !== m.familyTag || !/\(/.test(o.name)) continue;
      if (Math.abs(otherList[0].rawScore - list[0].rawScore) <= 5) cleanup.push(`${src.benchSlug}: "${m.name}" (${list[0].rawScore / 10}) duplicates "${o.name}" (${otherList[0].rawScore / 10})`);
    }
  }
  perSource.push({ title: src.title, published: rows.length, inserts, replaces, same, noConfig });
}
console.log(perSource.map((p) => `${p.title}: ${p.published} source rows → ${p.inserts} insert, ${p.replaces} replace, ${p.same} already exact, ${p.noConfig} without production configuration`).join("\n"));

// ── batches ──
const batches = []; for (let i = 0; i < ops.length; i += MAX_SCORES) batches.push(ops.slice(i, i + MAX_SCORES));
if (batches.length === 0) batches.push([]);
batches.forEach((batch, index) => {
  const letter = index + batchOffset; const runId = letter === 0 ? runDate : `${runDate}-${String.fromCharCode(97 + letter)}`;
  const dir = join(repoRoot, "public", "reports", "curation", runId); const shots = join(dir, "screenshots"); mkdirSync(shots, { recursive: true });
  const urls = [...new Set(batch.map((o) => o.sourceUrl))]; const evidence = [], sources = [];
  for (const url of urls) {
    const name = `${norm(new URL(url).hostname + new URL(url).pathname).slice(0, 60)}.png`; const file = join(shots, name);
    for (let attempt = 0; attempt < 3 && !existsSync(file); attempt++) spawnSync("/usr/bin/google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=1400,3600", "--virtual-time-budget=20000", `--user-agent=${UA}`, `--screenshot=${file}`, url], { encoding: "utf8", timeout: 180000 });
    if (!existsSync(file)) throw new Error(`screenshot failed for ${url}`);
    sources.push({ title: url, url, accessedAt: new Date(accessedAt).toISOString() });
    evidence.push({ sourceUrl: url, screenshotUrl: url, screenshotPath: `public/reports/curation/${runId}/screenshots/${name}` });
  }
  for (const src of SOURCES) sources.push({ title: `${src.title} — machine-readable table`, url: src.data, accessedAt: new Date(accessedAt).toISOString() });
  const manifest = {
    schemaVersion: 1, runId, generatedAt: new Date().toISOString(), reportPath: `public/reports/curation/${runId}/index.html`,
    sources, evidence, models: [], benches: [],
    scores: batch.map((o) => ({ modelName: o.modelName, benchSlug: o.src.benchSlug, rawScore: o.raw, sourceUrl: o.sourceUrl, accessedAt, operation: o.operation })),
    learnings: [
      "DeepSWE and Agents' Last Exam publish complete machine-readable tables (leaderboard-live.json, /api/demo/leaderboard); run `node scripts/curation-source-sync.mjs <date>` instead of reading the visible default view, which hides models, effort levels and decimals.",
      "Agents' Last Exam has no uniform harness: the benchmark is the publisher's table, best row per (model, effort) across harnesses; runs covering under 95 % of the tasks are unfinished and skipped.",
      "A cell is one row: when production already holds a row for a configuration and benchmark, correct it with `replace` on its existing source URL instead of inserting a second row.",
    ],
  };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const table = (rows) => `<table><thead><tr><th>Production configuration</th><th>Benchmark</th><th>Source row</th><th>Operation</th><th>Stored raw (0–1000)</th></tr></thead><tbody>${rows.map((o) => `<tr><td>${esc(o.modelName)}</td><td>${esc(o.src.benchSlug)}</td><td>${esc(o.label)}</td><td>${o.operation}${o.operation === "replace" ? ` (was ${o.previous})` : ""}</td><td>${o.raw}</td></tr>`).join("")}</tbody></table>`;
  writeFileSync(join(dir, "index.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SupraBench curation — ${runId} — complete-table sync (DeepSWE, Agents' Last Exam)</title>
<style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#090c12;color:#f3f6fb}body{max-width:1080px;margin:0 auto;padding:56px 24px;line-height:1.6}h1{font-size:clamp(1.8rem,5vw,3rem);line-height:1.1}p,li{color:#aab5c7}a{color:#8ad5ff}table{border-collapse:collapse;width:100%;font-size:.85rem;margin:12px 0 28px}th,td{border-bottom:1px solid #2b3445;padding:6px 8px;text-align:left}th{color:#f3f6fb}img{max-width:100%;border:1px solid #2b3445;border-radius:10px;margin:8px 0 24px}code{color:#ffd27d}</style></head>
<body><main>
<p>SUPRABENCH · CURATION RUN · ${esc(runId)} · batch ${index + 1} of ${batches.length}</p>
<h1>Complete-table sync: DeepSWE and Agents' Last Exam</h1>
<p>The 2026-09-18 run read the visible default views of these two sources: one "Best" row per model, 21 of 28 DeepSWE models, percentages rounded to whole points, and only Codex-harness rows of Agents' Last Exam. Both publishers expose their complete tables as JSON. This run diffs those tables against production.</p>
<ul>${perSource.map((p) => `<li><strong>${esc(p.title)}</strong>: ${p.published} published rows → ${p.inserts} inserted, ${p.replaces} replaced with the exact value, ${p.same} already exact, ${p.noConfig} belong to configurations production does not track (none created).</li>`).join("")}</ul>
<p><strong>Agents' Last Exam</strong> was tracked as "Agents' Last Exam v1 (Codex)" and admitted only Codex-harness rows, which structurally excluded every vendor whose agent is not Codex. The publisher runs each model in its vendor's agent (Codex, Claude Code, Kimi Code, Grok Build, …) and ranks all rows in one table, so that table is the benchmark: the entry was renamed to "Agents' Last Exam v1" and each configuration now carries its best row across harnesses (harness named below). Pass rate is over all 152 tasks of the split; runs covering fewer than 95 % of them are unfinished and were skipped.</p>
<p>Values are stored at 0.1 % precision from the source's exact figures (<code>pass_at_1</code>, <code>passRate</code>), raw scale 0–1000. Replacements keep the source URL of the row they correct.</p>
<h2>Source evidence</h2>
${evidence.map((e) => `<h3><a href="${esc(e.sourceUrl)}">${esc(e.sourceUrl)}</a></h3><img src="screenshots/${e.screenshotPath.split("/").pop()}" alt="Screenshot at read time" loading="lazy">`).join("\n")}
<p>Machine-readable tables: ${SOURCES.map((s) => `<a href="${s.data}">${s.data}</a>`).join(" · ")}</p>
<h2>Accepted changes (${batch.length})</h2>
${table([...batch].sort((a, b) => a.src.benchSlug.localeCompare(b.src.benchSlug) || b.raw - a.raw))}
<h2>Identity cleanup needed</h2>
${cleanup.length ? `<ul>${cleanup.map((c) => `<li>${esc(c)}</li>`).join("")}</ul><p>These older unlabelled rows repeat a labelled configuration of the same model. They are left in place; merging needs a maintainer decision.</p>` : "<p>None found on these two benchmarks.</p>"}
<h2>Skipped</h2>
${skipped.length ? `<ul>${skipped.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : "<p>Nothing skipped.</p>"}
<p><a href="../">All curation reports</a> · <a href="/">SupraBench</a></p>
</main></body></html>
`);
  console.log(`${runId}: ${batch.length} operations (${batch.filter((o) => o.operation === "insert").length} insert, ${batch.filter((o) => o.operation === "replace").length} replace), ${urls.length} screenshot sources`);
});
if (skipped.length) console.log("skipped:\n  " + skipped.join("\n  "));
if (cleanup.length) console.log("identity cleanup:\n  " + cleanup.join("\n  "));
