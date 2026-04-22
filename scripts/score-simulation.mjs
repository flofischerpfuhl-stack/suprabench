#!/usr/bin/env node
// ════════════════════════════════════════════════════════════
// SupraScore formula simulation harness.
//
// Tests the proposed formula  supraScore = weightedMean × √(totalWeight / maxTotalWeight)
// against a set of hard + soft criteria on synthetic random datasets.
//
// Criteria (see README in this folder / last chat turn):
//   C1  No-Best-Nowhere: if X is strictly beaten on every bench X has,
//                        X cannot be strict #1 overall.
//   C2  Bounded: supraScore ∈ [0, 100].
//   C3  Score-monotonic: raising X's score on any bench cannot decrease
//                        X's supraScore (holding other models fixed).
//   C4  Coverage-monotonic (favourable): adding a new bench score
//                        s ≥ weightedMean(X) to X cannot decrease X's
//                        supraScore.
//   C5  All-equal-coverage: if every model has the same totalWeight,
//                        the supraScore ranking equals the weightedMean
//                        ranking.
//   C6  Permutation-invariant + deterministic.
//   C7  Sonnet regression: replay the observed DB state (Claude 4.5
//                        Sonnet single-bench, 5th on MATH L5) and
//                        confirm it is NOT #1.
//
// Run with:   node scripts/score-simulation.mjs
// ════════════════════════════════════════════════════════════

// ── Deterministic PRNG so runs are reproducible ──
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Proposed formula ─────────────────────────────────────
// Given an aggregated-per-model array:
//   [{ id, weightedMean, totalWeight }]
// return the same array with `supraScore` filled in.
function proposedFormula(models) {
  const maxTotal = models.reduce(
    (m, x) => (x.totalWeight > m ? x.totalWeight : m),
    0
  );
  for (const m of models) {
    const share = maxTotal > 0 ? m.totalWeight / maxTotal : 1;
    m.supraScore = m.weightedMean * Math.sqrt(share);
  }
  return models;
}

// ── Dataset → per-model aggregate ───────────────────────
// scores: [{ modelIdx, benchIdx, score, weight }]
function aggregate(scores) {
  const byModel = new Map();
  for (const s of scores) {
    const bucket =
      byModel.get(s.modelIdx) ??
      byModel.set(s.modelIdx, { scores: [] }).get(s.modelIdx);
    bucket.scores.push(s);
  }
  const models = [];
  for (const [idx, data] of byModel.entries()) {
    let wsum = 0;
    let wnum = 0;
    for (const s of data.scores) {
      wsum += s.weight;
      wnum += s.weight * s.score;
    }
    models.push({
      id: idx,
      name: `M${idx}`,
      benchCount: data.scores.length,
      totalWeight: wsum,
      weightedMean: wsum > 0 ? wnum / wsum : 0,
      scores: data.scores,
    });
  }
  return models;
}

// ── Dataset factory ──────────────────────────────────────
// Each model has a latent "skill" ~ U(0, 100).
// Each bench has a "difficulty bias" shifting all scores on it.
// Bench weights follow the real app: quality × difficulty × headroom,
// but for simulation we just use U(0.1, 50).
// Sparsity ∈ [0,1] controls how many (model,bench) pairs get tested.
function makeRandomDataset({
  seed = 1,
  nModels = 5,
  nBenches = 5,
  sparsity = 0.5,
} = {}) {
  const rand = mulberry32(seed);
  const skills = Array.from({ length: nModels }, () => rand() * 100);
  const bias = Array.from({ length: nBenches }, () => (rand() - 0.5) * 40);
  const bw = Array.from(
    { length: nBenches },
    () => 0.1 + rand() * 49.9
  );
  const scores = [];
  for (let m = 0; m < nModels; m++) {
    for (let b = 0; b < nBenches; b++) {
      if (rand() < sparsity) {
        const raw = skills[m] + bias[b] + (rand() - 0.5) * 10;
        const clamped = Math.max(0, Math.min(100, raw));
        scores.push({
          modelIdx: m,
          benchIdx: b,
          score: clamped,
          weight: bw[b],
        });
      }
    }
  }
  return { nModels, nBenches, benchWeights: bw, scores };
}

// ── Criterion checks ─────────────────────────────────────
// Returns { pass: bool, info: {...} }
const EPS = 1e-9;

