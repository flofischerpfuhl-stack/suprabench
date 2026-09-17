// Unified BT on concrete configs; family = its best configuration under the SAME fit (AA-style dedupe).
// Prints model table, family table, and leave-one-bench-out rank ranges for the top rows.
import { benches, families, famLabel, familyWeight, modelPlayers, bradleyTerry, mById, rankMap } from "./lib.mjs";
const TOP = Number(process.env.TOP ?? 10);
const wBayes = (b) => familyWeight(b, 3);
const winTop = (rows, n = 10) => { const top = [...rows].sort((a, b) => b.ability - a.ability).slice(0, n); return rows.map((r) => { let s = 0, k = 0; for (const j of top) { if (j.id === r.id) continue; s += 1 / (1 + Math.exp(-(r.ability - j.ability))); k++; } return { ...r, win: 100 * s / k }; }); };
const famOf = new Map(); for (const f of families.values()) for (const m of f.members) famOf.set(m._id, f.tag);
const fit = winTop(bradleyTerry(modelPlayers(), wBayes, { lambda: 0.15 })).sort((a, b) => b.ability - a.ability);
console.log("### MODEL table (unified BT, win-rate vs top-10)");
fit.slice(0, TOP).forEach((r, i) => console.log(`${i + 1}. ${mById.get(r.id).name} ${r.win.toFixed(1)} (${r.benchCount}b)`));
console.log("### FAMILY table = best configuration of each family");
const seen = new Set(); const famRows = [];
for (const r of fit) { const f = famOf.get(r.id); if (!f || seen.has(f)) continue; seen.add(f); famRows.push({ ...r, fam: f }); }
famRows.slice(0, TOP).forEach((r, i) => console.log(`${i + 1}. ${r.fam} ${r.win.toFixed(1)} via ${mById.get(r.id).name} (${r.benchCount}b, ${families.get([...families.keys()].find((k) => famLabel(k) === r.fam)).benches.size} family benches)`));
console.log("### Leave-one-bench-out rank range (model table, top 8)");
const full = rankMap(fit, "ability"); const top = fit.slice(0, 8).map((r) => r.id); const rng = new Map(top.map((k) => [k, []]));
for (const hb of benches) { const rk = rankMap(bradleyTerry(modelPlayers((b) => b._id !== hb._id), wBayes, { lambda: 0.15, benchFilter: (b) => b._id !== hb._id }), "ability"); for (const k of top) if (rk.has(k)) rng.get(k).push([rk.get(k), hb.name]); }
for (const k of top) { const r = rng.get(k); const worst = r.reduce((a, c) => (c[0] > a[0] ? c : a)); console.log(`${mById.get(k).name}: #${full.get(k)} | range ${Math.min(...r.map((x) => x[0]))}-${worst[0]} (worst when dropping ${worst[1]})`); }
