// Build attack / property snapshots on top of the cleaned scenario (S2: ARC-AGI-3 dropped).
// Each one encodes a motivation from the formula's git history so old and new math can be compared.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const base = JSON.parse(readFileSync(resolve(repoRoot, ".ranking-lab", "scenarios", "S2_arc3_dropped.json"), "utf8"));
const outDir = resolve(repoRoot, ".ranking-lab", "attacks"); mkdirSync(outDir, { recursive: true });
const clone = () => JSON.parse(JSON.stringify(base));
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const benchByName = (s, n) => s.benches.find((b) => b.name === n);
const modelByName = (s, n) => s.models.find((m) => m.name === n);
let seq = 1;
function addModel(s, name, provider = "Attacker Labs", familyTag = name) { const m = { _id: `atk-m-${seq++}`, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), provider, familyTag, tags: [], hidden: false }; s.models.push(m); return m; }
function addScore(s, model, bench, v) { s.scores.push({ modelId: model._id, benchId: bench._id, normalizedScore: v, upvotes: 1, downvotes: 0 }); }
function recomputeBench(s, b) { // same rules as production getBenchWeights
  const per = new Map(); const hidden = new Set(s.models.filter((m) => m.hidden).map((m) => m._id));
  for (const sc of s.scores) { if (sc.benchId !== b._id || sc.upvotes <= sc.downvotes || hidden.has(sc.modelId)) continue; (per.get(sc.modelId) ?? per.set(sc.modelId, []).get(sc.modelId)).push(sc.normalizedScore); }
  const meds = [...per.values()].map(med).sort((x, y) => y - x); const N = meds.length; const K = Math.min(10, N); const fm = K ? meds.slice(0, K).reduce((a, c) => a + c, 0) / K : 0;
  const H = N < 3 ? 1 : Math.max(0.1, (100 - Math.max(fm, 50)) / 50); const d = b.cachedDimensions;
  const Q = (d.relevance + d.contamination + d.discriminability + d.reproducibility) / 4 * 20; const D = Math.max(0, Math.min(1, (d.difficulty - 1) / 4));
  Object.assign(b, { cachedModelCount: N, cachedFrontierMean: fm, cachedHeadroom: H, cachedQualityScore: Q, cachedDifficultyMultiplier: D, cachedEffectiveWeight: Q * D * H });
}
function addBench(s, name, upvotes = 1) { const b = { _id: `atk-b-${seq++}`, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), tags: [], hidden: false, cachedDimensions: { relevance: 5, contamination: 5, discriminability: 5, reproducibility: 5, difficulty: 5 }, cachedRaterCount: 1, cachedNetUpvotes: upvotes }; s.benches.push(b); return b; }
const out = {};

// T0 baseline
out.T0_baseline = { snap: clone(), target: "Claude Fable 5.1 (xhigh with fallback)" };

// T1 saturation pump: attacker tops the two most saturated benches (Tau2 H=0.1, TB v2.1 H=0.21) with 100
{ const s = clone(); const m = addModel(s, "SatPump-1"); for (const n of ["Tau2-Bench Telecom", "Terminal-Bench v2.1 (AA Terminus 2)", "AA Long Context Reasoning"]) { const b = benchByName(s, n); addScore(s, m, b, 100); recomputeBench(s, b); } out.T1_saturation_pump = { snap: s, target: "SatPump-1" }; }
// T1b control: same three #1 results but on the least saturated high-weight benches
{ const s = clone(); const m = addModel(s, "HardWin-1"); for (const n of ["Humanity's Last Exam", "SciCode", "APEX-Agents-AA"]) { const b = benchByName(s, n); addScore(s, m, b, 100); recomputeBench(s, b); } out.T1b_hard_bench_control = { snap: s, target: "HardWin-1" }; }

// T2 single-bench peak (A5 / "Sonnet regression"): one model, only HLE = 100
{ const s = clone(); const m = addModel(s, "OneBenchPeak"); const b = benchByName(s, "Humanity's Last Exam"); addScore(s, m, b, 100); recomputeBench(s, b); out.T2_single_bench_peak = { snap: s, target: "OneBenchPeak" }; }

