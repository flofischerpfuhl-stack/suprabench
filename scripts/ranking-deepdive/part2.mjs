import {
  benches, bById, bName, families, famLabel, famKeyByTag, familyWeight, neutralWeight,
  familyPlayers, modelPlayers, bradleyTerry, additiveModel, pairAgreement, rankMap, mById, famTag, prodModelRanking,
} from "./lib.mjs";

const TARGET = ["Claude Fable 5.1", "GPT-6 Astra", "GPT-5.6 Sol"]; // user's stated order (top 3); rest are "then Chinese/Grok/Muse"
const TIER2 = ["DeepSeek V4.1 Flash", "Kimi K3", "GLM-5.3", "Grok 4.6", "Muse Spark 1.3"];

// ---- method definitions on family ceilings ----
const wBayes = (b) => familyWeight(b, 3);
const wBayesNoUpvote = (b) => familyWeight(b, 3) / Math.min(1, Math.max(0, b.cachedNetUpvotes ?? 1) / 2); // remove upvote factor (U*=2)
const METHODS = {
  "prod-BT(λ=.15,binary)": (pl, bf) => bradleyTerry(pl, wBayes, { lambda: 0.15, benchFilter: bf }).map((r) => ({ id: r.id, score: r.ability })),
  "BT(λ=.02,binary)": (pl, bf) => bradleyTerry(pl, wBayes, { lambda: 0.02, benchFilter: bf }).map((r) => ({ id: r.id, score: r.ability })),
  "BT(λ=.15,margin)": (pl, bf) => bradleyTerry(pl, wBayes, { lambda: 0.15, outcome: "margin", benchFilter: bf }).map((r) => ({ id: r.id, score: r.ability })),
  "BT(λ=.02,margin)": (pl, bf) => bradleyTerry(pl, wBayes, { lambda: 0.02, outcome: "margin", benchFilter: bf }).map((r) => ({ id: r.id, score: r.ability })),
  "BT(λ=.15,binary,no-upvote)": (pl, bf) => bradleyTerry(pl, wBayesNoUpvote, { lambda: 0.15, benchFilter: bf }).map((r) => ({ id: r.id, score: r.ability })),
  "additive-logit(bayesW)": (pl, bf) => additiveModel(pl, wBayes, { transform: "logit", benchFilter: bf }).rows.map((r) => ({ id: r.id, score: r.theta, se: r.se })),
  "additive-logit(neutralW)": (pl, bf) => additiveModel(pl, neutralWeight, { transform: "logit", benchFilter: bf }).rows.map((r) => ({ id: r.id, score: r.theta, se: r.se })),
  "additive-z(bayesW)": (pl, bf) => additiveModel(pl, wBayes, { transform: "z", benchFilter: bf }).rows.map((r) => ({ id: r.id, score: r.theta, se: r.se })),
  "additive-raw(bayesW)": (pl, bf) => additiveModel(pl, wBayes, { transform: "raw", benchFilter: bf }).rows.map((r) => ({ id: r.id, score: r.theta, se: r.se })),
  "IRT-slope-logit(bayesW)": (pl, bf) => additiveModel(pl, wBayes, { transform: "logit", slope: true, benchFilter: bf }).rows.map((r) => ({ id: r.id, score: r.theta, se: r.se })),
};

// ---- evaluation helpers ----
function h2hMajorityPairs(minCommon = 2) {
  const keys = [...families.keys()].filter((k) => families.get(k).benches.size > 0);
  const pairs = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const fa = families.get(keys[i]), fb = families.get(keys[j]);
    let w = 0, l = 0, n = 0;
    for (const [bid, va] of fa.benches) { const vb = fb.benches.get(bid); if (!vb) continue; n++; if (va.score > vb.score) w++; else if (va.score < vb.score) l++; }
    if (n >= minCommon && w !== l) pairs.push({ a: keys[i], b: keys[j], winner: w > l ? keys[i] : keys[j], n, margin: Math.abs(w - l) / n });
  }
  return pairs;
}
const H2H = h2hMajorityPairs(2);
const H2H3 = h2hMajorityPairs(3);
function h2hConsistency(rank, pairs) { let ok = 0; for (const p of pairs) { const ra = rank.get(p.a), rb = rank.get(p.b); if (ra == null || rb == null) continue; const pred = ra < rb ? p.a : p.b; if (pred === p.winner) ok++; } return ok / pairs.length; }
function targetAgreement(rank) { const ids = TARGET.map(famKeyByTag); let ok = 0, tot = 0; for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { tot++; if (rank.get(ids[i]) < rank.get(ids[j])) ok++; } // tier2 below all of top3
  for (const t of TIER2) { const k = famKeyByTag(t); for (const i of ids) { tot++; if (rank.get(i) < rank.get(k)) ok++; } } return ok / tot; }
