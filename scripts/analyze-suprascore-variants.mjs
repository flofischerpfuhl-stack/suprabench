#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const OUT = resolve("docs/research/suprascore-formula-analysis-2026-06-22.html");

const INLINE_QUERY = `
const [models, benches, scores, modelRankings, familyRankings] = await Promise.all([
  ctx.db.query("models").collect(),
  ctx.db.query("benches").collect(),
  ctx.db.query("modelScores").collect(),
  ctx.db.query("modelRankings").collect(),
  ctx.db.query("familyRankings").collect(),
]);
return { models, benches, scores, modelRankings, familyRankings, capturedAt: Date.now() };
`;

function readProductionSnapshot() {
  const stdout = execFileSync(
    "npx",
    ["convex", "run", "--prod", "--inline-query", INLINE_QUERY],
    { encoding: "utf8", maxBuffer: 80 * 1024 * 1024 }
  );
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`Could not parse Convex output:\n${stdout.slice(0, 1000)}`);
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

function median(values) {
  const xs = [...values].sort((a, b) => a - b);
  if (!xs.length) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function pct(n, digits = 1) {
  return Number.isFinite(n) ? n.toFixed(digits) : "0.0";
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function modelUrl(slug) {
  return `https://suprabench.com/#model/${encodeURIComponent(slug)}`;
}

function benchUrl(slug) {
  return `https://suprabench.com/#bench/${encodeURIComponent(slug)}`;
}

function computeRankings(snapshot, variant) {
  const models = snapshot.models.filter((m) => !m.hidden);
  const benches = snapshot.benches.filter((b) => !b.hidden);
  const modelById = new Map(models.map((m) => [m._id, m]));
  const benchById = new Map(benches.map((b) => [b._id, b]));
  const validScores = snapshot.scores.filter(
    (s) => s.upvotes > s.downvotes && modelById.has(s.modelId) && benchById.has(s.benchId)
  );

  const upvoteMax = Math.max(
    0,
    ...benches.map((b) => (typeof b.cachedNetUpvotes === "number" ? b.cachedNetUpvotes : 1))
  );
  const modelCountMax = Math.max(
    0,
    ...benches.map((b) => (typeof b.cachedModelCount === "number" ? b.cachedModelCount : 0))
  );

  const benchWeights = new Map();
  for (const b of benches) {
    const raw = typeof b.cachedEffectiveWeight === "number" ? b.cachedEffectiveWeight : 0;
    const upvotes = typeof b.cachedNetUpvotes === "number" ? Math.max(0, b.cachedNetUpvotes) : 1;
    const modelCount = typeof b.cachedModelCount === "number" ? Math.max(0, b.cachedModelCount) : 0;
    const uShare = upvoteMax > 0 ? Math.min(1, upvotes / upvoteMax) : 1;
    const nShare = modelCountMax > 0 ? Math.min(1, modelCount / modelCountMax) : 1;
    const coverage = Math.pow(uShare * nShare, variant.benchCoverageExponent ?? 0);
    benchWeights.set(b._id, raw * coverage);
  }

  const scoresByModelBench = new Map();
  for (const s of validScores) {
    let byBench = scoresByModelBench.get(s.modelId);
    if (!byBench) {
      byBench = new Map();
      scoresByModelBench.set(s.modelId, byBench);
    }
    const arr = byBench.get(s.benchId) ?? [];
    arr.push(s.normalizedScore);
    byBench.set(s.benchId, arr);
  }

  const rows = [];
  for (const m of models) {
    const byBench = scoresByModelBench.get(m._id) ?? new Map();
    let weightedSum = 0;
    let totalWeight = 0;
    const benchRows = [];
    for (const [benchId, values] of byBench.entries()) {
      const b = benchById.get(benchId);
      const score = median(values);
      const weight = benchWeights.get(benchId) ?? 0;
      if (weight <= 0) continue;
      weightedSum += score * weight;
      totalWeight += weight;
      benchRows.push({ bench: b, score, weight });
    }
    const weightedMean = totalWeight > 0 ? weightedSum / totalWeight : 0;
    rows.push({
      model: m,
      weightedMean,
      totalWeight,
      benchCount: benchRows.length,
      benchRows,
    });
  }

  const maxTotalWeight = Math.max(0, ...rows.filter((r) => !r.model.hidden).map((r) => r.totalWeight));
  const scored = rows.map((r) => {
    const share = maxTotalWeight > 0 ? Math.min(1, r.totalWeight / maxTotalWeight) : 0;
    const exponent = variant.modelCoverageExponent ?? 0;
    const rawConfidence = exponent === 0 ? 1 : Math.pow(share, exponent);
    const floor = variant.modelCoverageFloor ?? 0;
    const confidence = exponent === 0 ? 1 : floor + (1 - floor) * rawConfidence;
    const eligible =
      r.benchCount >= (variant.minBenchCount ?? 0) &&
      r.totalWeight >= (variant.minTotalWeight ?? 0);
    const score = eligible ? r.weightedMean * confidence : 0;
    return {
      ...r,
      score,
      confidence,
      coverageShare: share,
      eligible,
      ineligibleReason:
        r.benchCount < (variant.minBenchCount ?? 0)
          ? `needs ${variant.minBenchCount} benches`
          : r.totalWeight < (variant.minTotalWeight ?? 0)
            ? `needs weight ${variant.minTotalWeight}`
            : "",
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.weightedMean !== a.weightedMean) return b.weightedMean - a.weightedMean;
    return b.totalWeight - a.totalWeight;
  });
  return { rows: scored, upvoteMax, modelCountMax };
}

function summarizeBench(snapshot, slug, variant) {
  const b = snapshot.benches.find((x) => x.slug === slug);
  if (!b) return null;
  const benches = snapshot.benches.filter((x) => !x.hidden);
  const upvoteMax = Math.max(0, ...benches.map((x) => x.cachedNetUpvotes ?? 1));
  const modelCountMax = Math.max(0, ...benches.map((x) => x.cachedModelCount ?? 0));
  const uShare = upvoteMax > 0 ? Math.min(1, Math.max(0, b.cachedNetUpvotes ?? 1) / upvoteMax) : 1;
  const nShare = modelCountMax > 0 ? Math.min(1, Math.max(0, b.cachedModelCount ?? 0) / modelCountMax) : 1;
  const raw = b.cachedEffectiveWeight ?? 0;
  const effective = raw * Math.pow(uShare * nShare, variant.benchCoverageExponent ?? 0);
  return {
    name: b.name,
    slug: b.slug,
    quality: b.cachedQualityScore ?? 0,
    raw,
    effective,
    headroom: b.cachedHeadroom ?? 0,
    frontierMean: b.cachedFrontierMean ?? 0,
    modelCount: b.cachedModelCount ?? 0,
    maxModelCount: modelCountMax,
    dimensions: b.cachedDimensions ?? {},
  };
}

function topRowsHtml(rows, limit = 15) {
  return rows.slice(0, limit).map((r, i) => {
    const topBenches = [...r.benchRows]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 4)
      .map((x) => `${x.bench?.name ?? "?"} ${pct(x.score, 1)}`)
      .join("; ");
    return `<tr>
      <td>${i + 1}</td>
      <td><a href="${modelUrl(r.model.slug)}">${htmlEscape(r.model.name)}</a><div class="muted">${htmlEscape(r.model.provider)} · ${htmlEscape(r.model.familyTag ?? "")}</div></td>
      <td class="num">${pct(r.score, 1)}</td>
      <td class="num">${pct(r.weightedMean, 1)}</td>
      <td class="num">${pct(r.confidence * 100, 0)}%</td>
      <td class="num">${r.benchCount}</td>
      <td class="num">${pct(r.totalWeight, 1)}</td>
      <td>${htmlEscape(topBenches)}</td>
    </tr>`;
  }).join("\n");
}

function benchRowsHtml(rows) {
  return rows.map((b) => `<tr>
    <td><a href="${benchUrl(b.slug)}">${htmlEscape(b.name)}</a></td>
    <td class="num">${pct(b.quality, 0)}</td>
    <td class="num">${pct(b.raw, 1)}</td>
    <td class="num">${pct(b.effective, 1)}</td>
    <td class="num">${pct(b.headroom, 2)}</td>
    <td class="num">${pct(b.frontierMean, 1)}</td>
    <td class="num">${b.modelCount}/${b.maxModelCount}</td>
  </tr>`).join("\n");
}

function variantCardHtml(name, variant, computed, note) {
  return `<section class="card">
    <h2>${htmlEscape(name)}</h2>
    <p>${htmlEscape(note)}</p>
    <table>
      <thead><tr><th>#</th><th>Model</th><th>Shown Score</th><th>Ability Mean</th><th>Confidence</th><th>Benches</th><th>Weight</th><th>Main scored benches</th></tr></thead>
      <tbody>${topRowsHtml(computed.rows)}</tbody>
    </table>
  </section>`;
}

const snapshot = readProductionSnapshot();

const variants = [
  {
    key: "current",
    name: "A. Current Production SupraScore",
    config: { benchCoverageExponent: 0.5, modelCoverageExponent: 0.5, modelCoverageFloor: 0 },
    note: "Deployed formula: ability mean multiplied by sqrt(model total weight share). This is conservative and strongly rewards broad measurement coverage.",
  },
  {
    key: "ability_raw",
    name: "B. AbilityScore: intrinsic bench weights only",
    config: { benchCoverageExponent: 0, modelCoverageExponent: 0 },
    note: "Uses raw Q x difficulty x headroom bench weights. No bench coverage damping and no model coverage damping. Best estimate of measured capability, but sparse models can rank very high.",
  },
  {
    key: "ability_bench_trust",
    name: "C. AbilityScore with bench trust damping only",
    config: { benchCoverageExponent: 0.5, modelCoverageExponent: 0 },
    note: "Keeps the anti-vanity damping on benchmarks, but removes the model-side coverage multiplier from the headline model score.",
  },
  {
    key: "soft_model",
    name: "D. Soft Confidence SupraScore",
    config: { benchCoverageExponent: 0.5, modelCoverageExponent: 0.5, modelCoverageFloor: 0.8 },
    note: "Same bench weights as production, but model coverage can only reduce the ability estimate by at most 20%. Coverage still matters, but it no longer dominates ability.",
  },
  {
    key: "soft_all",
    name: "E. Soft benchmark + soft model confidence",
    config: { benchCoverageExponent: 0.25, modelCoverageExponent: 0.25, modelCoverageFloor: 0.85 },
    note: "Weakens both coverage dampers. New high-quality benchmarks and new models move up faster while still carrying a visible evidence penalty.",
  },
  {
    key: "eligible_3",
    name: "F. AbilityScore with minimum evidence gate",
    config: { benchCoverageExponent: 0, modelCoverageExponent: 0, minBenchCount: 3 },
    note: "Ranks by measured ability, but only if a model has at least 3 contributing benchmarks. Sparse models get a score of 0 until enough evidence exists.",
  },
  {
    key: "eligible_weight_140",
    name: "G. AbilityScore with minimum evidence-weight gate",
    config: { benchCoverageExponent: 0, modelCoverageExponent: 0, minTotalWeight: 140 },
    note: "Ranks by measured ability, but only if the model has accumulated at least 140 points of intrinsic benchmark weight. This is less arbitrary than a raw bench-count gate.",
  },
];

const computed = new Map();
for (const v of variants) computed.set(v.key, computeRankings(snapshot, v.config));

const current = computed.get("current").rows;
const abilityRaw = computed.get("ability_raw").rows;
const abilityBenchTrust = computed.get("ability_bench_trust").rows;
const softModel = computed.get("soft_model").rows;
const softAll = computed.get("soft_all").rows;
const eligible3 = computed.get("eligible_3").rows;

function findRank(rows, slug) {
  const idx = rows.findIndex((r) => r.model.slug === slug);
  if (idx < 0) return null;
  const r = rows[idx];
  return { rank: idx + 1, score: r.score, mean: r.weightedMean, benches: r.benchCount, confidence: r.confidence, totalWeight: r.totalWeight };
}

const tracked = [
  ["claude-fable-5-xhigh", "Claude Fable 5 (xhigh)"],
  ["claude-opus-4-8", "Claude Opus 4.8"],
  ["gpt-5-5", "GPT-5.5"],
  ["gemini-3-1-pro-preview", "Gemini 3.1 Pro Preview"],
];

const trackedHtml = tracked.map(([slug, label]) => {
  const cells = variants.map((v) => {
    const r = findRank(computed.get(v.key).rows, slug);
    return `<td>${r ? `#${r.rank}<br><span class="muted">${pct(r.score, 1)} · ${r.benches} benches · conf ${pct(r.confidence * 100, 0)}%</span>` : "missing"}</td>`;
  }).join("");
  return `<tr><td>${htmlEscape(label)}</td>${cells}</tr>`;
}).join("\n");

const benchCompareCurrent = ["swe-bench-pro", "deepswe", "swe-bench-verified"].map((slug) =>
  summarizeBench(snapshot, slug, variants[0].config)
);
const benchCompareSoft = ["swe-bench-pro", "deepswe", "swe-bench-verified"].map((slug) =>
  summarizeBench(snapshot, slug, variants[4].config)
);

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SupraScore Formula Analysis · 2026-06-22</title>
  <style>
    :root { color-scheme: dark; --bg:#050505; --panel:#111; --panel2:#181818; --text:#f5f5f5; --muted:#999; --border:#333; --accent:#e5fe40; --green:#44ff88; --warn:#ffaa44; --red:#ff5555; }
    body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
    main { max-width:1180px; margin:0 auto; padding:32px 20px 80px; }
    h1 { font-size:42px; line-height:1; margin:0 0 12px; letter-spacing:-.02em; }
    h2 { margin:0 0 10px; font-size:22px; }
    h3 { margin:20px 0 8px; font-size:16px; color:var(--accent); text-transform:uppercase; letter-spacing:.04em; }
    p { color:#cfcfcf; max-width:940px; }
    a { color:var(--accent); text-decoration:none; }
    code { background:#202020; padding:1px 5px; border-radius:4px; }
    .meta { color:var(--muted); margin-bottom:28px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; margin:18px 0 24px; }
    .stat, .card { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:16px; }
    .stat strong { display:block; font-size:24px; color:var(--accent); }
    .recommendation { border-color:var(--accent); background:linear-gradient(180deg,#15170a,#101010); }
    .warning { border-color:var(--warn); }
    table { width:100%; border-collapse:collapse; margin-top:12px; }
    th, td { border-bottom:1px solid var(--border); padding:8px 10px; vertical-align:top; text-align:left; }
    th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .muted { color:var(--muted); font-size:12px; }
    .pill { display:inline-block; border:1px solid var(--border); border-radius:99px; padding:2px 8px; color:#bbb; margin:2px 4px 2px 0; }
    .good { color:var(--green); }
    .warn { color:var(--warn); }
    .bad { color:var(--red); }
    .card { margin:18px 0; overflow-x:auto; }
    .formula { background:var(--panel2); border:1px solid var(--border); border-radius:8px; padding:14px; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-x:auto; }
  </style>
</head>
<body>
<main>
  <h1>SupraScore Formula Analysis</h1>
  <div class="meta">Captured from Convex Production on ${new Date(snapshot.capturedAt).toISOString()} · ${snapshot.models.length} models · ${snapshot.benches.length} benches · ${snapshot.scores.length} submissions</div>

  <section class="card recommendation">
    <h2>Recommendation</h2>
    <p><strong>Do not keep the current production formula as the only headline score if SupraScore is meant to mean "real model ability".</strong> The current formula is internally coherent, but it measures <em>ability times evidence coverage</em>. That is why a broadly tested Gemini row can outrank a likely stronger but sparsely measured Fable row.</p>
    <p>Best product change: split the concept into two public numbers.</p>
    <p><span class="pill">AbilityScore</span> weighted mean over intrinsic benchmark weights <code>Q x difficulty x headroom</code>, optionally with benchmark trust damping. This should drive "best model" ranking.</p>
    <p><span class="pill">Evidence</span> coverage/confidence percentage from accumulated benchmark weight. This should be shown next to the score and used as a badge or tie-breaker, not multiplied hard into ability.</p>
    <p>If you need one number for launch, use Variant F or G: rank by AbilityScore, but require a minimum evidence floor before a model can appear in the main ranking. Under-threshold models should still be visible as <em>provisional</em>, with their evidence percentage shown.</p>
  </section>

  <section class="card warning">
    <h2>What is wrong in the current mental model?</h2>
    <p>The current production score answers: "How good is this model, adjusted downward by how much evidence we have?" That is a confidence-adjusted leaderboard, not a pure capability leaderboard.</p>
    <div class="formula">Current: model score = weighted mean(model scores) x sqrt(model accumulated bench weight / max accumulated bench weight)</div>
    <p>That final multiplier is the reason <strong>Claude Fable 5 (xhigh)</strong> gets pushed down: it has a very strong DeepSWE score but only one contributing benchmark, so its confidence multiplier is about ${pct((findRank(current, "claude-fable-5-xhigh")?.confidence ?? 0) * 100, 0)}% in production.</p>
  </section>

  <section class="card">
    <h2>Tracked Model Ranks Across Variants</h2>
    <table>
      <thead><tr><th>Model</th>${variants.map((v) => `<th>${htmlEscape(v.key)}</th>`).join("")}</tr></thead>
      <tbody>${trackedHtml}</tbody>
    </table>
  </section>

  ${variants.map((v) => variantCardHtml(v.name, v.config, computed.get(v.key), v.note)).join("\n")}

  <section class="card">
    <h2>DeepSWE vs SWE-Bench Pro</h2>
    <p>DeepSWE is not below old SWE-bench Verified. It is below <strong>SWE-Bench Pro</strong> in the current Bench Weight ranking because both have the same manual ratings, but SWE-Bench Pro has more model coverage and more headroom.</p>
    <h3>Current benchmark damping</h3>
    <table>
      <thead><tr><th>Bench</th><th>Quality</th><th>Raw QDH</th><th>Displayed Weight</th><th>Headroom</th><th>Frontier Mean</th><th>Models</th></tr></thead>
      <tbody>${benchRowsHtml(benchCompareCurrent)}</tbody>
    </table>
    <h3>With softened benchmark coverage damping</h3>
    <table>
      <thead><tr><th>Bench</th><th>Quality</th><th>Raw QDH</th><th>Displayed Weight</th><th>Headroom</th><th>Frontier Mean</th><th>Models</th></tr></thead>
      <tbody>${benchRowsHtml(benchCompareSoft)}</tbody>
    </table>
    <p>My take: DeepSWE should be visibly promoted as a high-quality modern coding-agent benchmark, but forcing it above SWE-Bench Pro in the weight formula is not obviously correct from the current data. It has fewer models and its frontier is already higher. The bigger bug is the label: this table is a <em>weight/contribution</em> ranking, not a pure "quality" ranking.</p>
  </section>

  <section class="card">
    <h2>Implementation Options</h2>
    <table>
      <thead><tr><th>Option</th><th>Change</th><th>Upside</th><th>Risk</th><th>My recommendation</th></tr></thead>
      <tbody>
        <tr><td>Keep current</td><td>No formula change</td><td>Defensive against sparse rows</td><td>Headline score contradicts intuition about ability; new frontier models rank too low</td><td class="bad">No, unless renamed to ConfidenceScore</td></tr>
        <tr><td>Split Ability + Evidence</td><td>Rank by ability mean after an evidence gate; display evidence separately</td><td>Most honest semantics; Fable can surface while evidence remains transparent</td><td>Requires UI/schema/API updates</td><td class="good">Best</td></tr>
        <tr><td>Soft final multiplier</td><td>Replace <code>sqrt(W/W*)</code> with a floored multiplier</td><td>Small code change</td><td>Still lets one-benchmark saturated rows dominate unless the floor is very low</td><td class="bad">Not enough by itself</td></tr>
        <tr><td>Minimum evidence gate</td><td>Rank by ability only after 3 benches or intrinsic weight ≥ 140</td><td>Produces the intuitive frontier order while avoiding one-bench #1 rows</td><td>Threshold needs to be shown clearly as "provisional"</td><td class="good">Best launch patch</td></tr>
      </tbody>
    </table>
  </section>
</main>
</body>
</html>`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html, "utf8");

console.log(`Wrote ${OUT}`);
console.log("\nTop 8 by variant:");
for (const v of variants) {
  console.log(`\n${v.key}`);
  for (const [i, r] of computed.get(v.key).rows.slice(0, 8).entries()) {
    console.log(`${String(i + 1).padStart(2)} ${r.model.name.padEnd(48)} score=${pct(r.score, 1)} mean=${pct(r.weightedMean, 1)} conf=${pct(r.confidence * 100, 0)} benches=${r.benchCount}`);
  }
}
