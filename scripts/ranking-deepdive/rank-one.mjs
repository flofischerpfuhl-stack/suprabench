// Print the actual leaderboards for one snapshot (env SUPRABENCH_SNAPSHOT) under:
//   F0 production (model: raw weighted mean + evidence shrink; family: ceiling BT λ=.15)
//   F1 unified BT (configs and family ceiling, same fit family; display = win-rate vs top-10)
import { families, famLabel, famKeyByTag, familyWeight, familyPlayers, modelPlayers, bradleyTerry, mById, prodModelRanking, upvoteMax } from "./lib.mjs";
const TOP = Number(process.env.TOP ?? 10);
const WATCH = ["Claude Fable 5.1", "GPT-6 Astra", "GPT-5.6 Sol", "Claude Opus 5", "Claude Fable 5", "Claude Mythos 5", "Muse Spark 1.3", "DeepSeek V4.1 Flash", "Grok 4.6", "Kimi K3", "GLM-5.3"];
const wBayes = (b) => familyWeight(b, 3);
const wSoft = (b) => { const u = Math.max(0, b.cachedNetUpvotes ?? 1); return familyWeight(b, 3) / Math.min(1, u / upvoteMax) * ((u + 1) / (upvoteMax + 1)); };
const winTop = (rows, n = 10) => { const top = [...rows].sort((a, b) => b.ability - a.ability).slice(0, n); return rows.map((r) => { let s = 0, k = 0; for (const j of top) { if (j.id === r.id) continue; s += 1 / (1 + Math.exp(-(r.ability - j.ability))); k++; } return { ...r, win: 100 * s / k }; }); };
const pos = (rows, key, label) => { const i = rows.findIndex((r) => key(r) === label); return i < 0 ? "—" : `#${i + 1}`; };
const line = (rows, key) => WATCH.map((t) => `${t.replace("Claude ", "").replace("GPT-", "")} ${pos(rows, key, t)}`).join(" | ");

console.log("### F0 production — MODEL table");
const pm = prodModelRanking();
pm.slice(0, TOP).forEach((r, i) => console.log(`${i + 1}. ${r.name} ${r.supra.toFixed(1)} (${r.benchCount}b)`));
console.log("watch:", line(pm, (r) => r.family));
console.log("### F0 production — FAMILY table");
const fb = bradleyTerry(familyPlayers(), wBayes, { lambda: 0.15 }).sort((a, b) => b.ability - a.ability);
fb.slice(0, TOP).forEach((r, i) => console.log(`${i + 1}. ${famLabel(r.id)} ${r.score.toFixed(1)} (${r.benchCount}b)`));
console.log("watch:", line(fb, (r) => famLabel(r.id)));

for (const [name, w] of [["F1 unified BT (current upvote factor)", wBayes], ["F2 unified BT (soft upvote (u+1)/(U*+1))", wSoft]]) {
  console.log(`### ${name} — MODEL table (win-rate vs top-10)`);
  const mb = winTop(bradleyTerry(modelPlayers(), w, { lambda: 0.15 })).sort((a, b) => b.ability - a.ability);
  mb.slice(0, TOP).forEach((r, i) => console.log(`${i + 1}. ${mById.get(r.id).name} ${r.win.toFixed(1)} (${r.benchCount}b)`));
  console.log("watch:", line(mb, (r) => { const m = mById.get(r.id); return [...families.values()].find((f) => f.members.includes(m))?.tag; }));
  console.log(`### ${name} — FAMILY table (win-rate vs top-10)`);
  const fbx = winTop(bradleyTerry(familyPlayers(), w, { lambda: 0.15 })).sort((a, b) => b.ability - a.ability);
  fbx.slice(0, TOP).forEach((r, i) => console.log(`${i + 1}. ${famLabel(r.id)} ${r.win.toFixed(1)} (${r.benchCount}b)`));
  console.log("watch:", line(fbx, (r) => famLabel(r.id)));
}