function heldOutBenchAccuracy(methodFn) {
  // leave one bench out; fit on rest; predict pairwise order among held-out participants; accuracy weighted by bench weight
  let num = 0, den = 0; const perBench = [];
  for (const hb of benches) {
    const parts = [...families.values()].filter((f) => f.benches.has(hb._id));
    if (parts.length < 2) continue;
    const pl = familyPlayers((b) => b._id !== hb._id);
    const rows = methodFn(pl, (b) => b._id !== hb._id);
    const score = new Map(rows.map((r) => [r.id, r.score]));
    let ok = 0, tot = 0;
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i], b = parts[j]; const sa = a.benches.get(hb._id).score, sb = b.benches.get(hb._id).score; if (sa === sb) continue;
      const pa = score.get(a.key), pb = score.get(b.key); if (pa == null || pb == null) continue; tot++;
      if ((sa > sb) === (pa > pb)) ok++; else if (pa === pb) ok += 0.5;
    }
    if (tot === 0) continue; const acc = ok / tot; const w = wBayes(hb); num += acc * w; den += w; perBench.push({ b: hb.name, acc, tot });
  }
  return { acc: num / den, perBench };
}
function loboStability(methodFn, topN = 20) {
  const full = rankMap(methodFn(familyPlayers(), null)); const top = [...full.entries()].filter(([, r]) => r <= topN).map(([k]) => k);
  let agg = 0, n = 0; const moves = new Map();
  for (const hb of benches) { const rows = methodFn(familyPlayers((b) => b._id !== hb._id), (b) => b._id !== hb._id); const rk = rankMap(rows);
    const sub = new Map(top.filter((k) => rk.has(k)).map((k) => [k, rk.get(k)])); const subFull = new Map(top.map((k) => [k, full.get(k)]));
    agg += pairAgreement(subFull, sub); n++; for (const k of top) if (rk.has(k)) moves.set(k, (moves.get(k) ?? 0) + Math.abs(rk.get(k) - full.get(k))); }
  return { stability: agg / n, meanMove: [...moves.values()].reduce((a, c) => a + c, 0) / (moves.size * n) };
}

console.log("=== FAMILY-LEVEL METHOD COMPARISON ===");
console.log("method | h2h-consistency(≥2 common) | h2h(≥3 common) | held-out bench acc (weighted) | LOBO top-20 stability | target-order agreement | Fable5.1 | Astra | Sol | Opus5 | Mythos");
const results = {};
for (const [name, fn] of Object.entries(METHODS)) {
  const rows = fn(familyPlayers(), null); const rk = rankMap(rows);
  const ho = heldOutBenchAccuracy(fn); const lobo = loboStability(fn);
  results[name] = { rows, rk, ho, lobo };
  const r = (t) => rk.get(famKeyByTag(t));
  console.log(`${name} | ${(h2hConsistency(rk, H2H) * 100).toFixed(1)}% | ${(h2hConsistency(rk, H2H3) * 100).toFixed(1)}% | ${(ho.acc * 100).toFixed(2)}% | ${(lobo.stability * 100).toFixed(1)}% (move ${lobo.meanMove.toFixed(2)}) | ${(targetAgreement(rk) * 100).toFixed(0)}% | #${r("Claude Fable 5.1")} | #${r("GPT-6 Astra")} | #${r("GPT-5.6 Sol")} | #${r("Claude Opus 5")} | #${r("Claude Mythos 5")}`);
}
console.log(`(h2h pairs: ${H2H.length} with ≥2 common benches, ${H2H3.length} with ≥3)`);

for (const name of ["prod-BT(λ=.15,binary)", "BT(λ=.02,binary)", "BT(λ=.02,margin)", "additive-logit(bayesW)", "additive-logit(neutralW)", "IRT-slope-logit(bayesW)"]) {
  console.log(`\n--- Top 16: ${name} ---`);
  const rows = [...results[name].rows].sort((a, b) => b.score - a.score);
  rows.slice(0, 16).forEach((r, i) => console.log(`${i + 1} | ${famLabel(r.id)} | ${r.score.toFixed(2)}${r.se != null ? ` ± ${r.se.toFixed(2)}` : ""} | ${families.get(r.id).benches.size} benches`));
}

