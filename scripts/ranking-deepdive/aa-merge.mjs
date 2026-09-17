// Experiment 2: production snapshot + dense AA data (fill missing cells on benches we already track,
// add the AA v4.3 index components we do not track). Then run the unified core and the old production math.
import { readFileSync, writeFileSync } from "node:fs";
await import("../../public/js/supra-rank-core.js");
const core = globalThis.SupraRankCore;
const snap = JSON.parse(readFileSync(".ranking-lab/snapshot.json", "utf8"));
const full = JSON.parse(readFileSync(".ranking-lab/aa/aa-models-full-2026-09-17.json", "utf8"));
const detail = JSON.parse(readFileSync(".ranking-lab/aa/aa-models-2026-09-17.json", "utf8"));
const byId = new Map(full.map((m) => [m.slug, { ...m, id: m.slug }])); for (const d of detail) byId.set(d.slug, { ...(byId.get(d.slug) ?? {}), ...d, id: d.slug });
const aa = [...byId.values()].filter((m) => !m.deprecated);
const variant = process.argv[2] ?? "fill+new"; // fill | fill+new
const poolMode = process.argv[3] ?? "tracked"; // tracked = only models already in production; all = also add AA models we lack (frontier30 only)

// AA field -> our bench name, normaliser
const EXISTING = [["hle", "Humanity's Last Exam", (v) => v * 100], ["scicode", "SciCode", (v) => v * 100], ["lcr", "AA Long Context Reasoning", (v) => v * 100], ["terminalbenchHard", "Terminal-Bench Hard", (v) => v * 100], ["terminalBench21", "Terminal-Bench v2.1 (AA Terminus 2)", (v) => v * 100], ["apexAgents", "APEX-Agents-AA", (v) => v * 100], ["automationBenchPartialScore", "AutomationBench-AA", (v) => v * 100], ["mmmuPro", "MMMU-Pro", (v) => v * 100]];
const NEW = [["briefcaseElo", "AA-Briefcase", (v) => (v - 500) / 20, { relevance: 5, contamination: 5, discriminability: 5, reproducibility: 3, difficulty: 5 }], ["gdpval", "GDPval-AA v2", (v) => (v - 500) / 20, { relevance: 5, contamination: 4, discriminability: 5, reproducibility: 3, difficulty: 4 }], ["terminalBench40", "Terminal-Bench 4.0", (v) => v * 100, { relevance: 5, contamination: 4, discriminability: 5, reproducibility: 4, difficulty: 5 }], ["omniscience", "AA-Omniscience", (v) => (v + 100) / 2, { relevance: 4, contamination: 5, discriminability: 5, reproducibility: 3, difficulty: 4 }], ["gdpPdfAllPass", "GDP.pdf", (v) => v * 100, { relevance: 5, contamination: 4, discriminability: 5, reproducibility: 4, difficulty: 5 }], ["critpt", "CritPt", (v) => v * 100, { relevance: 3, contamination: 5, discriminability: 4, reproducibility: 3, difficulty: 5 }]];

