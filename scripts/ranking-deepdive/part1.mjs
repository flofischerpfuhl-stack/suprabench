import {
  benches, bById, bName, families, famLabel, famKeyByTag, familyWeight, prodModelRanking,
  familyPlayers, bradleyTerry, prodModelWeight, prodEvidenceWeight, modelCountMax, upvoteMax,
} from "./lib.mjs";

console.log("=== A. Reproduce production MODEL ranking (top 20) ===");
const pm = prodModelRanking();
console.log("rank | model | supra | abilityMean | confidence | E | benches");
pm.slice(0, 20).forEach((r, i) =>
  console.log(`${i + 1} | ${r.name} | ${r.supra.toFixed(1)} | ${r.mean.toFixed(1)} | ${r.confidence.toFixed(2)} | ${r.E.toFixed(0)} | ${r.benchCount}`));
const maxE = Math.max(...pm.map((r) => r.E));
console.log("E* =", maxE.toFixed(1), "held by", pm.find((r) => r.E === maxE).name, "| U* =", upvoteMax, "| N* =", modelCountMax);
console.log("\nSame models ranked by ABILITY MEAN only (no shrinkage), top 20:");
[...pm].sort((a, b) => b.mean - a.mean).slice(0, 20).forEach((r, i) =>
  console.log(`${i + 1} | ${r.name} | mean ${r.mean.toFixed(1)} | benches ${r.benchCount} | prodRank ${pm.indexOf(r) + 1}`));

console.log("\n=== B. Reproduce production FAMILY ranking (top 20) ===");
const fp = familyPlayers();
const bt = bradleyTerry(fp, (b) => familyWeight(b, 3), { lambda: 0.15, iters: 400 });
bt.sort((a, b) => b.score - a.score);
bt.slice(0, 20).forEach((r, i) =>
  console.log(`${i + 1} | ${famLabel(r.id)} | ${r.score.toFixed(1)} | ability ${r.ability.toFixed(2)} | benches ${r.benchCount}`));

console.log("\n=== C. Family-path bench weights (bayesian prior 3) vs model-path weights ===");
const fw = benches.map((b) => ({ n: b.name, fam: familyWeight(b, 3), mod: prodModelWeight(b), ev: prodEvidenceWeight(b), N: b.cachedModelCount, H: b.cachedHeadroom }));
const meanFam = fw.reduce((a, c) => a + c.fam, 0) / fw.filter((x) => x.fam > 0).length;
fw.sort((a, b) => b.fam - a.fam).forEach((x) =>
  console.log(`${x.n} | famW ${x.fam.toFixed(1)} (${(x.fam / meanFam).toFixed(2)}x mean) | modelW ${x.mod.toFixed(1)} | evidenceW ${x.ev.toFixed(1)} | N=${x.N} | H=${x.H}`));

console.log("\n=== D. Head-to-head among frontier families (family ceilings; wins-losses-ties, common benches) ===");
const focus = ["Claude Fable 5.1", "Claude Mythos 5", "Claude Opus 5", "Claude Fable 5", "GPT-6 Astra", "GPT-5.6 Sol", "GPT-5.6 Terra", "DeepSeek V4.1 Flash", "Muse Spark 1.3", "Grok 4.6", "Kimi K3", "GLM-5.3", "Gemini 3.8 Flash", "Gemini 3.5 Flash", "Claude Opus 4.8", "GPT-5.5", "Gemini 3.1"];
const fk = focus.map((t) => [t, famKeyByTag(t)]).filter(([, k]) => k);
const h2h = (a, b) => {
  const fa = families.get(a), fb = families.get(b);
  let w = 0, l = 0, t = 0; const detail = [];
  for (const [bid, va] of fa.benches) { const vb = fb.benches.get(bid); if (!vb) continue; if (va.score > vb.score) w++; else if (va.score < vb.score) l++; else t++; detail.push(`${bName(bid)} ${va.score.toFixed(1)}:${vb.score.toFixed(1)}`); }
  return { w, l, t, detail };
};
console.log("row beats column: W-L-T");
const short = (t) => t.replace("Claude ", "C.").replace("GPT-", "G").replace("Gemini ", "Gem").replace("DeepSeek ", "DS").replace("Muse Spark ", "Muse");
console.log("".padEnd(16) + fk.map(([t]) => short(t).padStart(10)).join(""));
for (const [ta, ka] of fk) {
  let line = short(ta).padEnd(16);
  for (const [tb, kb] of fk) { if (ka === kb) { line += "—".padStart(10); continue; } const r = h2h(ka, kb); line += (r.w + r.l + r.t === 0 ? "·" : `${r.w}-${r.l}-${r.t}`).padStart(10); }
  console.log(line);
}
console.log("\nDetail for key pairs:");
for (const [a, b] of [["Claude Fable 5.1", "GPT-6 Astra"], ["Claude Fable 5.1", "Claude Opus 5"], ["Claude Fable 5.1", "GPT-5.6 Sol"], ["GPT-6 Astra", "Claude Opus 5"], ["GPT-6 Astra", "GPT-5.6 Sol"], ["Claude Opus 5", "GPT-5.6 Sol"], ["Claude Fable 5.1", "Claude Fable 5"], ["Claude Fable 5", "GPT-6 Astra"], ["GPT-6 Astra", "DeepSeek V4.1 Flash"], ["GPT-6 Astra", "Muse Spark 1.3"], ["GPT-6 Astra", "Grok 4.6"]]) {
  const r = h2h(famKeyByTag(a), famKeyByTag(b));
  console.log(`${a} vs ${b}: ${r.w}-${r.l}-${r.t} :: ${r.detail.join("; ")}`);
}

console.log("\n=== E. Per-family comparison mass in the BT fit (sum of normalized bench weights) ===");
for (const [t, k] of fk) { const f = families.get(k); let mass = 0; const parts = []; for (const [bid] of f.benches) { const b = bById.get(bid); const bw = familyWeight(b, 3) / meanFam; const n = [...families.values()].filter((g) => g.benches.has(bid)).length; if (n >= 2) { mass += bw; parts.push(`${bName(bid)}:${bw.toFixed(2)}`); } } console.log(`${t}: mass ${mass.toFixed(2)} over ${f.benches.size} benches :: ${parts.join(", ")}`); }
