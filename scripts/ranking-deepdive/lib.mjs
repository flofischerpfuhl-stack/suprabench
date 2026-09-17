import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const snapshotPath = process.env.SUPRABENCH_SNAPSHOT ?? resolve(repoRoot, ".ranking-lab", "snapshot.json");
export const snap = JSON.parse(readFileSync(snapshotPath, "utf8"));
export const benches = snap.benches.filter((b) => !b.hidden);
export const models = snap.models.filter((m) => !m.hidden);
export const mById = new Map(models.map((m) => [m._id, m]));
export const bById = new Map(benches.map((b) => [b._id, b]));
export const bName = (id) => bById.get(id)?.name ?? id;
export const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const GPT56 = /^GPT-5\.6\s+(Sol|Terra|Luna)(?:\s+\([^)]*\))?$/i;
const MUSE = /^Muse Spark\s+(1\.\d+)(?:\s+\([^)]*\))?$/i;
export function famTag(m) {
  const n = m.name.trim();
  const g = n.match(GPT56);
  if (g) return "GPT-5.6 " + g[1][0].toUpperCase() + g[1].slice(1).toLowerCase();
  const u = n.match(MUSE);
  if (u) return "Muse Spark " + u[1];
  return (m.familyTag || "").trim() || null;
}
export const SEP = "||";
// model×bench medians
export const cell = new Map(); // modelId -> Map(benchId -> median)
{
  const tmp = new Map();
  for (const s of snap.scores) {
    if (s.upvotes <= s.downvotes) continue;
    if (!mById.has(s.modelId) || !bById.has(s.benchId)) continue;
    const k = s.modelId + "|" + s.benchId;
    (tmp.get(k) ?? tmp.set(k, []).get(k)).push(s.normalizedScore);
  }
  for (const [k, v] of tmp) {
    const [mid, bid] = k.split("|");
    (cell.get(mid) ?? cell.set(mid, new Map()).get(mid)).set(bid, med(v));
  }
}
// family ceilings
export const families = new Map();
for (const m of models) {
  const t = famTag(m);
  if (!t) continue;
  const key = t + SEP + m.provider;
  const f =
    families.get(key) ??
    families.set(key, { key, tag: t, provider: m.provider, benches: new Map(), members: [] }).get(key);
  f.members.push(m);
  for (const [bid, sc] of cell.get(m._id) ?? []) {
    const cur = f.benches.get(bid);
    if (!cur || sc > cur.score) f.benches.set(bid, { score: sc, model: m.name });
  }
}
export const famLabel = (key) => key.split(SEP)[0];
export const famKeyByTag = (tag) => [...families.keys()].find((k) => famLabel(k) === tag);
// bench weights
export const upvoteMax = Math.max(0, ...benches.map((b) => b.cachedNetUpvotes ?? 1));
export const modelCountMax = Math.max(0, ...benches.map((b) => b.cachedModelCount ?? 0));
export function prodModelWeight(b) {
  const u = Math.min(1, Math.max(0, b.cachedNetUpvotes ?? 1) / upvoteMax);
  return (b.cachedEffectiveWeight ?? 0) * u;
}
export function prodEvidenceWeight(b) {
  const n = Math.min(1, (b.cachedModelCount ?? 0) / modelCountMax);
  return prodModelWeight(b) * Math.sqrt(n);
}
function shrink(v, r, p) {
  const o = r > 0 && typeof v === "number" ? v : 3;
  return (o * r + 3 * p) / (r + p);
}
export function familyWeight(b, prior = 3) {
  const d = b.cachedDimensions ?? {};
  const r = Math.max(0, b.cachedRaterCount ?? 0);
  const q =
    ([d.relevance, d.contamination, d.discriminability, d.reproducibility]
      .map((v) => shrink(v, r, prior))
      .reduce((a, c) => a + c, 0) /
      4) *
    20;
  const diff = Math.min(1, Math.max(0, (shrink(d.difficulty, r, prior) - 1) / 4));
  const h = typeof b.cachedHeadroom === "number" ? b.cachedHeadroom : 1;
  const u = Math.min(1, Math.max(0, b.cachedNetUpvotes ?? 1) / upvoteMax);
  return q * diff * h * u;
}
export const neutralWeight = () => 1;