function checkC1(dataset, ranked) {
  // Top model must be #1 on at least one of its own benches
  // (ties allowed, i.e. top model's score >= max on that bench).
  // If top is strictly beaten on all its benches → C1 violation.
  const top = ranked[0];
  if (!top) return { pass: true, info: "no models" };
  const perBench = new Map();
  for (const s of dataset.scores) {
    const arr = perBench.get(s.benchIdx) ?? [];
    arr.push(s);
    perBench.set(s.benchIdx, arr);
  }
  let bestOnAny = false;
  for (const s of top.scores) {
    const allOnBench = perBench.get(s.benchIdx);
    const maxScore = Math.max(...allOnBench.map((x) => x.score));
    if (s.score >= maxScore - EPS) {
      bestOnAny = true;
      break;
    }
  }
  return {
    pass: bestOnAny,
    info: bestOnAny
      ? "top model was #1 on at least one of its benches"
      : "top model was NOT #1 on any of its benches (C1 violation)",
    topName: top.name,
    topSupraScore: top.supraScore.toFixed(2),
    topScores: top.scores.map((s) => ({
      b: s.benchIdx,
      score: s.score.toFixed(2),
    })),
  };
}

function checkC2(ranked) {
  for (const m of ranked) {
    if (m.supraScore < -EPS || m.supraScore > 100 + EPS)
      return {
        pass: false,
        info: `model ${m.name} has supraScore ${m.supraScore}`,
      };
  }
  return { pass: true };
}

function checkC3(dataset, ranked) {
  // Pick a random model-bench pair, increase the score by 5 (capped at 100)
  // and verify the targeted model's supraScore did NOT decrease.
  if (!dataset.scores.length) return { pass: true, info: "empty" };
  const rand = mulberry32(777 + dataset.scores.length);
  const idx = Math.floor(rand() * dataset.scores.length);
  const pick = dataset.scores[idx];
  const bumped = dataset.scores.map((s, i) =>
    i === idx
      ? { ...s, score: Math.min(100, s.score + 5) }
      : { ...s }
  );
  const before = ranked.find((m) => m.id === pick.modelIdx).supraScore;
  const after = proposedFormula(aggregate(bumped)).find(
    (m) => m.id === pick.modelIdx
  ).supraScore;
  return {
    pass: after >= before - EPS,
    info: `model ${pick.modelIdx}: before=${before.toFixed(2)}, after=${after.toFixed(2)}`,
  };
}

function checkC4(dataset, ranked) {
  // Pick a random model. Add a new bench score = weightedMean + 5 (capped)
  // on a NEW bench. Verify the model's supraScore did NOT decrease.
  const modelsWithScores = [...new Set(dataset.scores.map((s) => s.modelIdx))];
  if (!modelsWithScores.length) return { pass: true, info: "empty" };
  const rand = mulberry32(12345 + dataset.scores.length);
  const m = modelsWithScores[Math.floor(rand() * modelsWithScores.length)];
  const r = ranked.find((x) => x.id === m);
  const newBenchIdx = dataset.nBenches + 1;
  const newWeight = 1 + rand() * 49;
  const newScore = Math.min(100, r.weightedMean + 5);
  const extended = [
    ...dataset.scores,
    { modelIdx: m, benchIdx: newBenchIdx, score: newScore, weight: newWeight },
  ];
  const before = r.supraScore;
  const after = proposedFormula(aggregate(extended)).find(
    (x) => x.id === m
  ).supraScore;
  return {
    pass: after >= before - EPS,
    info: `model ${m}: before=${before.toFixed(2)}, after=${after.toFixed(2)}`,
  };
}

function checkC5(dataset) {
  // Force equal coverage: build a synthetic dataset where every model gets
  // exactly one score with weight 1, then verify supraScore order == weightedMean order.
  const byModel = new Map();
  for (const s of dataset.scores) {
    if (!byModel.has(s.modelIdx)) byModel.set(s.modelIdx, s);
  }
  const synth = [];
  for (const [m, s] of byModel.entries()) {
    synth.push({ modelIdx: m, benchIdx: 0, score: s.score, weight: 1 });
  }
  const agg = aggregate(synth);
  const byMean = [...agg].sort((a, b) => b.weightedMean - a.weightedMean);
  const bySupra = proposedFormula([...agg]).sort(
    (a, b) => b.supraScore - a.supraScore
  );
  const sameOrder = byMean.every((m, i) => m.id === bySupra[i].id);
  return { pass: sameOrder };
}

