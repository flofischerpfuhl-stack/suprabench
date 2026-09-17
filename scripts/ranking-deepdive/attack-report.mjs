// For one snapshot + target model: where does the target land under OLD (production) and NEW (unified BT) math?
import { families, famLabel, familyWeight, familyPlayers, modelPlayers, bradleyTerry, mById, models, prodModelRanking, benches } from "./lib.mjs";
const target = process.env.TARGET;
const wBayes = (b) => familyWeight(b, 3);
const winTop = (rows, n = 10) => { const top = [...rows].sort((a, b) => b.ability - a.ability).slice(0, n); return rows.map((r) => { let s = 0, k = 0; for (const j of top) { if (j.id === r.id) continue; s += 1 / (1 + Math.exp(-(r.ability - j.ability))); k++; } return { ...r, win: 100 * s / k }; }); };
const tm = models.find((m) => m.name === target); const famOf = new Map(); for (const f of families.values()) for (const m of f.members) famOf.set(m._id, f);
const tFam = famOf.get(tm._id);
// OLD
const pm = prodModelRanking(); const oi = pm.findIndex((r) => r.id === tm._id);
const ofam = bradleyTerry(familyPlayers(), wBayes, { lambda: 0.15 }).sort((a, b) => b.ability - a.ability); const ofi = ofam.findIndex((r) => r.id === tFam.key);
// NEW
const fit = winTop(bradleyTerry(modelPlayers(), wBayes, { lambda: 0.15 })).sort((a, b) => b.ability - a.ability); const ni = fit.findIndex((r) => r.id === tm._id);
const seen = new Set(); const nf = []; for (const r of fit) { const f = famOf.get(r.id); if (!f || seen.has(f.key)) continue; seen.add(f.key); nf.push({ ...r, fam: f }); }
const nfi = nf.findIndex((r) => r.fam.key === tFam.key);
const n = (i, arr, fmt) => (i < 0 ? "—" : `#${i + 1} (${fmt(arr[i])})`);
console.log(`target: ${target}`);
console.log(`  OLD model table : ${n(oi, pm, (r) => r.supra.toFixed(1))}   OLD family table: ${n(ofi, ofam, (r) => r.score.toFixed(1))}`);
console.log(`  NEW model table : ${n(ni, fit, (r) => r.win.toFixed(1))}   NEW family table: ${n(nfi, nf, (r) => r.win.toFixed(1) + " via " + mById.get(r.id).name)}`);
console.log(`  OLD model top5  : ${pm.slice(0, 5).map((r) => r.name.replace(/ with fallback|adaptive /g, "") + " " + r.supra.toFixed(1)).join(" | ")}`);
console.log(`  NEW model top5  : ${fit.slice(0, 5).map((r) => mById.get(r.id).name.replace(/ with fallback|adaptive /g, "") + " " + r.win.toFixed(1)).join(" | ")}`);
console.log(`  NEW family top6 : ${nf.slice(0, 6).map((r) => r.fam.tag + " " + r.win.toFixed(1)).join(" | ")}`);
if (process.env.SHOW_BENCH) { const b = benches.find((x) => x.name === process.env.SHOW_BENCH); console.log(`  bench ${b.name}: N=${b.cachedModelCount} frontier=${b.cachedFrontierMean.toFixed(1)} H=${b.cachedHeadroom.toFixed(2)} familyW=${wBayes(b).toFixed(1)}`); }
