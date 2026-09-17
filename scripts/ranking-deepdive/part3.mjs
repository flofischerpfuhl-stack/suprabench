import {
  benches, bById, bName, families, famLabel, famKeyByTag, familyWeight, prodModelWeight, prodEvidenceWeight,
  familyPlayers, modelPlayers, bradleyTerry, additiveModel, pairAgreement, rankMap, mById, prodModelRanking, med, cell, models,
} from "./lib.mjs";

// Frontier-relative scoring: rel(m,b) = score - frontierMean(b) [optionally / frontierSD(b)], weighted mean with ability weights,
// then shrink toward 0 (= "at frontier par") by evidence confidence sqrt(E/E*), display as 50 + k*value.
// frontier stats computed from CONCRETE model medians (top-K=10), same as production headroom.
const K = 10;
const frontier = new Map();
for (const b of benches) {
  const vals = []; for (const m of models) { const v = cell.get(m._id)?.get(b._id); if (v != null) vals.push(v); }
  vals.sort((a, c) => c - a); const top = vals.slice(0, Math.min(K, vals.length));
  const mean = top.reduce((a, c) => a + c, 0) / (top.length || 1);
  const sd = Math.sqrt(top.reduce((a, c) => a + (c - mean) ** 2, 0) / Math.max(1, top.length - 1));
  const all = vals.reduce((a, c) => a + c, 0) / (vals.length || 1);
  frontier.set(b._id, { mean, sd: Math.max(2, sd), n: vals.length, allMean: all, cachedFM: b.cachedFrontierMean });
}
console.log("=== Frontier stats (top-10 mean / sd of concrete-model medians) ===");
for (const b of benches) { const f = frontier.get(b._id); console.log(`${b.name} | frontierMean ${f.mean.toFixed(1)} (cached ${f.cachedFM}) | frontierSD ${f.sd.toFixed(1)} | allMean ${f.allMean.toFixed(1)} | n=${f.n}`); }

function frontierRelative(players, weightFn, { z = false, shrink = true, cap = null, benchFilter = null, evidenceFn = null } = {}) {
  const bs = benchFilter ? benches.filter(benchFilter) : benches;
  const w = new Map(bs.map((b) => [b._id, weightFn(b)]));
  const ew = new Map(bs.map((b) => [b._id, evidenceFn ? evidenceFn(b) : weightFn(b)]));
  const rows = [];
  let maxE = 0;
  for (const p of players) {
    let num = 0, den = 0, E = 0, n = 0;
    for (const [bid, s] of p.scores) { const a = w.get(bid) ?? 0; if (a <= 0) continue; const f = frontier.get(bid); let rel = s - f.mean; if (z) rel = rel / f.sd; if (cap != null) rel = Math.max(-cap, Math.min(cap, rel)); num += a * rel; den += a; E += ew.get(bid) ?? 0; n++; }
    const mean = den > 0 ? num / den : 0; rows.push({ id: p.id, mean, E, n }); if (E > maxE) maxE = E;
  }
  for (const r of rows) { const c = shrink ? Math.sqrt(Math.min(1, r.E / maxE)) : 1; r.conf = c; r.score = c * r.mean; }
  return rows;
}

