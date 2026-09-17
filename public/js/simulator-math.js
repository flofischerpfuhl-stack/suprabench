/* ════════════════════════════════════════════════════════════
 * SIMULATED SUPRASCORE — client-side what-if.
 *
 * The ranking math is NOT duplicated here. This file only bolts a
 * hypothetical model onto the snapshot, re-derives the saturation
 * headroom of the benches it touches (a new frontier result can
 * change H), and hands both the live and the simulated dataset to
 * the shared core in js/supra-rank-core.js — the very same file the
 * production rebuild in convex/rankings.ts runs.
 *
 * Inputs are plain JS objects matching `simulator.fetchSnapshot`.
 * Outputs are plain arrays/objects — Alpine.js binds them directly.
 * ════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  const HEADROOM_TOP_K = 10;
  const HEADROOM_MIN_N = 3;
  const HEADROOM_FLOOR = 0.1;
  const HEADROOM_PIVOT = 50;

  function core() {
    const c = window.SupraRankCore;
    if (!c) throw new Error("ranking core not loaded");
    return c;
  }

  // benchId → Map(modelId → median of that model's scores on the bench)
  function buildPerBenchModelMedians(scores) {
    const grouped = new Map();
    for (const s of scores) {
      const bid = String(s.benchId);
      const mid = String(s.modelId);
      let perModel = grouped.get(bid);
      if (!perModel) { perModel = new Map(); grouped.set(bid, perModel); }
      let arr = perModel.get(mid);
      if (!arr) { arr = []; perModel.set(mid, arr); }
      arr.push(s.normalizedScore);
    }
    const medians = new Map();
    for (const [bid, perModel] of grouped) {
      const reduced = new Map();
      for (const [mid, vals] of perModel) reduced.set(mid, core().median(vals));
      medians.set(bid, reduced);
    }
    return medians;
  }

  // Same top-K frontier-mean headroom rule as convex/rankings.ts.
  function headroomFor(perModelMedians) {
    const sorted = Array.from(perModelMedians.values()).sort((a, b) => b - a);
    const N = sorted.length;
    const K = Math.min(HEADROOM_TOP_K, N);
    const frontierMean = K === 0 ? 0 : sorted.slice(0, K).reduce((s, v) => s + v, 0) / K;
    const headroom =
      N < HEADROOM_MIN_N
        ? 1.0
        : Math.max(HEADROOM_FLOOR, (100 - Math.max(frontierMean, HEADROOM_PIVOT)) / (100 - HEADROOM_PIVOT));
    return { headroom, frontierMean, modelCount: N };
  }

  function toRanking(models, result, extraRow) {
    const byModel = new Map(result.configs.map((c) => [c.modelId, c]));
    const rows = models.map((m) => {
      const c = byModel.get(String(m._id));
      return {
        modelId: String(m._id),
        name: m.name,
        provider: m.provider,
        familyTag: m.familyTag,
        supraScore: c ? c.supraScore : 0,
        ability: c && c.ability !== null ? c.ability : -Infinity,
        benchCount: c ? c.benchCount : 0,
        isSimulated: false,
      };
    });
    if (extraRow) rows.push(extraRow);
    rows.sort((a, b) => b.ability - a.ability || b.supraScore - a.supraScore);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
  }

  /**
   * Re-rank the entire leaderboard with one hypothetical extra model.
   *
   * @param {object} snapshot  output of simulator.fetchSnapshot
   * @param {object} simInput  { name, provider, scores: [{benchId, score}] }
   * @returns {liveRanking, simulatedRanking, simulatedRow, benchDeltas, stats}
   */
  function simulateRanking(snapshot, simInput) {
    const benches = snapshot.benches.filter((b) => !b.hidden);
    const models = snapshot.models;
    const scores = snapshot.scores;
    const SIM_ID = "__sim__";

    // ── live pass ──
    const live = core().rank({ models, benches, scores });
    const liveRanking = toRanking(models, live, null);

    // ── simulated pass ──
    const simScores = scores.concat(
      simInput.scores.map((s) => ({ modelId: SIM_ID, benchId: String(s.benchId), normalizedScore: s.score }))
    );
    const affected = new Set(simInput.scores.map((s) => String(s.benchId)));
    const mediansLive = buildPerBenchModelMedians(scores);
    const mediansSim = buildPerBenchModelMedians(simScores);
    const benchDeltas = [];
    const simBenches = benches.map((b) => {
      const bid = String(b._id);
      if (!affected.has(bid)) return b;
      const before = headroomFor(mediansLive.get(bid) || new Map());
      const after = headroomFor(mediansSim.get(bid) || new Map());
      const weightLive = core().benchWeight(Object.assign({}, b, { cachedHeadroom: before.headroom }), live.upvoteMax);
      const weightSimulated = core().benchWeight(Object.assign({}, b, { cachedHeadroom: after.headroom }), live.upvoteMax);
      benchDeltas.push({
        benchId: bid,
        slug: b.slug,
        name: b.name,
        weightLive: Math.round(weightLive * 100) / 100,
        weightSimulated: Math.round(weightSimulated * 100) / 100,
        modelCountLive: before.modelCount,
        modelCountSimulated: after.modelCount,
        frontierMeanLive: Math.round(before.frontierMean * 10) / 10,
        frontierMeanSimulated: Math.round(after.frontierMean * 10) / 10,
        weightDelta: Math.round((weightSimulated - weightLive) * 100) / 100,
      });
      return Object.assign({}, b, { cachedHeadroom: after.headroom });
    });
    const simModels = models.concat([
      { _id: SIM_ID, name: simInput.name, provider: simInput.provider, slug: SIM_ID, familyTag: null, tags: [] },
    ]);
    const sim = core().rank({ models: simModels, benches: simBenches, scores: simScores });
    const simConfig = sim.configs.find((c) => c.modelId === SIM_ID);
    const simulatedRow = {
      modelId: null,
      name: simInput.name,
      provider: simInput.provider,
      familyTag: null,
      supraScore: simConfig ? simConfig.supraScore : 0,
      ability: simConfig && simConfig.ability !== null ? simConfig.ability : -Infinity,
      benchCount: simConfig ? simConfig.benchCount : 0,
      isSimulated: true,
    };
    const simulatedRanking = toRanking(models, sim, simulatedRow);
    const liveByModel = new Map(liveRanking.map((r) => [r.modelId, r]));
    for (const r of simulatedRanking) {
      if (r.isSimulated) continue;
      const before = liveByModel.get(r.modelId);
      if (!before) continue;
      r.deltaScore = Math.round((r.supraScore - before.supraScore) * 10) / 10;
      r.deltaRank = before.rank - r.rank; // positive = moved up
    }

    return {
      liveRanking,
      simulatedRanking,
      simulatedRow,
      benchDeltas,
      stats: {
        modelsConsidered: models.length + 1,
        benchesSimulated: simInput.scores.length,
        upvoteMaxShifted: false,
        modelCountMaxShifted: false,
      },
    };
  }

  window.SupraSimulator = {
    simulateRanking,
    _internal: { buildPerBenchModelMedians, headroomFor },
  };
})();
