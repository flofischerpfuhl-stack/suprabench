const MIDPOINT = 50;

export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mean(values) {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}

function normalCdf(value) {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

const EFFORT_SUFFIXES = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "default",
  "thinking",
  "pro thinking",
  "thinking high",
  "high reasoning",
  "adaptive max",
  "adaptive xhigh",
  "adaptive max/fallback",
  "non-reasoning, high",
]);

/**
 * Infer a product-family boundary conservatively. Only execution/reasoning
 * suffixes in parentheses are removed. Product tiers (Sol, Terra, Luna,
 * Opus, Fable, Sonnet, Pro, Flash, Mini, Max) and release versions remain.
 */
export function inferFamilyTag(name) {
  const trimmed = name.trim();
  const match = trimmed.match(/\s+\(([^()]*)\)$/);
  if (!match || !EFFORT_SUFFIXES.has(match[1].trim().toLowerCase())) return trimmed;
  return trimmed.slice(0, match.index).trim();
}

function validVisibleSnapshot(snapshot) {
  const models = snapshot.models.filter((model) => !model.hidden);
  const benches = snapshot.benches.filter((bench) => !bench.hidden);
  const modelIds = new Set(models.map((model) => String(model._id)));
  const benchIds = new Set(benches.map((bench) => String(bench._id)));
  const scores = snapshot.scores.filter(
    (score) =>
      score.upvotes > score.downvotes &&
      modelIds.has(String(score.modelId)) &&
      benchIds.has(String(score.benchId)),
  );
  return { models, benches, scores };
}

function perModelBenchMedians(models, benches, scores) {
  const values = new Map();
  for (const score of scores) {
    const key = `${score.modelId}\u0000${score.benchId}`;
    const row = values.get(key) ?? [];
    row.push(score.normalizedScore);
    values.set(key, row);
  }

  const byModel = new Map(models.map((model) => [String(model._id), new Map()]));
  const byBench = new Map(benches.map((bench) => [String(bench._id), new Map()]));
  for (const [key, rawValues] of values) {
    const [modelId, benchId] = key.split("\u0000");
    const value = median(rawValues);
    byModel.get(modelId)?.set(benchId, value);
    byBench.get(benchId)?.set(modelId, value);
  }
  return { byModel, byBench };
}

function percentileMap(perModel) {
  const groups = new Map();
  for (const [modelId, value] of perModel) {
    const group = groups.get(value) ?? [];
    group.push(modelId);
    groups.set(value, group);
  }
  const sorted = [...groups.entries()].sort(([left], [right]) => left - right);
  const total = perModel.size;
  const output = new Map();
  let below = 0;
  for (const [, modelIds] of sorted) {
    const midrank = below + (modelIds.length + 1) / 2;
    const percentile = total <= 1 ? MIDPOINT : (100 * (midrank - 0.5)) / total;
    for (const modelId of modelIds) output.set(modelId, percentile);
    below += modelIds.length;
  }
  return output;
}

function robustZMap(perModel) {
  const values = [...perModel.values()];
  const center = median(values);
  let scale = 1.4826 * median(values.map((value) => Math.abs(value - center)));
  if (scale < 1e-9) {
    const variance = mean(values.map((value) => (value - center) ** 2));
    scale = Math.sqrt(variance);
  }
  if (scale < 1e-9) {
    return new Map([...perModel.keys()].map((modelId) => [modelId, MIDPOINT]));
  }
  return new Map(
    [...perModel].map(([modelId, value]) => {
      const z = clamp((value - center) / scale, -3, 3);
      return [modelId, 100 * normalCdf(z)];
    }),
  );
}

function calibrateByBench(byBench, mode) {
  const calibratedByBench = new Map();
  for (const [benchId, perModel] of byBench) {
    if (mode === "raw") calibratedByBench.set(benchId, new Map(perModel));
    else if (mode === "percentile") calibratedByBench.set(benchId, percentileMap(perModel));
    else if (mode === "robust-z") calibratedByBench.set(benchId, robustZMap(perModel));
    else throw new Error(`Unknown scoreTransform: ${mode}`);
  }

  const calibratedByModel = new Map();
  for (const [benchId, perModel] of calibratedByBench) {
    for (const [modelId, value] of perModel) {
      const row = calibratedByModel.get(modelId) ?? new Map();
      row.set(benchId, value);
      calibratedByModel.set(modelId, row);
    }
  }
  return { byBench: calibratedByBench, byModel: calibratedByModel };
}