function checkC6(dataset) {
  // Shuffle input scores, ensure outputs are identical.
  const rand = mulberry32(99 + dataset.scores.length);
  const shuffled = [...dataset.scores].sort(() => rand() - 0.5);
  const a = proposedFormula(aggregate(dataset.scores));
  const b = proposedFormula(aggregate(shuffled));
  const ma = new Map(a.map((m) => [m.id, m.supraScore]));
  const mb = new Map(b.map((m) => [m.id, m.supraScore]));
  for (const [id, sa] of ma.entries()) {
    const sb = mb.get(id);
    if (Math.abs(sa - sb) > 1e-6)
      return { pass: false, info: `model ${id}: ${sa} vs ${sb}` };
  }
  return { pass: true };
}

// ── Sonnet regression test (C7) ──────────────────────────
// Replay the observed state:
//   MATH Level 5 scores (only bench shared across these):
//     GPT-5 (high)     98.1
//     GPT-5 (med)      97.9   (also on 2 other benches, weightedMean across all 3 = 90.4)
//     o4-mini (high)   97.8
//     o3 (high)        97.8
//     Claude 4.5 Sonnet 97.7  (only bench)
//   Other observed models from the ranking screenshot:
//     GPT-5.2 (med)    93.9 (1 bench)
//     o3-pro           88.9 (1 bench)
//     Gemini 3 DT      86.8 (weightedMean over 2 benches)
//     Claude 4.5 Opus  84.9 (1 bench)
//
// Only MATH L5 is dense enough to check who was #1: GPT-5 (high) at 98.1
// Claude 4.5 Sonnet was 5th there and has no other benches.
function sonnetRegression() {
  // Reconstruct the aggregated view that the DB exposed when the
  // screenshots were taken. Each row = {id, weightedMean, totalWeight,
  // scores: [per-bench-score]} where scores only need to carry enough
  // info for C1-check to run correctly.
  //
  // We treat MATH L5 weight as 2.5 (50*0.5*0.1 floor, see rankings.ts).
  const W_MATH = 2.5;
  const W_OTHER = 20; // rough average for other benches
  const models = [
    // (we don't actually know GPT-5 (high)'s weightedMean or # of
    //  benches, but it must be lower than Claude's or it would have
    //  been in the top 6. Pick 97.0 over 2 benches.)
    {
      id: "gpt5-high",
      name: "GPT-5 (high)",
      scores: [{ benchIdx: "math-l5", score: 98.1, weight: W_MATH }],
      weightedMean: 98.1,
      totalWeight: W_MATH,
      benchCount: 1,
    },
    {
      id: "gpt5-med",
      name: "GPT-5 (med)",
      scores: [
        { benchIdx: "math-l5", score: 97.9, weight: W_MATH },
        { benchIdx: "bench-x", score: 88, weight: W_OTHER },
        { benchIdx: "bench-y", score: 85, weight: W_OTHER },
      ],
      weightedMean: 90.4,
      totalWeight: W_MATH + 2 * W_OTHER,
      benchCount: 3,
    },
    {
      id: "o4-mini-high",
      name: "o4-mini (high)",
      scores: [{ benchIdx: "math-l5", score: 97.8, weight: W_MATH }],
      weightedMean: 97.8,
      totalWeight: W_MATH,
      benchCount: 1,
    },
    {
      id: "o3-high",
      name: "o3 (high)",
      scores: [{ benchIdx: "math-l5", score: 97.8, weight: W_MATH }],
      weightedMean: 97.8,
      totalWeight: W_MATH,
      benchCount: 1,
    },
    {
      id: "claude-45-sonnet",
      name: "Claude 4.5 Sonnet",
      scores: [{ benchIdx: "math-l5", score: 97.7, weight: W_MATH }],
      weightedMean: 97.7,
      totalWeight: W_MATH,
      benchCount: 1,
    },
    {
      id: "gpt52-med",
      name: "GPT-5.2 (med)",
      scores: [{ benchIdx: "bench-a", score: 93.9, weight: W_OTHER }],
      weightedMean: 93.9,
      totalWeight: W_OTHER,
      benchCount: 1,
    },
    {
      id: "o3-pro",
      name: "o3-pro",
      scores: [{ benchIdx: "bench-b", score: 88.9, weight: W_OTHER }],
      weightedMean: 88.9,
      totalWeight: W_OTHER,
      benchCount: 1,
    },
    {
      id: "gemini-3-dt",
      name: "Gemini 3 Deep Think",
      scores: [
        { benchIdx: "bench-c", score: 90, weight: W_OTHER },
        { benchIdx: "bench-d", score: 84, weight: W_OTHER },
      ],
      weightedMean: 86.8,
      totalWeight: 2 * W_OTHER,
      benchCount: 2,
    },
    {
      id: "claude-45-opus",
      name: "Claude 4.5 Opus",
      scores: [{ benchIdx: "bench-e", score: 84.9, weight: W_OTHER }],
      weightedMean: 84.9,
      totalWeight: W_OTHER,
      benchCount: 1,
    },
  ];
  const scored = proposedFormula(models);
  scored.sort((a, b) => b.supraScore - a.supraScore);
  const top = scored[0];
  const claudeSonnet = scored.find((m) => m.id === "claude-45-sonnet");
  return {
    ranking: scored.map((m) => ({
      name: m.name,
      supraScore: m.supraScore.toFixed(2),
      wm: m.weightedMean.toFixed(2),
      N: m.benchCount,
    })),
    pass: claudeSonnet.supraScore < top.supraScore,
    info: `top = ${top.name} (${top.supraScore.toFixed(2)}), Sonnet = ${claudeSonnet.supraScore.toFixed(2)}`,
  };
}