// T3 vanity bench, attacker's model alone on it (A2)
{ const s = clone(); const m = addModel(s, "Vanity-Solo"); const b = addBench(s, "VanityBench"); addScore(s, m, b, 100); recomputeBench(s, b); out.T3_vanity_bench_solo = { snap: s, target: "Vanity-Solo" }; }
// T3b vanity bench where the attacker ALSO submits low scores for the real frontier
{ const s = clone(); const m = addModel(s, "Vanity-Smear"); const b = addBench(s, "VanitySmearBench"); addScore(s, m, b, 100); for (const n of ["Claude Fable 5.1 (xhigh with fallback)", "GPT-6 Astra (xhigh)", "GPT-5.6 Sol", "Claude Fable 5 (adaptive max/fallback)"]) addScore(s, modelByName(s, n), b, 20); recomputeBench(s, b); out.T3b_vanity_bench_smear = { snap: s, target: "Vanity-Smear" }; }
// T3c same smear bench, but the community has endorsed the real benches (every real bench 6 upvotes, vanity 1)
{ const s = clone(); for (const b of s.benches) b.cachedNetUpvotes = 6; const m = addModel(s, "Vanity-Smear"); const b = addBench(s, "VanitySmearBench", 1); addScore(s, m, b, 100); for (const n of ["Claude Fable 5.1 (xhigh with fallback)", "GPT-6 Astra (xhigh)", "GPT-5.6 Sol", "Claude Fable 5 (adaptive max/fallback)"]) addScore(s, modelByName(s, n), b, 20); recomputeBench(s, b); out.T3c_vanity_smear_with_upvotes = { snap: s, target: "Vanity-Smear" }; }
// T4 eight-bench vanity farm with smear (A3-extreme), real benches 6 upvotes
{ const s = clone(); for (const b of s.benches) b.cachedNetUpvotes = 6; const m = addModel(s, "Vanity-Farm"); for (let i = 0; i < 8; i++) { const b = addBench(s, `FarmBench-${i}`, 1); addScore(s, m, b, 100); for (const n of ["Claude Fable 5.1 (xhigh with fallback)", "GPT-6 Astra (xhigh)", "GPT-5.6 Sol"]) addScore(s, modelByName(s, n), b, 20); recomputeBench(s, b); } out.T4_vanity_farm_8 = { snap: s, target: "Vanity-Farm" }; }

// T5 weak-model flooding: 200 junk models on HLE scoring 1-10
{ const s = clone(); const b = benchByName(s, "Humanity's Last Exam"); for (let i = 0; i < 200; i++) addScore(s, addModel(s, `Junk-${i}`, "Junk"), b, 1 + (i % 10)); recomputeBench(s, b); out.T5_flood_HLE_with_junk = { snap: s, target: "Claude Fable 5.1 (xhigh with fallback)" }; }

// T6 cherry-picked configuration: a Sol config that only lists the benches where Sol is #1
{ const s = clone(); const m = addModel(s, "GPT-5.6 Sol (cherry)", "OpenAI", "GPT-5.6 Sol"); for (const [n, v] of [["TextQuests", 51.5], ["Terminal-Bench Hard", 65.9], ["Agents' Last Exam v1 (Codex)", 30.6]]) addScore(s, m, benchByName(s, n), v); out.T6_cherry_config = { snap: s, target: "GPT-5.6 Sol (cherry)" }; }
// T6b same trick for a mid-table family: Kimi K3 lists only its two best placements
{ const s = clone(); const m = addModel(s, "Kimi K3 (cherry)", "Moonshot AI", "Kimi K3"); for (const [n, v] of [["APEX-Agents-AA", 41.3], ["SciCode", 59.1]]) addScore(s, m, benchByName(s, n), v); out.T6b_cherry_config_midtable = { snap: s, target: "Kimi K3 (cherry)" }; }

// T7 monotonicity: Fable 5.1 (max) improves its one weak result
{ const s = clone(); const m = modelByName(s, "Claude Fable 5.1 (max with fallback)"); const b = benchByName(s, "AutomationBench-AA"); for (const sc of s.scores) if (sc.modelId === m._id && sc.benchId === b._id) sc.normalizedScore = 70; recomputeBench(s, b); out.T7_monotone_improvement = { snap: s, target: "Claude Fable 5.1 (max with fallback)" }; }

// T8 hand-off: ARC-AGI-2 becomes fully saturated (every frontier model 97-99)
{ const s = clone(); const b = benchByName(s, "ARC-AGI-2"); const rows = s.scores.filter((sc) => sc.benchId === b._id).sort((x, y) => y.normalizedScore - x.normalizedScore); rows.slice(0, 15).forEach((sc, i) => { sc.normalizedScore = 99 - i * 0.1; }); recomputeBench(s, b); out.T8_arc2_saturates = { snap: s, target: "GPT-6 Astra (max)" }; }

// T9 outlier submission: one attacker submission of 5 for Fable 5.1 xhigh on HLE next to two honest ones
{ const s = clone(); const m = modelByName(s, "Claude Fable 5.1 (xhigh with fallback)"); const b = benchByName(s, "Humanity's Last Exam"); addScore(s, m, b, 58.7); addScore(s, m, b, 5); out.T9_outlier_submission = { snap: s, target: "Claude Fable 5.1 (xhigh with fallback)" }; }

for (const [k, v] of Object.entries(out)) { writeFileSync(resolve(outDir, `${k}.json`), JSON.stringify(v.snap)); writeFileSync(resolve(outDir, `${k}.target`), v.target); }
console.log(Object.keys(out).join("\n"));
