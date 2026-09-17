// Experiment: feed Artificial Analysis' own dense matrix (their v4.3 index components) through OUR math.
// If our method reproduces the "felt reality" order on dense data, the production gap is data, not formula.
import { readFileSync } from "node:fs";
await import("../../public/js/supra-rank-core.js");
const core = globalThis.SupraRankCore;
const full = JSON.parse(readFileSync(".ranking-lab/aa/aa-models-full-2026-09-17.json", "utf8"));
const detail = JSON.parse(readFileSync(".ranking-lab/aa/aa-models-2026-09-17.json", "utf8"));
const byId = new Map(full.map((m) => [m.id, { ...m }]));
for (const d of detail) byId.set(d.id, { ...(byId.get(d.id) ?? {}), ...d });
const all = [...byId.values()].filter((m) => !m.deprecated);
const BENCHES = [ // id, field, AA v4.3 weight, normaliser to 0-100
  ["AA-Briefcase", "briefcaseElo", 15, (v) => (v - 500) / 20], ["GDPval-AA v2", "gdpval", 10, (v) => (v - 500) / 20], ["AutomationBench-AA", "automationBenchPartialScore", 5, (v) => v * 100],
  ["Terminal-Bench 4.0", "terminalBench40", 10, (v) => v * 100], ["SciCode", "scicode", 10, (v) => v * 100], ["AA-Omniscience", "omniscience", 15, (v) => (v + 100) / 2],
  ["GDP.pdf", "gdpPdfAllPass", 10, (v) => v * 100], ["AA-LCR", "lcr", 5, (v) => v * 100], ["HLE", "hle", 10, (v) => v * 100], ["CritPt", "critpt", 10, (v) => v * 100],
];
const mode = process.argv[2] ?? "frontier30";
const pool = mode === "all" ? all : all.filter((m) => detail.some((d) => d.id === m.id));
const dims = { relevance: 4, contamination: 4, discriminability: 4, reproducibility: 4, difficulty: 4 };
const famOf = (n) => n.replace(/\s*\([^)]*\)\s*$/, "").replace(/ 0813$/, "");
const models = pool.map((m) => ({ _id: m.id, name: m.shortName ?? m.name, provider: m.creator?.name ?? "?", slug: m.slug, familyTag: famOf(m.shortName ?? m.name), tags: [] }));
function run(weights) {
  const benches = BENCHES.map(([id, , w]) => ({ _id: id, cachedDimensions: dims, cachedRaterCount: 50, cachedHeadroom: weights === "aa" ? w / 15 : 1, cachedNetUpvotes: 1 }));
  const scores = []; for (const m of pool) for (const [id, field, , norm] of BENCHES) { const v = m[field]; if (typeof v === "number") scores.push({ modelId: m.id, benchId: id, normalizedScore: norm(v) }); }
  return core.rank({ models, benches, scores });
}
const name = new Map(models.map((m) => [m._id, m.name]));
const aaIdx = new Map(pool.map((m) => [m.id, m.intelligenceIndex]));
for (const w of ["equal", "aa"]) {
  const r = run(w);
  console.log(`\n=== OUR unified pairwise fit on AA's dense matrix — bench weights: ${w} — pool: ${mode} (${pool.length} models) ===`);
  console.log("configs :", [...r.configs].filter((c) => c.ability !== null).sort((a, b) => b.ability - a.ability).slice(0, 14).map((c, i) => `${i + 1}.${name.get(c.modelId)} ${c.supraScore} [AA ${aaIdx.get(c.modelId)?.toFixed(1)}]`).join("\n          "));
  console.log("families:", [...r.families].sort((a, b) => (b.ability ?? -9) - (a.ability ?? -9)).slice(0, 12).map((f, i) => `${i + 1}.${f.familyTag} ${f.supraScore}`).join(" | "));
}
const wm = pool.map((m) => { let s = 0, w = 0; for (const [, field, wt, norm] of BENCHES) { const v = m[field]; if (typeof v === "number") { s += wt * norm(v); w += wt; } } return { n: m.shortName ?? m.name, v: w ? s / w : 0, cov: w }; }).filter((x) => x.cov >= 60).sort((a, b) => b.v - a.v);
console.log("\nweighted raw mean (AA-style, ≥60% weight covered):", wm.slice(0, 10).map((x, i) => `${i + 1}.${x.n} ${x.v.toFixed(1)}`).join(" | "));