// ── Main ─────────────────────────────────────────────────
const summary = { C1: { pass: 0, fail: 0 }, C2: { pass: 0, fail: 0 }, C3: { pass: 0, fail: 0 }, C4: { pass: 0, fail: 0 }, C5: { pass: 0, fail: 0 }, C6: { pass: 0, fail: 0 } };
const C1_violations = [];

const N_TRIALS = 500;
for (let t = 0; t < N_TRIALS; t++) {
  const rand = mulberry32(t * 97 + 3);
  const ds = makeRandomDataset({
    seed: t,
    nModels: 3 + Math.floor(rand() * 8), // 3..10
    nBenches: 3 + Math.floor(rand() * 12), // 3..14
    sparsity: 0.25 + rand() * 0.6, // 25%..85%
  });
  if (!ds.scores.length) continue;
  const agg = aggregate(ds.scores);
  const ranked = [...proposedFormula(agg)].sort(
    (a, b) => b.supraScore - a.supraScore
  );
  const r1 = checkC1(ds, ranked);
  if (r1.pass) summary.C1.pass++;
  else {
    summary.C1.fail++;
    if (C1_violations.length < 5) C1_violations.push({ trial: t, ...r1, ds });
  }
  const r2 = checkC2(ranked);
  r2.pass ? summary.C2.pass++ : summary.C2.fail++;
  const r3 = checkC3(ds, ranked);
  r3.pass ? summary.C3.pass++ : summary.C3.fail++;
  const r4 = checkC4(ds, ranked);
  r4.pass ? summary.C4.pass++ : summary.C4.fail++;
  const r5 = checkC5(ds);
  r5.pass ? summary.C5.pass++ : summary.C5.fail++;
  const r6 = checkC6(ds);
  r6.pass ? summary.C6.pass++ : summary.C6.fail++;
}

console.log(`\n=== Proposal: supraScore = weightedMean × √(totalWeight / maxTotalWeight) ===\n`);
console.log(`Ran ${N_TRIALS} random datasets.`);
for (const [k, v] of Object.entries(summary)) {
  const total = v.pass + v.fail;
  const pct = total > 0 ? ((v.pass / total) * 100).toFixed(1) : "-";
  console.log(`  ${k}:  ${v.pass}/${total}  (${pct}% pass)`);
}

if (C1_violations.length) {
  console.log(`\n--- Sample C1 violations (first ${C1_violations.length}) ---`);
  for (const v of C1_violations) {
    console.log(`\nTrial #${v.trial}:  top=${v.topName}, supraScore=${v.topSupraScore}`);
    console.log(`  ${v.info}`);
    console.log(`  top's bench scores: ${JSON.stringify(v.topScores)}`);
    // Also dump the other models for context
    const agg = aggregate(v.ds.scores);
    const ranked = [...proposedFormula(agg)].sort(
      (a, b) => b.supraScore - a.supraScore
    );
    console.log(`  full ranking:`);
    for (const m of ranked.slice(0, 6)) {
      console.log(
        `    ${m.name}  supraScore=${m.supraScore.toFixed(2)}  wm=${m.weightedMean.toFixed(2)}  N=${m.benchCount}  totalW=${m.totalWeight.toFixed(2)}`
      );
    }
  }
}

console.log(`\n=== C7: Sonnet regression ===`);
const s = sonnetRegression();
console.log(`  ${s.pass ? "PASS" : "FAIL"}:  ${s.info}`);
console.log(`  Full ranking:`);
for (const m of s.ranking)
  console.log(`    ${m.name.padEnd(22)}  supraScore=${m.supraScore}  wm=${m.wm}  N=${m.N}`);