// Bradley-Terry. players: [{id, scores: Map(benchId->score)}]
export function bradleyTerry(
  players,
  weightFn,
  { lambda = 0.15, iters = 400, outcome = "binary", benchFilter = null, neighborK = 0 } = {},
) {
  const idx = new Map(players.map((p, i) => [p.id, i]));
  const n = players.length;
  const bs = benchFilter ? benches.filter(benchFilter) : benches;
  const w = new Map(bs.map((b) => [b._id, weightFn(b)]));
  const pos = [...w.values()].filter((x) => x > 0);
  const meanW = pos.reduce((a, c) => a + c, 0) / pos.length;
  const comps = [];
  for (const b of bs) {
    const rows = players
      .filter((p) => p.scores.has(b._id))
      .map((p) => ({ i: idx.get(p.id), s: p.scores.get(b._id) }));
    if (rows.length < 2) continue;
    const bw = (w.get(b._id) ?? 0) / meanW;
    if (bw <= 0) continue;
    let pw = bw / (rows.length - 1);
    // neighborK > 0: each model is only compared with its K nearest neighbours in this bench's
    // rank order (weight bw/K per pair). Flooding a bench with junk rows then cannot dilute the
    // comparison mass of the frontier, because junk rows are nobody's neighbour up there.
    let allowed = null;
    if (neighborK > 0 && rows.length - 1 > neighborK) {
      const order = rows.map((r, k) => k).sort((x, y) => rows[y].s - rows[x].s);
      const rankOf = new Map(order.map((k, pos) => [k, pos]));
      allowed = new Set();
      for (let k = 0; k < rows.length; k++) {
        const pos = rankOf.get(k);
        const cand = order.map((o, p2) => [o, Math.abs(p2 - pos)]).filter(([o]) => o !== k).sort((x, y) => x[1] - y[1]).slice(0, neighborK);
        for (const [o] of cand) allowed.add(k < o ? `${k}:${o}` : `${o}:${k}`);
      }
      pw = bw / neighborK;
    }
    let spread = 1;
    if (outcome === "margin") {
      const vals = rows.map((r) => r.s);
      const m = med(vals);
      spread = Math.max(1e-6, med(vals.map((v) => Math.abs(v - m))) * 1.4826);
    }
    for (let a = 0; a < rows.length; a++)
      for (let c = a + 1; c < rows.length; c++) {
        if (allowed && !allowed.has(`${a}:${c}`)) continue;
        let o;
        if (outcome === "binary") o = rows[a].s === rows[c].s ? 0.5 : rows[a].s > rows[c].s ? 1 : 0;
        else o = 1 / (1 + Math.exp(-(rows[a].s - rows[c].s) / spread));
        comps.push({ l: rows[a].i, r: rows[c].i, o, w: pw });
      }
  }
  const ab = new Float64Array(n), g = new Float64Array(n), inf = new Float64Array(n);
  for (let it = 0; it < iters; it++) {
    g.fill(0);
    inf.fill(lambda);
    for (const c of comps) {
      const d = Math.max(-30, Math.min(30, ab[c.l] - ab[c.r]));
      const p = 1 / (1 + Math.exp(-d));
      const res = c.w * (c.o - p);
      const cur = c.w * p * (1 - p);
      g[c.l] += res;
      g[c.r] -= res;
      inf[c.l] += cur;
      inf[c.r] += cur;
    }
    let ctr = 0;
    for (let i = 0; i < n; i++) {
      g[i] -= lambda * ab[i];
      const st = Math.max(-1, Math.min(1, g[i] / inf[i]));
      ab[i] += 0.8 * st;
      ctr += ab[i];
    }
    ctr /= n || 1;
    for (let i = 0; i < n; i++) ab[i] -= ctr;
  }
  return players.map((p, i) => ({
    id: p.id,
    ability: ab[i],
    score: 100 / (1 + Math.exp(-ab[i])),
    benchCount: p.scores.size,
  }));
}

