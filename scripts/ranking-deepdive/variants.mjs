// Compare hardened variants of the unified BT on one snapshot.
//   pairing : all pairs (w/(n-1)) vs nearest-10 neighbours (w/10)
//   family  : best configuration vs ceiling (all results of the family count -> cherry-proof)
//   nShare  : multiply bench weight by sqrt(N_b/N*) (the April "single-model vanity bench" guard)
import { families, famLabel, familyWeight, familyPlayers, modelPlayers, bradleyTerry, mById, models, modelCountMax } from "./lib.mjs";
const target = process.env.TARGET; const TOP = Number(process.env.TOP ?? 6);
const w0 = (b) => familyWeight(b, 3);
const wN = (b) => familyWeight(b, 3) * Math.sqrt(Math.min(1, (b.cachedModelCount ?? 0) / modelCountMax));
const winTop = (rows, n = 10) => { const top = [...rows].sort((a, b) => b.ability - a.ability).slice(0, n); return rows.map((r) => { let s = 0, k = 0; for (const j of top) { if (j.id === r.id) continue; s += 1 / (1 + Math.exp(-(r.ability - j.ability))); k++; } return { ...r, win: 100 * s / k }; }); };
const famOf = new Map(); for (const f of families.values()) for (const m of f.members) famOf.set(m._id, f);
const tm = target ? models.find((m) => m.name === target) : null;
for (const [label, w, K] of [["A all-pairs", w0, 0], ["B neighbours-10", w0, 10], ["C neighbours-10 + N-share", wN, 10]]) {
  const cfg = winTop(bradleyTerry(modelPlayers(), w, { lambda: 0.15, neighborK: K })).sort((a, b) => b.ability - a.ability);
  const fam = winTop(bradleyTerry(familyPlayers(), w, { lambda: 0.15, neighborK: K })).sort((a, b) => b.ability - a.ability);
  const seen = new Set(); const best = []; for (const r of cfg) { const f = famOf.get(r.id); if (!f || seen.has(f.key)) continue; seen.add(f.key); best.push({ ...r, tag: f.tag }); }
  console.log(`--- ${label}`);
  console.log(`  model table      : ${cfg.slice(0, TOP).map((r) => mById.get(r.id).name.replace(/ with fallback|adaptive /g, "") + " " + r.win.toFixed(1)).join(" | ")}`);
  console.log(`  family=best cfg  : ${best.slice(0, TOP).map((r) => r.tag + " " + r.win.toFixed(1)).join(" | ")}`);
  console.log(`  family=ceiling   : ${fam.slice(0, TOP).map((r) => famLabel(r.id) + " " + r.win.toFixed(1)).join(" | ")}`);
  if (tm) { const f = famOf.get(tm._id); console.log(`  target ${target}: model #${cfg.findIndex((r) => r.id === tm._id) + 1}, family(best cfg) #${best.findIndex((r) => r.tag === f.tag) + 1}, family(ceiling) #${fam.findIndex((r) => r.id === f.key) + 1}`); }
}
