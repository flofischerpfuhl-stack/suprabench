import {
  benches, families, famLabel, famKeyByTag, familyWeight, familyPlayers, modelPlayers, bradleyTerry, mById, prodModelRanking, rankMap, upvoteMax,
} from "./lib.mjs";

const wBayes = (b) => familyWeight(b, 3);
// Upvote-trust alternative: (u+1)/(U*+1) instead of u/U*  (U*=2 today, so one vote is a 2x lever)
const wBayesSoftUpvote = (b) => { const u = Math.max(0, b.cachedNetUpvotes ?? 1); const cur = Math.min(1, u / upvoteMax); const soft = (u + 1) / (upvoteMax + 1); return familyWeight(b, 3) / cur * soft; };

function fieldWinRate(rows, topN = 10) {
  // SupraScore display candidate: mean P(beat j) over the current top-N by ability (excluding self)
  const sorted = [...rows].sort((a, b) => b.ability - a.ability);
  const top = sorted.slice(0, topN);
  return rows.map((r) => { let s = 0, n = 0; for (const j of top) { if (j.id === r.id) continue; s += 1 / (1 + Math.exp(-(r.ability - j.ability))); n++; } return { ...r, winTop: (100 * s) / n }; });
}
function fisherSE(players, rows, weightFn) {
  // approximate SE from diagonal Fisher information of the BT likelihood at the fit (plus regularization)
  const ab = new Map(rows.map((r) => [r.id, r.ability]));
  const w = new Map(benches.map((b) => [b._id, weightFn(b)])); const pos = [...w.values()].filter((x) => x > 0); const meanW = pos.reduce((a, c) => a + c, 0) / pos.length;
  const info = new Map(rows.map((r) => [r.id, 0.15]));
  for (const b of benches) { const parts = players.filter((p) => p.scores.has(b._id)); if (parts.length < 2) continue; const pw = (w.get(b._id) ?? 0) / meanW / (parts.length - 1); if (pw <= 0) continue;
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) { const d = ab.get(parts[i].id) - ab.get(parts[j].id); const p = 1 / (1 + Math.exp(-d)); const c = pw * p * (1 - p); info.set(parts[i].id, info.get(parts[i].id) + c); info.set(parts[j].id, info.get(parts[j].id) + c); } }
  return new Map(rows.map((r) => [r.id, 1 / Math.sqrt(info.get(r.id))]));
}

console.log("=== FAMILY: prod-BT with display alternatives (logistic vs win-rate vs top-10) + Fisher SE ===");
const fp = familyPlayers();
const fbt = fieldWinRate(bradleyTerry(fp, wBayes, { lambda: 0.15 }));
const fse = fisherSE(fp, fbt, wBayes);
[...fbt].sort((a, b) => b.ability - a.ability).slice(0, 18).forEach((r, i) => console.log(`${i + 1} | ${famLabel(r.id)} | ability ${r.ability.toFixed(2)} ± ${fse.get(r.id).toFixed(2)} | logistic ${r.score.toFixed(1)} | winrate-vs-top10 ${r.winTop.toFixed(1)} | ${r.benchCount} benches${r.benchCount < 3 ? " (provisional)" : ""}`));

console.log("\n=== FAMILY: prod-BT with soft upvote trust (u+1)/(U*+1) ===");
const fbt2 = fieldWinRate(bradleyTerry(fp, wBayesSoftUpvote, { lambda: 0.15 }));
[...fbt2].sort((a, b) => b.ability - a.ability).slice(0, 12).forEach((r, i) => console.log(`${i + 1} | ${famLabel(r.id)} | ability ${r.ability.toFixed(2)} | winrate-vs-top10 ${r.winTop.toFixed(1)} | ${r.benchCount} benches`));

console.log("\n=== CONCRETE MODELS: unified BT (binary, λ=.15, bayesian weights) — same math as family view ===");
const pm = prodModelRanking(); const prodRank = new Map(pm.map((r, i) => [r.id, i + 1]));
const mp = modelPlayers();
const mbt = fieldWinRate(bradleyTerry(mp, wBayes, { lambda: 0.15 }));
const mse = fisherSE(mp, mbt, wBayes);
[...mbt].sort((a, b) => b.ability - a.ability).slice(0, 30).forEach((r, i) => console.log(`${i + 1} | ${mById.get(r.id).name} | ability ${r.ability.toFixed(2)} ± ${mse.get(r.id).toFixed(2)} | logistic ${r.score.toFixed(1)} | winrate-vs-top10 ${r.winTop.toFixed(1)} | ${r.benchCount} benches | prod #${prodRank.get(r.id)}`));

console.log("\n=== Consistency check: family rank vs best-member rank under unified BT ===");
const mrank = rankMap(mbt, "ability"); const frank = rankMap(fbt, "ability");
for (const t of ["Claude Fable 5.1", "GPT-6 Astra", "Claude Opus 5", "GPT-5.6 Sol", "Claude Fable 5", "Claude Mythos 5", "DeepSeek V4.1 Flash", "Muse Spark 1.3", "Grok 4.6", "Kimi K3", "GLM-5.3", "Gemini 3.8 Flash"]) {
  const f = families.get(famKeyByTag(t)); const best = f.members.map((m) => [m.name, mrank.get(m._id)]).filter(([, r]) => r).sort((a, b) => a[1] - b[1])[0];
  console.log(`${t}: family #${frank.get(f.key)} | best member ${best?.[0]} #${best?.[1]}`);
}

console.log("\n=== Concrete-model BT: LOBO rank range for top configs ===");
const full = rankMap(mbt, "ability"); const top = [...full.entries()].filter(([, r]) => r <= 12).map(([k]) => k);
const ranges = new Map(top.map((k) => [k, []]));
for (const hb of benches) { const rows = bradleyTerry(modelPlayers((b) => b._id !== hb._id), wBayes, { lambda: 0.15, benchFilter: (b) => b._id !== hb._id }); const rk = rankMap(rows, "ability"); for (const k of top) if (rk.has(k)) ranges.get(k).push(rk.get(k)); }
for (const k of top) { const r = ranges.get(k); console.log(`${mById.get(k).name}: full #${full.get(k)} | LOBO range ${Math.min(...r)}-${Math.max(...r)}`); }
