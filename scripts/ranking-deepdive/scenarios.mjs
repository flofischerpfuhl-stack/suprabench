// Build data-scenario snapshots from the frozen production snapshot.
//   S0 current
//   S1 ARC-AGI-3: drop the six OpenAI-blog rows (keep ARC-Prize verified: Opus 5 High, Grok 4.5)
//   S2 ARC-AGI-3 dropped entirely
//   S3 S0 + GDPval-AA v2 + AA-Briefcase (real AA numbers, Elo normalized clamp((Elo-500)/2000)*100)
//   S4 S2 + GDPval-AA v2 + AA-Briefcase
//   S5 S1 + GDPval-AA v2 + AA-Briefcase
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const base = JSON.parse(readFileSync(resolve(repoRoot, ".ranking-lab", "snapshot.json"), "utf8"));
const outDir = resolve(repoRoot, ".ranking-lab", "scenarios");
mkdirSync(outDir, { recursive: true });

// ---- AA data (fetched 2026-09-16 from artificialanalysis.ai/evaluations/gdpval-aa and /aa-briefcase) ----
const GDPVAL = [
  ["Claude Fable 5.1 (max with fallback)", 1764], ["Claude Fable 5.1 (xhigh with fallback)", 1745], ["Claude Opus 5 (adaptive max)", 1735], ["Claude Opus 5 (adaptive xhigh)", 1708],
  ["Muse Spark 1.3 (max)", 1703], ["Qwen3.8-Max (xhigh)", 1689], ["Grok 4.6 (xhigh)", 1663], ["Muse Spark 1.3 (xhigh)", 1662], ["GLM-5.3 (max)", 1655], ["GLM-5.3-Flash (max)", 1655],
  ["Claude Fable 5.1 (high with fallback)", 1650], ["Qwen3.8-Flash-Next", 1647], ["Grok 4.6 (high)", 1643], ["Grok 4.6 (medium)", 1643], ["DeepSeek V4.1 Flash (max)", 1632],
  ["Claude Fable 5 (adaptive max/fallback)", 1631], ["Qwen3.8 Max", 1630], ["Claude Opus 5 (High)", 1629], ["Qwen3.8 2.4T A95B (max)", 1628], ["GPT-5.6 Sol (max)", 1624],
  ["GPT-5.6 Sol (xhigh)", 1585], ["GPT-6 Astra (max)", 1580], ["Claude Fable 5.1 (medium with fallback)", 1579], ["DeepSeek V4 Flash Vision (max)", 1577], ["Agnes 3.0 Flash", 1573],
  ["GPT-6 Astra (xhigh)", 1555], ["Kimi K3 (max)", 1551], ["GPT-6 Astra (high)", 1530], ["Claude Opus 5 (medium)", 1525], ["GPT-5.6 Sol (high)", 1524],
  ["Muse Spark 1.2 (xhigh)", 1523], ["Claude Fable 5.1 (low with fallback)", 1504], ["Claude Sonnet 5 (Max)", 1501], ["GPT-6 Astra (medium)", 1501], ["DeepSeek V4 Pro (Max)", 1493],
  ["Claude Opus 4.8 (max)", 1489], ["GPT-5.6 Terra (xhigh)", 1479], ["GPT-5.6 Terra (max)", 1477], ["Gemini 3.8 Flash (high)", 1464], ["Qwen3.8 27B (xhigh)", 1463],
];
const BRIEFCASE = [
  ["Claude Fable 5.1 (max with fallback)", 1662], ["Claude Fable 5.1 (xhigh with fallback)", 1650], ["Claude Opus 5 (adaptive max)", 1645], ["Claude Opus 5 (adaptive xhigh)", 1625],
  ["Qwen3.8-Max (xhigh)", 1622], ["Muse Spark 1.3 (max)", 1589], ["Qwen3.8-Flash-Next", 1587], ["Claude Fable 5.1 (high with fallback)", 1578], ["GPT-6 Astra (max)", 1562],
  ["Claude Opus 5 (High)", 1557], ["Grok 4.6 (xhigh)", 1545], ["Grok 4.6 (high)", 1534], ["GPT-6 Astra (xhigh)", 1534], ["Claude Fable 5.1 (medium with fallback)", 1531],
  ["Claude Fable 5 (adaptive max/fallback)", 1530], ["GLM-5.3 (max)", 1511], ["GPT-6 Astra (high)", 1494], ["Grok 4.6 (medium)", 1491], ["Kimi K3 (max)", 1488],
  ["Claude Fable 5.1 (low with fallback)", 1484], ["Muse Spark 1.3 (xhigh)", 1483], ["GPT-5.6 Sol (max)", 1475], ["GPT-6 Astra (medium)", 1451], ["GLM-5.3-Flash (max)", 1449],
  ["Claude Opus 5 (medium)", 1439], ["Qwen3.8 2.4T A95B (max)", 1439], ["GPT-5.6 Sol (xhigh)", 1435], ["DeepSeek V4 Flash Vision (max)", 1432], ["DeepSeek V4.1 Flash (max)", 1424],
  ["Qwen3.8 27B (xhigh)", 1398], ["Qwen3.8 Max", 1388], ["Qwen3.8 27B (medium)", 1376], ["GPT-5.6 Sol (high)", 1361], ["Claude Sonnet 5 (Max)", 1355], ["Muse Spark 1.2 (xhigh)", 1344],
  ["GPT-5.6 Terra (xhigh)", 1337], ["GPT-5.6 Luna (max)", 1333], ["GPT-5.6 Terra (max)", 1330], ["Claude Opus 4.8 (max)", 1316], ["K2 Horizon 375B A23B", 1298],
  ["Grok 4.6 (low)", 1293], ["Grok 4.5", 1283], ["Qwen3.8 27B (low)", 1277], ["Claude Sonnet 5 (xhigh)", 1273], ["GPT-5.6 Luna (xhigh)", 1268], ["DeepSeek V4 Pro (Max)", 1265],
  ["GPT-6 Astra (low)", 1253], ["DeepSeek V4 Flash (Max)", 1253], ["Claude Opus 4.7 (max)", 1252], ["GPT-5.6 Sol (medium)", 1240],
];
const elo = (e) => Math.max(0, Math.min(100, ((e - 500) / 2000) * 100));