// Additive two-way model y_pb = alpha_b * theta_p + beta_b, weighted alternating least squares.
export function additiveModel(
  players,
  weightFn,
  { transform = "logit", iters = 300, minParticipants = 2, slope = false, benchFilter = null } = {},
) {
  const bs = benchFilter ? benches.filter(benchFilter) : benches;
  const w = new Map(bs.map((b) => [b._id, weightFn(b)]));
  const perB = new Map();
  for (const p of players)
    for (const [bid, s] of p.scores) {
      if ((w.get(bid) ?? 0) <= 0) continue;
      (perB.get(bid) ?? perB.set(bid, []).get(bid)).push({ p: p.id, s });
    }
  const obs = [];
  const bstats = new Map();
  for (const [bid, rows] of perB) {
    if (rows.length < minParticipants) continue;
    const vals = rows.map((r) => r.s);
    const m = vals.reduce((a, c) => a + c, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, c) => a + (c - m) ** 2, 0) / Math.max(1, vals.length - 1)) || 1;
    bstats.set(bid, { m, sd });
    for (const r of rows) {
      let y;
      const sc = Math.min(99.5, Math.max(0.5, r.s));
      if (transform === "logit") y = Math.log(sc / (100 - sc));
      else if (transform === "z") y = (r.s - m) / sd;
      else y = r.s;
      obs.push({ p: r.p, b: bid, y, w: w.get(bid) });
    }
  }
  const theta = new Map(players.map((p) => [p.id, 0]));
  const beta = new Map([...bstats.keys()].map((b) => [b, 0]));
  const alpha = new Map([...bstats.keys()].map((b) => [b, 1]));
  for (let it = 0; it < iters; it++) {
    const bsum = new Map();
    for (const o of obs) {
      const e = bsum.get(o.b) ?? { n: 0, s: 0 };
      e.n += 1;
      e.s += o.y - alpha.get(o.b) * theta.get(o.p);
      bsum.set(o.b, e);
    }
    for (const [b, e] of bsum) beta.set(b, e.s / e.n);
    if (slope) {
      const as = new Map();
      for (const o of obs) {
        const t = theta.get(o.p);
        const e = as.get(o.b) ?? { num: 0, den: 0 };
        e.num += (o.y - beta.get(o.b)) * t;
        e.den += t * t;
        as.set(o.b, e);
      }
      for (const [b, e] of as) alpha.set(b, e.den > 1e-9 ? Math.max(0.2, Math.min(5, e.num / e.den)) : 1);
    }
    const ts = new Map();
    for (const o of obs) {
      const a = alpha.get(o.b);
      const e = ts.get(o.p) ?? { num: 0, den: 0 };
      e.num += o.w * a * (o.y - beta.get(o.b));
      e.den += o.w * a * a;
      ts.set(o.p, e);
    }
    for (const [p, e] of ts) theta.set(p, e.den > 0 ? e.num / e.den : 0);
    const tv = [...theta.values()];
    const mu = tv.reduce((a, c) => a + c, 0) / tv.length;
    for (const [p, v] of theta) theta.set(p, v - mu);
    for (const [b, v] of beta) beta.set(b, v + mu * alpha.get(b));
    if (slope) {
      const av = [...alpha.values()];
      const ma = av.reduce((a, c) => a + c, 0) / av.length;
      for (const [b, v] of alpha) alpha.set(b, v / ma);
      for (const [p, v] of theta) theta.set(p, v * ma);
    }
  }
  let ss = 0, cnt = 0;
  for (const o of obs) {
    const r = o.y - (alpha.get(o.b) * theta.get(o.p) + beta.get(o.b));
    ss += r * r;
    cnt++;
  }
  const sigma = Math.sqrt(ss / Math.max(1, cnt - players.length - bstats.size));
  const wsum = new Map();
  for (const o of obs) wsum.set(o.p, (wsum.get(o.p) ?? 0) + o.w * alpha.get(o.b) ** 2);
  const pos = [...w.values()].filter((x) => x > 0);
  const meanW = pos.reduce((a, c) => a + c, 0) / pos.length;
  return {
    beta,
    alpha,
    sigma,
    rows: players.map((p) => ({
      id: p.id,
      theta: theta.get(p.id),
      se: sigma / Math.sqrt((wsum.get(p.id) ?? 1e-9) / meanW),
      benchCount: p.scores.size,
      evidence: (wsum.get(p.id) ?? 0) / meanW,
    })),
  };
}

export function prodModelRanking() {
  const rows = [];
  let maxE = 0;
  for (const m of models) {
    const sc = cell.get(m._id);
    if (!sc) continue;
    let ws = 0, aw = 0, ew = 0, n = 0;
    for (const [bid, v] of sc) {
      const b = bById.get(bid);
      const a = prodModelWeight(b);
      if (a <= 0) continue;
      ws += a * v;
      aw += a;
      ew += prodEvidenceWeight(b);
      n++;
    }
    rows.push({ id: m._id, name: m.name, family: famTag(m), mean: aw > 0 ? ws / aw : 0, E: ew, benchCount: n });
    if (ew > maxE) maxE = ew;
  }
  for (const r of rows) {
    const c = r.E > 0 ? Math.sqrt(Math.min(1, r.E / maxE)) : 0;
    r.confidence = c;
    r.supra = r.E > 0 ? 50 + c * (r.mean - 50) : 0;
  }
  return rows.sort((a, b) => b.supra - a.supra);
}
export function familyPlayers(benchFilter = null) {
  return [...families.values()]
    .map((f) => ({
      id: f.key,
      scores: new Map([...f.benches].filter(([b]) => !benchFilter || benchFilter(bById.get(b))).map(([b, v]) => [b, v.score])),
    }))
    .filter((p) => p.scores.size > 0);
}
export function modelPlayers(benchFilter = null) {
  return models
    .filter((m) => cell.has(m._id))
    .map((m) => ({
      id: m._id,
      scores: new Map([...cell.get(m._id)].filter(([b]) => !benchFilter || benchFilter(bById.get(b)))),
    }))
    .filter((p) => p.scores.size > 0);
}
export function pairAgreement(rankA, rankB) {
  const ids = [...rankA.keys()].filter((k) => rankB.has(k));
  let agree = 0, tot = 0;
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = Math.sign(rankA.get(ids[i]) - rankA.get(ids[j]));
      const b = Math.sign(rankB.get(ids[i]) - rankB.get(ids[j]));
      if (a === 0 || b === 0) continue;
      tot++;
      if (a === b) agree++;
    }
  return tot ? agree / tot : 1;
}
export const rankMap = (rows, key = "score") =>
  new Map([...rows].sort((a, b) => b[key] - a[key]).map((r, i) => [r.id, i + 1]));