const wBayes = (b) => familyWeight(b, 3);
const TARGET = ["Claude Fable 5.1", "GPT-6 Astra", "GPT-5.6 Sol"]; const TIER2 = ["DeepSeek V4.1 Flash", "Kimi K3", "GLM-5.3", "Grok 4.6", "Muse Spark 1.3"];
function h2hPairs(minCommon = 2) { const keys = [...families.keys()].filter((k) => families.get(k).benches.size > 0); const pairs = []; for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) { const fa = families.get(keys[i]), fb = families.get(keys[j]); let w = 0, l = 0, n = 0; for (const [bid, va] of fa.benches) { const vb = fb.benches.get(bid); if (!vb) continue; n++; if (va.score > vb.score) w++; else if (va.score < vb.score) l++; } if (n >= minCommon && w !== l) pairs.push({ a: keys[i], b: keys[j], winner: w > l ? keys[i] : keys[j], n }); } return pairs; }
const H2H = h2hPairs(2);
const h2hCons = (rk) => { let ok = 0, t = 0; for (const p of H2H) { if (!rk.has(p.a) || !rk.has(p.b)) continue; t++; if ((rk.get(p.a) < rk.get(p.b) ? p.a : p.b) === p.winner) ok++; } return ok / t; };
const targetAgr = (rk) => { const ids = TARGET.map(famKeyByTag); let ok = 0, tot = 0; for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { tot++; if (rk.get(ids[i]) < rk.get(ids[j])) ok++; } for (const t of TIER2) { const k = famKeyByTag(t); for (const i of ids) { tot++; if (rk.get(i) < rk.get(k)) ok++; } } return ok / tot; };
function heldOut(fn) { let num = 0, den = 0; for (const hb of benches) { const parts = [...families.values()].filter((f) => f.benches.has(hb._id)); if (parts.length < 2) continue; const rows = fn(familyPlayers((b) => b._id !== hb._id), (b) => b._id !== hb._id); const sc = new Map(rows.map((r) => [r.id, r.score])); let ok = 0, tot = 0; for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) { const a = parts[i], b = parts[j]; const sa = a.benches.get(hb._id).score, sb = b.benches.get(hb._id).score; if (sa === sb) continue; const pa = sc.get(a.key), pb = sc.get(b.key); if (pa == null || pb == null) continue; tot++; if ((sa > sb) === (pa > pb)) ok++; else if (pa === pb) ok += 0.5; } if (!tot) continue; num += (ok / tot) * wBayes(hb); den += wBayes(hb); } return num / den; }
function lobo(fn, topN = 20) { const full = rankMap(fn(familyPlayers(), null)); const top = [...full.entries()].filter(([, r]) => r <= topN).map(([k]) => k); let agg = 0, n = 0; for (const hb of benches) { const rk = rankMap(fn(familyPlayers((b) => b._id !== hb._id), (b) => b._id !== hb._id)); agg += pairAgreement(new Map(top.map((k) => [k, full.get(k)])), new Map(top.filter((k) => rk.has(k)).map((k) => [k, rk.get(k)]))); n++; } return agg / n; }

const METHODS = {
  "FR-raw, bayesW, shrink": (pl, bf) => frontierRelative(pl, wBayes, { benchFilter: bf }),
  "FR-raw, bayesW, no-shrink": (pl, bf) => frontierRelative(pl, wBayes, { shrink: false, benchFilter: bf }),
  "FR-z, bayesW, shrink": (pl, bf) => frontierRelative(pl, wBayes, { z: true, benchFilter: bf }),
  "FR-z, bayesW, no-shrink": (pl, bf) => frontierRelative(pl, wBayes, { z: true, shrink: false, benchFilter: bf }),
  "FR-raw cap±15, bayesW, shrink": (pl, bf) => frontierRelative(pl, wBayes, { cap: 15, benchFilter: bf }),
  "FR-z cap±2, bayesW, shrink": (pl, bf) => frontierRelative(pl, wBayes, { z: true, cap: 2, benchFilter: bf }),
  "FR-raw, prodModelW, prodEvidence shrink": (pl, bf) => frontierRelative(pl, prodModelWeight, { evidenceFn: prodEvidenceWeight, benchFilter: bf }),
  "prod-BT baseline": (pl, bf) => bradleyTerry(pl, wBayes, { lambda: 0.15, benchFilter: bf }).map((r) => ({ id: r.id, score: r.ability, n: r.benchCount })),
};
console.log("\n=== FAMILY-LEVEL: frontier-relative variants ===");
console.log("method | h2h-consistency | held-out acc | LOBO top-20 | target agr | Fable5.1 | Astra | Sol | Opus5 | Fable5 | Mythos | DS4.1F");
const res = {};
for (const [name, fn] of Object.entries(METHODS)) { const rows = fn(familyPlayers(), null); const rk = rankMap(rows); res[name] = rows; const r = (t) => rk.get(famKeyByTag(t)); console.log(`${name} | ${(h2hCons(rk) * 100).toFixed(1)}% | ${(heldOut(fn) * 100).toFixed(2)}% | ${(lobo(fn) * 100).toFixed(1)}% | ${(targetAgr(rk) * 100).toFixed(0)}% | #${r("Claude Fable 5.1")} | #${r("GPT-6 Astra")} | #${r("GPT-5.6 Sol")} | #${r("Claude Opus 5")} | #${r("Claude Fable 5")} | #${r("Claude Mythos 5")} | #${r("DeepSeek V4.1 Flash")}`); }
for (const name of ["FR-raw, bayesW, shrink", "FR-z, bayesW, shrink", "FR-z cap±2, bayesW, shrink", "FR-raw, bayesW, no-shrink"]) { console.log(`\n--- Top 16: ${name} ---`); [...res[name]].sort((a, b) => b.score - a.score).slice(0, 16).forEach((r, i) => console.log(`${i + 1} | ${famLabel(r.id)} | ${r.score.toFixed(2)} (mean ${r.mean.toFixed(2)}, conf ${r.conf.toFixed(2)}) | ${r.n} benches`)); }