// which pairs does each method get "wrong" vs h2h among top families
console.log("\n=== h2h violations among top-12 families per method (pairs with ≥2 common benches) ===");
for (const name of ["prod-BT(λ=.15,binary)", "additive-logit(bayesW)", "BT(λ=.02,margin)"]) {
  const rk = results[name].rk; const top12 = new Set([...rk.entries()].filter(([, r]) => r <= 12).map(([k]) => k));
  const bad = H2H.filter((p) => top12.has(p.a) && top12.has(p.b)).filter((p) => (rk.get(p.a) < rk.get(p.b) ? p.a : p.b) !== p.winner);
  console.log(`${name}: ${bad.length} violations :: ` + bad.map((p) => `${famLabel(p.winner)} beats ${famLabel(p.winner === p.a ? p.b : p.a)} h2h (${p.n} common) but ranks lower`).join("; "));
}

// bench offsets from additive logit — shows scale calibration
console.log("\n=== Additive-logit bench offsets β (difficulty on logit scale) and per-bench held-out accuracy ===");
const am = additiveModel(familyPlayers(), wBayes, { transform: "logit" });
const ho = results["additive-logit(bayesW)"].ho;
[...am.beta.entries()].sort((a, b) => a[1] - b[1]).forEach(([b, v]) => { const pb = ho.perBench.find((x) => x.b === bName(b)); console.log(`${bName(b)} | β=${v.toFixed(2)} | held-out acc ${pb ? (pb.acc * 100).toFixed(0) + "% over " + pb.tot + " pairs" : "n/a"}`); });
console.log("residual sigma (logit):", am.sigma.toFixed(3));

// bootstrap over benches for additive-logit: rank distribution of top families
console.log("\n=== Bench-bootstrap (300 resamples) rank ranges, additive-logit(bayesW) ===");
function mulberry(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry(42);
const watch = ["Claude Fable 5.1", "GPT-6 Astra", "GPT-5.6 Sol", "Claude Opus 5", "Claude Fable 5", "Claude Mythos 5", "DeepSeek V4.1 Flash", "Muse Spark 1.3", "Kimi K3", "Grok 4.6", "GLM-5.3", "Gemini 3.8 Flash"];
const dist = new Map(watch.map((t) => [t, []]));
const B = 300;
for (let s = 0; s < B; s++) {
  const counts = new Map(); for (let i = 0; i < benches.length; i++) { const b = benches[Math.floor(rnd() * benches.length)]; counts.set(b._id, (counts.get(b._id) ?? 0) + 1); }
  const wf = (b) => wBayes(b) * (counts.get(b._id) ?? 0);
  const pl = familyPlayers((b) => counts.has(b._id));
  const rows = additiveModel(pl, wf, { transform: "logit", benchFilter: (b) => counts.has(b._id) }).rows.map((r) => ({ id: r.id, score: r.theta }));
  const rk = rankMap(rows);
  for (const t of watch) { const k = famKeyByTag(t); if (rk.has(k)) dist.get(t).push(rk.get(k)); }
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
for (const t of watch) { const d = dist.get(t); console.log(`${t}: median rank ${q(d, 0.5)} | 5-95% ${q(d, 0.05)}-${q(d, 0.95)} | P(rank1)=${(d.filter((x) => x === 1).length / d.length * 100).toFixed(0)}% | P(top3)=${(d.filter((x) => x <= 3).length / d.length * 100).toFixed(0)}% (n=${d.length})`); }

// ---- CONCRETE MODEL level: additive logit vs production ----
console.log("\n=== CONCRETE-MODEL ranking: additive-logit(bayesW) top 25 vs production ===");
const pm = prodModelRanking(); const prodRank = new Map(pm.map((r, i) => [r.id, i + 1]));
const amm = additiveModel(modelPlayers(), wBayes, { transform: "logit" });
const mrows = [...amm.rows].sort((a, b) => b.theta - a.theta);
mrows.slice(0, 25).forEach((r, i) => console.log(`${i + 1} | ${mById.get(r.id).name} | θ=${r.theta.toFixed(2)} ± ${r.se.toFixed(2)} | evidence ${r.evidence.toFixed(1)} | ${r.benchCount} benches | prod #${prodRank.get(r.id)}`));
