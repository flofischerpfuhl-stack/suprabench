// Cherry-pick guard for "family = best configuration": a configuration may only represent its family
// if it covers at least MIN_SHARE of the family's total bench weight. Also sweeps the BT regularization.
import { families, familyWeight, modelPlayers, bradleyTerry, mById, models, bById, cell } from "./lib.mjs";
const target = process.env.TARGET; const w0 = (b) => familyWeight(b, 3);
const winTop = (rows, n = 10) => { const top = [...rows].sort((a, b) => b.ability - a.ability).slice(0, n); return rows.map((r) => { let s = 0, k = 0; for (const j of top) { if (j.id === r.id) continue; s += 1 / (1 + Math.exp(-(r.ability - j.ability))); k++; } return { ...r, win: 100 * s / k }; }); };
const famOf = new Map(); for (const f of families.values()) for (const m of f.members) famOf.set(m._id, f);
const mass = (ids) => [...ids].reduce((a, id) => a + w0(bById.get(id)), 0);
const share = (mid) => { const f = famOf.get(mid); return mass(cell.get(mid).keys()) / mass(f.benches.keys()); };
for (const lambda of [0.15, 0.3, 0.6]) for (const minShare of [0, 0.5]) {
  const fit = winTop(bradleyTerry(modelPlayers(), w0, { lambda })).sort((a, b) => b.ability - a.ability);
  const seen = new Set(); const fam = []; for (const r of fit) { const f = famOf.get(r.id); if (!f || seen.has(f.key)) continue; if (share(r.id) < minShare) continue; seen.add(f.key); fam.push({ ...r, tag: f.tag }); }
  const tm = target ? models.find((m) => m.name === target) : null; const tf = tm ? famOf.get(tm._id).tag : null;
  console.log(`λ=${lambda} minShare=${minShare} | model: ${fit.slice(0, 5).map((r) => mById.get(r.id).name.replace(/ with fallback|adaptive /g, "") + " " + r.win.toFixed(1)).join(" | ")}`);
  console.log(`   family: ${fam.slice(0, 7).map((r) => r.tag + " " + r.win.toFixed(1)).join(" | ")}${tm ? `  || target model #${fit.findIndex((r) => r.id === tm._id) + 1} (covers ${(share(tm._id) * 100).toFixed(0)}% of family weight), family ${tf} #${fam.findIndex((r) => r.tag === tf) + 1}` : ""}`);
}