// Sensitivity: ARC-AGI-3 removed / neutral upvote
console.log("\n=== Sensitivity: drop ARC-AGI-3 (top 8 under prod-BT and FR-z shrink) ===");
const noArc3 = (b) => b.name !== "ARC-AGI-3";
for (const name of ["prod-BT baseline", "FR-z, bayesW, shrink"]) { const rows = METHODS[name](familyPlayers(noArc3), noArc3); console.log(name + ": " + [...rows].sort((a, b) => b.score - a.score).slice(0, 8).map((r, i) => `${i + 1}.${famLabel(r.id)}`).join("  ")); }
console.log("\n=== Sensitivity: drop Tau2 + SkateBench (saturated/low-quality) ===");
const noSat = (b) => !/Tau2|SkateBench/.test(b.name);
for (const name of ["prod-BT baseline", "FR-z, bayesW, shrink"]) { const rows = METHODS[name](familyPlayers(noSat), noSat); console.log(name + ": " + [...rows].sort((a, b) => b.score - a.score).slice(0, 8).map((r, i) => `${i + 1}.${famLabel(r.id)}`).join("  ")); }

// CONCRETE MODEL level with FR-z shrink (same method both views)
console.log("\n=== CONCRETE-MODEL level: FR-z shrink (prod weights) top 25 ===");
const pm = prodModelRanking(); const prodRank = new Map(pm.map((r, i) => [r.id, i + 1]));
const mrows = frontierRelative(modelPlayers(), prodModelWeight, { z: true, evidenceFn: prodEvidenceWeight });
[...mrows].sort((a, b) => b.score - a.score).slice(0, 25).forEach((r, i) => console.log(`${i + 1} | ${mById.get(r.id).name} | ${r.score.toFixed(2)} (mean ${r.mean.toFixed(2)}, conf ${r.conf.toFixed(2)}) | ${r.n} benches | prod #${prodRank.get(r.id)}`));
console.log("\n=== CONCRETE-MODEL level: FR-z NO shrink top 25 (pure ability) ===");
const mrows2 = frontierRelative(modelPlayers(), prodModelWeight, { z: true, shrink: false });
[...mrows2].sort((a, b) => b.score - a.score).slice(0, 25).forEach((r, i) => console.log(`${i + 1} | ${mById.get(r.id).name} | ${r.score.toFixed(2)} | ${r.n} benches | prod #${prodRank.get(r.id)}`));