function shrinkDimension(value, raterCount, priorRaters) {
  const observed = raterCount > 0 && Number.isFinite(value) ? value : 3;
  return (observed * raterCount + 3 * priorRaters) / (raterCount + priorRaters);
}

function benchBaseWeight(bench, scenario) {
  const headroom = Number.isFinite(bench.cachedHeadroom) ? bench.cachedHeadroom : 1;
  if (scenario.ratingMode === "current") {
    return Number.isFinite(bench.cachedEffectiveWeight)
      ? bench.cachedEffectiveWeight
      : 0;
  }
  if (scenario.ratingMode === "equal") return 1;
  if (scenario.ratingMode === "neutral") return 50 * 0.5 * headroom;
  if (scenario.ratingMode !== "bayesian") {
    throw new Error(`Unknown ratingMode: ${scenario.ratingMode}`);
  }

  const dims = bench.cachedDimensions ?? {};
  const raterCount = Number.isFinite(bench.cachedRaterCount)
    ? bench.cachedRaterCount
    : 0;
  const priorRaters = scenario.priorRaters ?? 3;
  const trustDimensions = [
    "relevance",
    "contamination",
    "discriminability",
    "reproducibility",
  ].map((key) => shrinkDimension(dims[key], raterCount, priorRaters));
  const difficultyDimension = shrinkDimension(
    dims.difficulty,
    raterCount,
    priorRaters,
  );
  const quality = mean(trustDimensions) * 20;
  const difficulty = clamp((difficultyDimension - 1) / 4, 0, 1);
  return quality * difficulty * headroom;
}

function buildBenchInfo(benches, scenario) {
  const upvoteMax = Math.max(
    0,
    ...benches.map((bench) => bench.cachedNetUpvotes ?? 1),
  );
  const modelCountMax = Math.max(
    0,
    ...benches.map((bench) => bench.cachedModelCount ?? 0),
  );
  const output = new Map();
  for (const bench of benches) {
    const base = benchBaseWeight(bench, scenario);
    const upvotes = bench.cachedNetUpvotes ?? 1;
    const trust =
      scenario.trustMode === "equal"
        ? 1
        : upvoteMax > 0
          ? clamp(upvotes / upvoteMax, 0, 1)
          : 1;
    const coverage =
      modelCountMax > 0
        ? clamp((bench.cachedModelCount ?? 0) / modelCountMax, 0, 1)
        : 1;
    output.set(String(bench._id), {
      ability: base * trust,
      evidence: base * trust * Math.sqrt(coverage),
      base,
      trust,
      coverage,
    });
  }
  return output;
}

function aggregate(perBench, benchInfo) {
  let weightedSum = 0;
  let abilityWeight = 0;
  let evidenceWeight = 0;
  let benchCount = 0;
  for (const [benchId, score] of perBench) {
    const info = benchInfo.get(benchId);
    if (!info || info.ability <= 0) continue;
    weightedSum += score * info.ability;
    abilityWeight += info.ability;
    evidenceWeight += info.evidence;
    benchCount += 1;
  }
  return {
    weightedMean: abilityWeight > 0 ? weightedSum / abilityWeight : 0,
    abilityWeight,
    evidenceWeight,
    benchCount,
  };
}

function applyConfidence(aggregateRow, maxEvidence, mode) {
  const confidence =
    maxEvidence > 0
      ? Math.sqrt(clamp(aggregateRow.evidenceWeight / maxEvidence, 0, 1))
      : 0;
  const score =
    mode === "separate"
      ? aggregateRow.weightedMean
      : MIDPOINT + confidence * (aggregateRow.weightedMean - MIDPOINT);
  return { score, confidence };
}

function resolvedFamilyTag(model, scenario) {
  const override = scenario.familyOverrides?.[model.name];
  if (override) return override;
  if (scenario.taxonomyMode === "inferred") return inferFamilyTag(model.name);
  return model.familyTag?.trim() || null;
}