const byName = new Map(base.models.map((m) => [m.name.toLowerCase(), m]));
const provider = (n) => /claude/i.test(n) ? "Anthropic" : /gpt/i.test(n) ? "OpenAI" : /qwen/i.test(n) ? "Alibaba" : /muse/i.test(n) ? "Meta" : /grok/i.test(n) ? "xAI" : /glm/i.test(n) ? "Zhipu AI" : /deepseek/i.test(n) ? "DeepSeek" : /kimi|k2 /i.test(n) ? "Moonshot AI" : /gemini/i.test(n) ? "Google" : "Other";
const family = (n) => n.replace(/\s*\([^)]*\)\s*$/, "").replace(/^Qwen3\.8 Max$/, "Qwen3.8-Max").replace(/^Qwen3\.8-Max$/, "Qwen3.8-Max");
let nextId = 1;
const unmatched = [];
function ensureModel(models, name) {
  const key = name.toLowerCase();
  if (byName.has(key)) return byName.get(key);
  const m = { _id: `aa-new-${nextId++}`, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), provider: provider(name), familyTag: family(name), tags: [], hidden: false };
  models.push(m); byName.set(key, m); unmatched.push(name); return m;
}
function addBench(snap, name, rows, dims) {
  const scores = rows.map(([n, e]) => ({ modelId: ensureModel(snap.models, n)._id, benchId: `aa-bench-${name}`, normalizedScore: elo(e), upvotes: 1, downvotes: 0 }));
  const perModel = new Map(); for (const s of scores) perModel.set(s.modelId, Math.max(perModel.get(s.modelId) ?? -1, s.normalizedScore));
  const vals = [...perModel.values()].sort((a, b) => b - a); const top = vals.slice(0, 10); const fm = top.reduce((a, c) => a + c, 0) / top.length;
  const headroom = Math.max(0.1, (100 - Math.max(fm, 50)) / 50);
  const quality = (dims.relevance + dims.contamination + dims.discriminability + dims.reproducibility) / 4 * 20;
  const diff = (dims.difficulty - 1) / 4;
  snap.benches.push({ _id: `aa-bench-${name}`, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), tags: ["agents"], hidden: false, cachedQualityScore: quality, cachedDimensions: dims, cachedRaterCount: 1, cachedDifficultyMultiplier: diff, cachedHeadroom: Number(headroom.toFixed(2)), cachedFrontierMean: Number(fm.toFixed(1)), cachedModelCount: perModel.size, cachedNetUpvotes: 1, cachedEffectiveWeight: Number((quality * diff * headroom).toFixed(1)) });
  snap.scores.push(...scores);
}
const clone = () => JSON.parse(JSON.stringify(base));
const arc3 = base.benches.find((b) => b.name === "ARC-AGI-3")._id;
const verifiedArc3 = new Set(base.models.filter((m) => /^Claude Opus 5 \(High\)$|^Grok 4\.5$/.test(m.name)).map((m) => m._id));
function dropArc3Blog(s) { s.scores = s.scores.filter((sc) => sc.benchId !== arc3 || verifiedArc3.has(sc.modelId)); const b = s.benches.find((x) => x._id === arc3); b.cachedModelCount = 2; b.cachedHeadroom = 1; b.cachedFrontierMean = 15.3; return s; }
function dropArc3(s) { s.scores = s.scores.filter((sc) => sc.benchId !== arc3); s.benches = s.benches.filter((b) => b._id !== arc3); return s; }
// same rating profile as AutomationBench-AA (private held-out set): rel 5, cont 5, disc 5, repro 3, diff 4
const AA_DIMS = { relevance: 5, contamination: 5, discriminability: 5, reproducibility: 3, difficulty: 4 };
function addAA(s) { addBench(s, "GDPval-AA v2", GDPVAL, AA_DIMS); addBench(s, "AA-Briefcase", BRIEFCASE, AA_DIMS); return s; }

const scenarios = {
  S0_current: clone(),
  S1_arc3_verified_only: dropArc3Blog(clone()),
  S2_arc3_dropped: dropArc3(clone()),
  S3_current_plus_AA: addAA(clone()),
  S4_arc3_dropped_plus_AA: addAA(dropArc3(clone())),
  S5_arc3_verified_plus_AA: addAA(dropArc3Blog(clone())),
};
for (const [k, s] of Object.entries(scenarios)) { writeFileSync(resolve(outDir, `${k}.json`), JSON.stringify(s)); console.log(k, "models", s.models.length, "benches", s.benches.length, "scores", s.scores.length); }
console.log("new pseudo-models created for unmatched AA names:", [...new Set(unmatched)].join(", "));
const added = scenarios.S3_current_plus_AA.benches.filter((b) => b._id.startsWith("aa-bench")); for (const b of added) console.log(b.name, "effW", b.cachedEffectiveWeight, "headroom", b.cachedHeadroom, "frontierMean", b.cachedFrontierMean, "N", b.cachedModelCount);