const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
const ours = new Map(snap.models.filter((m) => !m.hidden).map((m) => [norm(m.name), m]));
const benchByName = new Map(snap.benches.map((b) => [b.name, b]));
const have = new Set(snap.scores.filter((s) => s.upvotes > s.downvotes).map((s) => s.modelId + "|" + s.benchId));
let filled = 0, added = 0, newModels = 0;
const importRows = [];
const SRC = { hle: "humanitys-last-exam", scicode: "scicode", lcr: "artificial-analysis-long-context-reasoning", terminalbenchHard: "terminalbench-hard", terminalBench21: "terminalbench-v2-1", apexAgents: "apex-agents-aa", automationBenchPartialScore: "automationbench-aa", mmmuPro: "mmmu-pro", briefcaseElo: "aa-briefcase", gdpval: "gdpval-aa", terminalBench40: "terminalbench-4-0", omniscience: "omniscience", gdpPdfAllPass: "gdp-pdf", critpt: "critpt" };
const rec = (a, m, field, bname, v, n, isNewBench) => importRows.push({ model: m.name, modelIsNew: String(m._id).startsWith("aa-"), aaSlug: a.slug, bench: bname, benchIsNew: isNewBench, aaField: field, aaValue: v, normalizedScore: Math.round(n * 100) / 100, sourceUrl: "https://artificialanalysis.ai/evaluations/" + SRC[field] });
const frontierIds = new Set(detail.map((d) => d.slug));
function modelFor(a) {
  const key = norm(a.shortName ?? a.name); let m = ours.get(key);
  if (!m && poolMode === "all" && frontierIds.has(a.id)) { m = { _id: "aa-" + a.id, name: a.shortName ?? a.name, slug: a.slug, provider: a.creator?.name ?? "?", familyTag: (a.shortName ?? a.name).replace(/\s*\([^)]*\)\s*$/, ""), tags: [], hidden: false }; snap.models.push(m); ours.set(key, m); newModels++; }
  return m;
}
function recomputeBench(b) { const per = new Map(); for (const s of snap.scores) if (s.benchId === b._id && s.upvotes > s.downvotes) per.set(s.modelId, s.normalizedScore); const v = [...per.values()].sort((x, y) => y - x); const N = v.length, K = Math.min(10, N); const fm = K ? v.slice(0, K).reduce((p, c) => p + c, 0) / K : 0; b.cachedModelCount = N; b.cachedFrontierMean = fm; b.cachedHeadroom = N < 3 ? 1 : Math.max(0.1, (100 - Math.max(fm, 50)) / 50); const d = b.cachedDimensions; b.cachedQualityScore = (d.relevance + d.contamination + d.discriminability + d.reproducibility) / 4 * 20; b.cachedDifficultyMultiplier = (d.difficulty - 1) / 4; b.cachedEffectiveWeight = b.cachedQualityScore * b.cachedDifficultyMultiplier * b.cachedHeadroom; }
for (const [field, bname, f] of EXISTING) { const b = benchByName.get(bname); if (!b) { console.log("missing bench", bname); continue; } for (const a of aa) { const v = a[field]; if (typeof v !== "number") continue; const m = modelFor(a); if (!m) continue; if (have.has(m._id + "|" + b._id)) continue; snap.scores.push({ modelId: m._id, benchId: b._id, normalizedScore: f(v), upvotes: 1, downvotes: 0 }); have.add(m._id + "|" + b._id); filled++; rec(a, m, field, bname, v, f(v), false); } recomputeBench(b); }
if (variant === "fill+new") for (const [field, bname, f, dims] of NEW) { const b = { _id: "aa-new-" + field, name: bname, slug: field, tags: [], hidden: false, cachedDimensions: dims, cachedRaterCount: 1, cachedNetUpvotes: 1 }; snap.benches.push(b); for (const a of aa) { const v = a[field]; if (typeof v !== "number") continue; const m = modelFor(a); if (!m) continue; snap.scores.push({ modelId: m._id, benchId: b._id, normalizedScore: f(v), upvotes: 1, downvotes: 0 }); added++; rec(a, m, field, bname, v, f(v), true); } recomputeBench(b); }
console.log(`variant=${variant} pool=${poolMode}: filled ${filled} missing cells on tracked benches, added ${added} cells on ${variant === "fill+new" ? NEW.length : 0} new benches, ${newModels} new models`);
const out = `.ranking-lab/scenarios/AA_${variant.replace("+", "_")}_${poolMode}.json`; writeFileSync(out, JSON.stringify(snap));
const r = core.rank(snap); const nm = new Map(snap.models.map((m) => [m._id, m.name]));
console.log("MODEL  :", [...r.configs].filter((c) => c.ability !== null).sort((a, b) => b.ability - a.ability).slice(0, 12).map((c, i) => `${i + 1}.${nm.get(c.modelId)} ${c.supraScore} (${c.benchCount}b)`).join("\n         "));
console.log("FAMILY :", [...r.families].filter((f) => !f.hidden).sort((a, b) => (b.ability ?? -9) - (a.ability ?? -9)).slice(0, 14).map((f, i) => `${i + 1}.${f.familyTag} ${f.supraScore}`).join(" | "));
console.log("bench weights:", snap.benches.filter((b) => !b.hidden).map((b) => [b.name, core.benchWeight(b, r.upvoteMax)]).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n, w]) => `${n} ${w.toFixed(1)}`).join(" | "));
console.log("snapshot written:", out);
if (process.argv[4]) { writeFileSync(process.argv[4], JSON.stringify({ generatedAt: new Date().toISOString(), source: "Artificial Analysis page payloads (self.__next_f → models / initialModels), fetched 2026-09-17", scaleNotes: { fractions: "value × 100", elo: "(Elo − 500) / 20  (AA index normalisation clamp((Elo−500)/2000))", omniscienceIndex: "(index + 100) / 2" }, rows: importRows }, null, 1) + "\n"); console.log("import list:", process.argv[4], importRows.length, "rows"); }