function buildFamilyAggregates(models, modelPerBench, modelRowsById, benchInfo, scenario) {
  const groups = new Map();
  for (const model of models) {
    const familyTag = resolvedFamilyTag(model, scenario);
    if (!familyTag) continue;
    const key = `${familyTag}\u0000${model.provider}`;
    const group = groups.get(key) ?? { familyTag, provider: model.provider, members: [] };
    group.members.push(model);
    groups.set(key, group);
  }

  const familyAggregates = [];
  for (const group of groups.values()) {
    if (scenario.familyAggregation === "best-config") {
      const candidates = group.members
        .map((model) => modelRowsById.get(String(model._id)))
        .filter(Boolean)
        .sort(
          (left, right) =>
            right.score - left.score ||
            right.confidence - left.confidence ||
            right.benchCount - left.benchCount,
        );
      const minBenchCount = scenario.representativeMinBenchCount ?? 0;
      const sufficientlyCovered = candidates.filter(
        (candidate) => candidate.benchCount >= minBenchCount,
      );
      const best = (sufficientlyCovered.length > 0 ? sufficientlyCovered : candidates)[0];
      familyAggregates.push({
        ...group,
        ...(best ?? { weightedMean: 0, abilityWeight: 0, evidenceWeight: 0, benchCount: 0 }),
        representative: best?.name ?? null,
        provisional: (best?.benchCount ?? 0) < minBenchCount,
        modelCount: group.members.length,
      });
      continue;
    }

    const benchValues = new Map();
    for (const model of group.members) {
      for (const [benchId, value] of modelPerBench.get(String(model._id)) ?? []) {
        const values = benchValues.get(benchId) ?? [];
        values.push(value);
        benchValues.set(benchId, values);
      }
    }
    const perBench = new Map();
    for (const [benchId, values] of benchValues) {
      const value =
        scenario.familyAggregation === "best-per-bench"
          ? Math.max(...values)
          : median(values);
      perBench.set(benchId, value);
    }
    familyAggregates.push({
      ...group,
      ...aggregate(perBench, benchInfo),
      representative: null,
      modelCount: group.members.length,
    });
  }
  return familyAggregates;
}

function assignRanks(rows, minBenchCount = 0) {
  const sorted = rows
    .map((row) => ({ ...row, eligible: row.benchCount >= minBenchCount }))
    .sort(
      (left, right) =>
        Number(right.eligible) - Number(left.eligible) ||
        right.score - left.score ||
        right.confidence - left.confidence ||
        right.benchCount - left.benchCount ||
        left.name.localeCompare(right.name),
    );
  let rank = 0;
  let provisionalRank = 0;
  return sorted.map((row) => {
    if (row.eligible) return { ...row, rank: ++rank, provisionalRank: null };
    return { ...row, rank: null, provisionalRank: ++provisionalRank };
  });
}

