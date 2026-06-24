/* ════════════════════════════════════════════════════════════
 * SIMULATED SUPRASCORE — client-side math.
 *
 * Pure-functional port of convex/rankings.ts (effectiveBenchWeight,
 * evidenceBenchWeight, weighted-mean aggregate, evidence-confidence
 * SupraScore). Lives
 * in the browser so the simulator can render a hypothetical
 * leaderboard without any DB writes — see the Architecture comment
 * in convex/simulator.ts.
 *
 * Every function here is intentionally `const` and side-effect-free.
 * Inputs are plain JS objects matching the shape of the snapshot
 * returned by `simulator.fetchSnapshot`. Outputs are plain arrays
 * and objects — Alpine.js binds them directly.
 *
 * IMPORTANT: when convex/rankings.ts changes (new shrinkage factor,
 * different median definition, etc.), this file MUST be updated to
 * match. The two are kept in sync by convention; if we ever notice
 * drift we'll add a generated golden-vector test on both sides.
 *
 * Constants mirror the consts in convex/rankings.ts; please keep
 * them in lock-step with that file.
 * ════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  const HEADROOM_TOP_K = 10;
  const HEADROOM_MIN_N = 3;
  const HEADROOM_FLOOR = 0.1;
  const HEADROOM_PIVOT = 50;
  const NORMALIZED_SCORE_MIDPOINT = 50;

  // Median of an unsorted numeric array. Mutates the array (sorts
  // in place) — caller passes throw-away copies.
  function median(arr) {
    if (arr.length === 0) return 0;
    arr.sort((a, b) => a - b);
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
  }

  // Per-bench {modelId → [scores]} pivot, then per-model median per
  // bench. Excludes hidden models (hiddenModelIds is a Set).
  function buildPerBenchModelMedians(scores, hiddenModelIds) {
    /** @type {Map<string, Map<string, number[]>>} */
    const out = new Map();
    for (const s of scores) {
      const mid = String(s.modelId);
      if (hiddenModelIds.has(mid)) continue;
      const bid = String(s.benchId);
      let benchMap = out.get(bid);
      if (!benchMap) {
        benchMap = new Map();
        out.set(bid, benchMap);
      }
      let arr = benchMap.get(mid);
      if (!arr) {
        arr = [];
        benchMap.set(mid, arr);
      }
      arr.push(s.normalizedScore);
    }
    /** @type {Map<string, Map<string, number>>} */
    const medians = new Map();
    for (const [bid, perModel] of out) {
      const reduced = new Map();
      for (const [mid, vals] of perModel) {
        reduced.set(mid, median(vals.slice()));
      }
      medians.set(bid, reduced);
    }
    return medians;
  }

  // Recompute a bench's headroom + effective weight, given the
  // current per-model medians on that bench. Quality and difficulty
  // come straight from the cached numbers (the simulator never
  // touches bench ratings — partners can't rate their own
  // hypothetical bench, and adding a model doesn't change Q or D).
  function recomputeBenchWeight(bench, perModelMedians) {
    const quality =
      typeof bench.cachedQualityScore === "number" ? bench.cachedQualityScore : 50;
    const difficulty =
      typeof bench.cachedDifficultyMultiplier === "number"
        ? bench.cachedDifficultyMultiplier
        : 0.5; // matches the (3-1)/4 default in rankings.ts

    // Top-K frontier-mean of per-model medians.
    const sortedMedians = Array.from(perModelMedians.values()).sort(
      (a, b) => b - a
    );
    const N = sortedMedians.length;
    const K = Math.min(HEADROOM_TOP_K, N);
    const frontierMean =
      K === 0 ? 0 : sortedMedians.slice(0, K).reduce((s, v) => s + v, 0) / K;

    let headroom;
    if (N < HEADROOM_MIN_N) {
      headroom = 1.0;
    } else {
      const pivoted = Math.max(frontierMean, HEADROOM_PIVOT);
      headroom = Math.max(
        HEADROOM_FLOOR,
        (100 - pivoted) / (100 - HEADROOM_PIVOT)
      );
    }
    return {
      quality,
      difficulty,
      headroom,
      modelCount: N,
      frontierMean,
      weight: quality * difficulty * headroom,
    };
  }

  // Per-bench u_b/U* trust multiplier applied to raw
  // Q·D·H weight. Exact mirror of effectiveBenchWeight in
  // convex/rankings.ts (down to the bootstrap behaviour).
  function effectiveBenchWeight(rawWeight, upvotes, upvoteMax, modelCount, modelCountMax) {
    const uShare =
      upvoteMax > 0 ? Math.min(1, Math.max(0, upvotes) / upvoteMax) : 1;
    void modelCount;
    void modelCountMax;
    return rawWeight * uShare;
  }

  // Confidence/evidence keeps user trust and then folds in benchmark
  // model-count breadth. This is NOT used as the central ability
  // weight; it only controls how far the final score moves away from
  // the neutral midpoint.
  function evidenceBenchWeight(rawWeight, upvotes, upvoteMax, modelCount, modelCountMax) {
    const nShare =
      modelCountMax > 0
        ? Math.min(1, Math.max(0, modelCount) / modelCountMax)
        : 1;
    return (
      effectiveBenchWeight(rawWeight, upvotes, upvoteMax, modelCount, modelCountMax) *
      Math.sqrt(nShare)
    );
  }

  function confidenceAdjustedSupraScore(weightedMean, evidenceWeight, maxEvidenceWeight) {
    if (evidenceWeight <= 0 || maxEvidenceWeight <= 0) return 0;
    const share = Math.min(1, evidenceWeight / maxEvidenceWeight);
    const confidence = Math.sqrt(share);
    return NORMALIZED_SCORE_MIDPOINT + confidence * (weightedMean - NORMALIZED_SCORE_MIDPOINT);
  }

  // Aggregate {weightedMean, totalWeight/evidenceWeight, benchCount} for ONE
  // model. `perBenchMedianForModel` is a Map<benchId, score>.
  // `benchInfo` is a Map<benchId, {effective: number, evidence: number}>.
  function computeModelAggregate(perBenchMedianForModel, benchInfo) {
    let weightedSum = 0;
    let abilityWeightTotal = 0;
    let evidenceWeightTotal = 0;
    let benchCount = 0;
    for (const [bid, m] of perBenchMedianForModel) {
      const info = benchInfo.get(bid);
      if (!info || info.effective <= 0) continue;
      weightedSum += info.effective * m;
      abilityWeightTotal += info.effective;
      evidenceWeightTotal += info.evidence;
      benchCount += 1;
    }
    return {
      weightedMean:
        abilityWeightTotal > 0 ? weightedSum / abilityWeightTotal : 0,
      abilityWeight: abilityWeightTotal,
      totalWeight: evidenceWeightTotal,
      benchCount,
    };
  }

  /**
   * Re-rank the ENTIRE leaderboard with one hypothetical extra
   * model bolted in. Returns {liveRanking, simulatedRanking,
   * affectedBenches, simulatedRow}.
   *
   * @param {object} snapshot     - Output of simulator.fetchSnapshot.
   * @param {object} simInput     - { name, provider, scores: [{benchId, score}] }
   *
   * Returns:
   *   {
   *     liveRanking:      [{ modelId, name, provider, supraScore, rank }, ...]
   *     simulatedRanking: [{ modelId|null, name, provider, supraScore, rank,
   *                          isSimulated, deltaScore?, deltaRank? }, ...]
   *     simulatedRow:     ditto, but always the row representing the
   *                       simulated model, surfaced for convenience
   *     benchDeltas:      [{ benchId, slug, name,
   *                          weightLive, weightSimulated,
   *                          modelCountLive, modelCountSimulated,
   *                          frontierMeanLive, frontierMeanSimulated }, ...]
   *                       — only benches the simulator actually changed
   *   }
   */
  function simulateRanking(snapshot, simInput) {
    const benches = snapshot.benches;
    const models = snapshot.models;
    const scores = snapshot.scores;
    const benchById = new Map(benches.map((b) => [String(b._id), b]));

    const visibleBenchIds = new Set(
      benches.filter((b) => !b.hidden).map((b) => String(b._id))
    );
    const hiddenModelIds = new Set(); // snapshot already excludes hidden models

    // === LIVE BASELINE PASS =================================
    // Build per-bench per-model median, then bench weights, then
    // per-model aggregates, then evidence-adjusted SupraScore. Mirrors
    // recomputeAllUnifiedImpl in convex/rankings.ts.
    const perBenchMediansLive = buildPerBenchModelMedians(scores, hiddenModelIds);

    /** @type {Map<string, {effective: number, evidence: number, weight: number, modelCount: number, frontierMean: number, headroom: number}>} */
    const benchInfoLive = new Map();
    let upvoteMaxLive = 0;
    let modelCountMaxLive = 0;
    for (const b of benches) {
      const bid = String(b._id);
      const perModel = perBenchMediansLive.get(bid) ?? new Map();
      const w = recomputeBenchWeight(b, perModel);
      benchInfoLive.set(bid, w);
      if (visibleBenchIds.has(bid)) {
        const u = typeof b.cachedNetUpvotes === "number" ? b.cachedNetUpvotes : 1;
        if (u > upvoteMaxLive) upvoteMaxLive = u;
        if (w.modelCount > modelCountMaxLive) modelCountMaxLive = w.modelCount;
      }
    }
    for (const [bid, info] of benchInfoLive) {
      const b = benchById.get(bid);
      const u = typeof b.cachedNetUpvotes === "number" ? b.cachedNetUpvotes : 1;
      info.effective = effectiveBenchWeight(
        info.weight,
        u,
        upvoteMaxLive,
        info.modelCount,
        modelCountMaxLive
      );
      info.evidence = evidenceBenchWeight(
        info.weight,
        u,
        upvoteMaxLive,
        info.modelCount,
        modelCountMaxLive
      );
    }

    // Per-model aggregate using live bench weights.
    /** @type {Map<string, {weightedMean: number, abilityWeight: number, totalWeight: number, benchCount: number}>} */
    const aggsLive = new Map();
    let maxEvidenceWeightLive = 0;
    for (const m of models) {
      const mid = String(m._id);
      // collect this model's per-bench medians from the pivot
      const perBenchForModel = new Map();
      for (const [bid, perModel] of perBenchMediansLive) {
        const med = perModel.get(mid);
        if (med !== undefined) perBenchForModel.set(bid, med);
      }
      const agg = computeModelAggregate(perBenchForModel, benchInfoLive);
      aggsLive.set(mid, agg);
      if (agg.totalWeight > maxEvidenceWeightLive) {
        maxEvidenceWeightLive = agg.totalWeight;
      }
    }

    const liveRanking = models
      .map((m) => {
        const mid = String(m._id);
        const a = aggsLive.get(mid);
        const supraScore = confidenceAdjustedSupraScore(
          a.weightedMean,
          a.totalWeight,
          maxEvidenceWeightLive
        );
        return {
          modelId: mid,
          name: m.name,
          provider: m.provider,
          familyTag: m.familyTag,
          supraScore: Math.round(supraScore * 10) / 10,
          benchCount: a.benchCount,
          isSimulated: false,
        };
      })
      .sort((a, b) => b.supraScore - a.supraScore)
      .map((row, i) => ({ ...row, rank: i + 1 }));

    // === SIMULATED PASS =====================================
    // Inject the hypothetical model into the per-bench pivot, then
    // re-derive bench weights for benches it touched, then fully
    // re-aggregate every model (because U*, N*, E* all potentially
    // shift). Same algorithm as live, just with one extra row.
    const simulatedModelKey = "__sim__";
    const affectedBenchIds = new Set(simInput.scores.map((s) => String(s.benchId)));

    const perBenchMediansSim = new Map();
    for (const [bid, perModel] of perBenchMediansLive) {
      perBenchMediansSim.set(bid, new Map(perModel));
    }
    for (const s of simInput.scores) {
      const bid = String(s.benchId);
      let pm = perBenchMediansSim.get(bid);
      if (!pm) {
        pm = new Map();
        perBenchMediansSim.set(bid, pm);
      }
      pm.set(simulatedModelKey, s.score);
    }

    /** @type {Map<string, {effective: number, evidence: number, weight: number, modelCount: number, frontierMean: number, headroom: number}>} */
    const benchInfoSim = new Map();
    let upvoteMaxSim = 0;
    let modelCountMaxSim = 0;
    for (const b of benches) {
      const bid = String(b._id);
      const perModel = perBenchMediansSim.get(bid) ?? new Map();
      const w = recomputeBenchWeight(b, perModel);
      benchInfoSim.set(bid, w);
      if (visibleBenchIds.has(bid)) {
        const u = typeof b.cachedNetUpvotes === "number" ? b.cachedNetUpvotes : 1;
        if (u > upvoteMaxSim) upvoteMaxSim = u;
        if (w.modelCount > modelCountMaxSim) modelCountMaxSim = w.modelCount;
      }
    }
    for (const [bid, info] of benchInfoSim) {
      const b = benchById.get(bid);
      const u = typeof b.cachedNetUpvotes === "number" ? b.cachedNetUpvotes : 1;
      info.effective = effectiveBenchWeight(
        info.weight,
        u,
        upvoteMaxSim,
        info.modelCount,
        modelCountMaxSim
      );
      info.evidence = evidenceBenchWeight(
        info.weight,
        u,
        upvoteMaxSim,
        info.modelCount,
        modelCountMaxSim
      );
    }

    // Aggregate every existing model + the simulated one.
    const aggsSim = new Map();
    let maxEvidenceWeightSim = 0;
    for (const m of models) {
      const mid = String(m._id);
      const perBenchForModel = new Map();
      for (const [bid, perModel] of perBenchMediansSim) {
        const med = perModel.get(mid);
        if (med !== undefined) perBenchForModel.set(bid, med);
      }
      const agg = computeModelAggregate(perBenchForModel, benchInfoSim);
      aggsSim.set(mid, agg);
      if (agg.totalWeight > maxEvidenceWeightSim) {
        maxEvidenceWeightSim = agg.totalWeight;
      }
    }
    {
      const perBenchForSim = new Map();
      for (const s of simInput.scores) {
        perBenchForSim.set(String(s.benchId), s.score);
      }
      const agg = computeModelAggregate(perBenchForSim, benchInfoSim);
      aggsSim.set(simulatedModelKey, agg);
      if (agg.totalWeight > maxEvidenceWeightSim) {
        maxEvidenceWeightSim = agg.totalWeight;
      }
    }

    const liveByModelId = new Map(liveRanking.map((r) => [r.modelId, r]));
    const simulatedRanking = [];
    for (const m of models) {
      const mid = String(m._id);
      const a = aggsSim.get(mid);
      const supraScore =
        Math.round(
          confidenceAdjustedSupraScore(
            a.weightedMean,
            a.totalWeight,
            maxEvidenceWeightSim
          ) * 10
        ) / 10;
      simulatedRanking.push({
        modelId: mid,
        name: m.name,
        provider: m.provider,
        familyTag: m.familyTag,
        supraScore,
        benchCount: a.benchCount,
        isSimulated: false,
      });
    }
    {
      const a = aggsSim.get(simulatedModelKey);
      const supraScore =
        Math.round(
          confidenceAdjustedSupraScore(
            a.weightedMean,
            a.totalWeight,
            maxEvidenceWeightSim
          ) * 10
        ) / 10;
      simulatedRanking.push({
        modelId: null,
        name: simInput.name,
        provider: simInput.provider,
        familyTag: null,
        supraScore,
        benchCount: a.benchCount,
        isSimulated: true,
      });
    }
    simulatedRanking.sort((a, b) => b.supraScore - a.supraScore);
    simulatedRanking.forEach((r, i) => {
      r.rank = i + 1;
      if (!r.isSimulated) {
        const live = liveByModelId.get(r.modelId);
        if (live) {
          r.deltaScore = Math.round((r.supraScore - live.supraScore) * 10) / 10;
          r.deltaRank = live.rank - r.rank; // positive = moved up
        }
      }
    });
    const simulatedRow = simulatedRanking.find((r) => r.isSimulated);

    // === BENCH-LEVEL DELTAS =================================
    // Anything the simulated model touched might have shifted (the
    // ranker recomputes top-K frontier mean every time) — surface
    // the per-bench impact for the "frontier-buster" warning UX.
    const benchDeltas = [];
    for (const bid of affectedBenchIds) {
      const live = benchInfoLive.get(bid);
      const sim = benchInfoSim.get(bid);
      const b = benchById.get(bid);
      if (!live || !sim || !b) continue;
      benchDeltas.push({
        benchId: bid,
        slug: b.slug,
        name: b.name,
        weightLive: Math.round(live.effective * 100) / 100,
        weightSimulated: Math.round(sim.effective * 100) / 100,
        modelCountLive: live.modelCount,
        modelCountSimulated: sim.modelCount,
        frontierMeanLive: Math.round(live.frontierMean * 10) / 10,
        frontierMeanSimulated: Math.round(sim.frontierMean * 10) / 10,
        weightDelta:
          Math.round((sim.effective - live.effective) * 100) / 100,
      });
    }

    return {
      liveRanking,
      simulatedRanking,
      simulatedRow,
      benchDeltas,
      // Stats useful for the result-card header.
      stats: {
        modelsConsidered: models.length + 1,
        benchesSimulated: simInput.scores.length,
        upvoteMaxShifted: upvoteMaxSim !== upvoteMaxLive,
        modelCountMaxShifted: modelCountMaxSim !== modelCountMaxLive,
      },
    };
  }

  window.SupraSimulator = {
    simulateRanking,
    // Exposed for unit testing.
    _internal: {
      median,
      recomputeBenchWeight,
      effectiveBenchWeight,
      evidenceBenchWeight,
      confidenceAdjustedSupraScore,
      computeModelAggregate,
      buildPerBenchModelMedians,
      HEADROOM_TOP_K,
      HEADROOM_MIN_N,
      HEADROOM_FLOOR,
      HEADROOM_PIVOT,
      NORMALIZED_SCORE_MIDPOINT,
    },
  };
})();
