// S6 = S4 (ARC-AGI-3 dropped + GDPval-AA v2 + AA-Briefcase) + the four remaining AA v4.3 benches
// with ONLY the rows AA prints in page text (top 3 each). Partial by construction; flagged as such.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const s = JSON.parse(readFileSync(resolve(repoRoot, ".ranking-lab", "scenarios", "S4_arc3_dropped_plus_AA.json"), "utf8"));
const byName = new Map(s.models.map((m) => [m.name, m]));
const F51x = "Claude Fable 5.1 (xhigh with fallback)", F51m = "Claude Fable 5.1 (max with fallback)", F5 = "Claude Fable 5 (adaptive max/fallback)";
const Ax = "GPT-6 Astra (xhigh)", Am = "GPT-6 Astra (max)", Ah = "GPT-6 Astra (high)", Sm = "GPT-5.6 Sol (max)";
const NEW = [
  ["Terminal-Bench 4.0", { relevance: 5, contamination: 4, discriminability: 5, reproducibility: 4, difficulty: 5 }, [[Ax, 59.6], [Am, 59.1], [F51x, 55.1]]],
  ["CritPt", { relevance: 4, contamination: 5, discriminability: 5, reproducibility: 3, difficulty: 5 }, [[Sm, 32.3], [Am, 31.7], [Ax, 31.4]]],
  ["GDP.pdf", { relevance: 5, contamination: 4, discriminability: 5, reproducibility: 4, difficulty: 5 }, [[Ax, 32.2], [Am, 31.0], [Ah, 31.0]]],
  ["AA-Omniscience", { relevance: 4, contamination: 5, discriminability: 4, reproducibility: 3, difficulty: 4 }, [[Ah, 72], [F51m, 71.5], [Ax, 71.5]]],
];
for (const [name, dims, rows] of NEW) {
  const id = `aa-bench-${name}`; const Q = (dims.relevance + dims.contamination + dims.discriminability + dims.reproducibility) / 4 * 20; const D = (dims.difficulty - 1) / 4;
  const fm = rows.reduce((a, c) => a + c[1], 0) / rows.length; const H = Math.max(0.1, (100 - Math.max(fm, 50)) / 50);
  s.benches.push({ _id: id, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), tags: [], hidden: false, cachedQualityScore: Q, cachedDimensions: dims, cachedRaterCount: 1, cachedDifficultyMultiplier: D, cachedHeadroom: H, cachedFrontierMean: fm, cachedModelCount: rows.length, cachedNetUpvotes: 1, cachedEffectiveWeight: Q * D * H });
  for (const [n, v] of rows) s.scores.push({ modelId: byName.get(n)._id, benchId: id, normalizedScore: v, upvotes: 1, downvotes: 0 });
}
writeFileSync(resolve(repoRoot, ".ranking-lab", "scenarios", "S6_arc3_dropped_plus_all_AA_partial.json"), JSON.stringify(s));
console.log("S6 benches", s.benches.length, "scores", s.scores.length);