export function buildRanking(snapshot, inputScenario = {}) {
  const scenario = {
    name: "scenario",
    scoreTransform: "raw",
    ratingMode: "current",
    trustMode: "current",
    confidenceMode: "current",
    familyAggregation: "median-per-bench",
    taxonomyMode: "database",
    ...inputScenario,
  };
  const { models, benches, scores } = validVisibleSnapshot(snapshot);
  const raw = perModelBenchMedians(models, benches, scores);
  const calibrated = calibrateByBench(raw.byBench, scenario.scoreTransform);
  const benchInfo = buildBenchInfo(benches, scenario);

  const modelAggregates = models.map((model) => ({
    model,
    ...aggregate(calibrated.byModel.get(String(model._id)) ?? new Map(), benchInfo),
  }));
  const maxModelEvidence = Math.max(0, ...modelAggregates.map((row) => row.evidenceWeight));
  const modelRowsById = new Map();
  const modelRows = modelAggregates.map((row) => {
    const adjusted = applyConfidence(row, maxModelEvidence, scenario.confidenceMode);
    const output = {
      id: String(row.model._id),
      name: row.model.name,
      provider: row.model.provider,
      familyTag: resolvedFamilyTag(row.model, scenario),
      weightedMean: row.weightedMean,
      abilityWeight: row.abilityWeight,
      evidenceWeight: row.evidenceWeight,
      benchCount: row.benchCount,
      ...adjusted,
    };
    modelRowsById.set(output.id, output);
    return output;
  });

  const familyAggregates = buildFamilyAggregates(
    models,
    calibrated.byModel,
    modelRowsById,
    benchInfo,
    scenario,
  );
  const maxFamilyEvidence = Math.max(0, ...familyAggregates.map((row) => row.evidenceWeight));
  const familyRows = familyAggregates.map((row) => {
    const adjusted =
      scenario.familyAggregation === "best-config"
        ? { score: row.score, confidence: row.confidence }
        : applyConfidence(row, maxFamilyEvidence, scenario.confidenceMode);
    return {
      name: row.familyTag,
      familyTag: row.familyTag,
      provider: row.provider,
      representative: row.representative,
      provisional: row.provisional ?? false,
      modelCount: row.modelCount,
      weightedMean: row.weightedMean,
      abilityWeight: row.abilityWeight,
      evidenceWeight: row.evidenceWeight,
      benchCount: row.benchCount,
      ...adjusted,
    };
  });

  return {
    scenario,
    modelRanking: assignRanks(modelRows, scenario.minBenchCount ?? 0).map((row) => ({
      ...row,
      score: round(row.score),
      weightedMean: round(row.weightedMean),
      confidence: round(row.confidence, 3),
      abilityWeight: round(row.abilityWeight),
      evidenceWeight: round(row.evidenceWeight),
    })),
    familyRanking: assignRanks(familyRows, scenario.minBenchCount ?? 0).map((row) => ({
      ...row,
      score: round(row.score),
      weightedMean: round(row.weightedMean),
      confidence: round(row.confidence, 3),
      abilityWeight: round(row.abilityWeight),
      evidenceWeight: round(row.evidenceWeight),
    })),
    benchInfo: [...benchInfo].map(([benchId, info]) => ({ benchId, ...info })),
  };
}

export function compareTargetOrder(familyRanking, target) {
  const byName = new Map(familyRanking.map((row) => [row.familyTag, row]));
  let agreements = 0;
  let comparisons = 0;
  for (let left = 0; left < target.length; left++) {
    for (let right = left + 1; right < target.length; right++) {
      const a = byName.get(target[left]);
      const b = byName.get(target[right]);
      if (!a || !b) continue;
      comparisons += 1;
      if (Number.isFinite(a.rank) && Number.isFinite(b.rank) && a.rank < b.rank) agreements += 1;
    }
  }
  const targetSize = target.length;
  const cappedRankErrors = target.map((name, index) => {
    const row = byName.get(name);
    const cappedRank = row && Number.isFinite(row.rank)
      ? Math.min(row.rank, targetSize + 1)
      : targetSize + 1;
    return Math.abs(cappedRank - (index + 1));
  });
  const topKOverlap = target.filter((name) => {
    const row = byName.get(name);
    return row && Number.isFinite(row.rank) && row.rank <= targetSize;
  }).length;
  return {
    agreement: comparisons > 0 ? agreements / comparisons : 0,
    agreements,
    comparisons,
    topKOverlap,
    topKRecall: topKOverlap / targetSize,
    meanCappedRankError: mean(cappedRankErrors),
    missing: target.filter((name) => !byName.has(name)),
    rows: target.map((name) => byName.get(name) ?? { familyTag: name, rank: null }),
  };
}

export function auditFamilyTags(snapshot, overrides = {}) {
  return snapshot.models
    .filter((model) => !model.hidden)
    .map((model) => {
      const inferred = overrides[model.name] ?? inferFamilyTag(model.name);
      return {
        name: model.name,
        provider: model.provider,
        current: model.familyTag ?? null,
        inferred,
        differs: (model.familyTag ?? null) !== inferred,
      };
    });
}

export function describeBenchRatings(snapshot) {
  const benches = snapshot.benches.filter((bench) => !bench.hidden);
  const raterCounts = benches.map((bench) => bench.cachedRaterCount ?? 0);
  const upvotes = benches.map((bench) => bench.cachedNetUpvotes ?? 1);
  return {
    benchCount: benches.length,
    raterCounts: Object.fromEntries(
      [...new Set(raterCounts)].sort((a, b) => a - b).map((count) => [count, raterCounts.filter((v) => v === count).length]),
    ),
    netUpvotes: Object.fromEntries(
      [...new Set(upvotes)].sort((a, b) => a - b).map((count) => [count, upvotes.filter((v) => v === count).length]),
    ),
  };
}
