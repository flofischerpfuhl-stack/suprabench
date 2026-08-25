import { buildRanking, inferFamilyTag, median } from "./ranking-lab-core.mjs";

const EPSILON = 1e-12;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sigmoid(value) {
  const bounded = clamp(value, -30, 30);
  return 1 / (1 + Math.exp(-bounded));
}

function mean(values) {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function weightedMean(rows, valueKey, weightKey) {
  const totalWeight = rows.reduce((sum, row) => sum + row[weightKey], 0);
  return totalWeight > 0
    ? rows.reduce((sum, row) => sum + row[valueKey] * row[weightKey], 0) / totalWeight
    : 0;
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

function quantile(values, probability) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const below = Math.floor(index);
  const above = Math.ceil(index);
  if (below === above) return sorted[below];
  return sorted[below] + (sorted[above] - sorted[below]) * (index - below);
}

function robustScale(values) {
  if (values.length < 2) return 0;
  const center = median(values);
  const madScale = median(values.map((value) => Math.abs(value - center))) * 1.4826;
  const iqrScale = (quantile(values, 0.75) - quantile(values, 0.25)) / 1.349;
  const magnitude = Math.max(1, ...values.map((value) => Math.abs(value)));
  return Math.max(madScale, iqrScale, magnitude * Number.EPSILON);
}

function shrinkDimension(value, raterCount, priorRaters) {
  const observed = raterCount > 0 && Number.isFinite(value) ? value : 3;
  return (observed * raterCount + 3 * priorRaters) / (raterCount + priorRaters);
}

function benchmarkBaseWeight(bench, mode, priorRaters) {
  if (mode === "equal") return 1;
  if (mode === "current") return Math.max(0, bench.cachedEffectiveWeight ?? 0);
  if (!["bayesian", "bayesian-quality", "bayesian-quality-difficulty"].includes(mode)) {
    throw new Error(`Unknown benchmarkWeightMode: ${mode}`);
  }

  const dimensions = bench.cachedDimensions ?? {};
  const raterCount = Math.max(0, bench.cachedRaterCount ?? 0);
  const trust = ["relevance", "contamination", "discriminability", "reproducibility"]
    .map((key) => shrinkDimension(dimensions[key], raterCount, priorRaters));
  const difficulty = shrinkDimension(dimensions.difficulty, raterCount, priorRaters);
  const quality = mean(trust) * 20;
  const difficultyMultiplier = clamp((difficulty - 1) / 4, 0, 1);
  const headroom = Number.isFinite(bench.cachedHeadroom) ? bench.cachedHeadroom : 1;
  if (mode === "bayesian-quality") return quality;
  if (mode === "bayesian-quality-difficulty") return quality * difficultyMultiplier;
  return quality * difficultyMultiplier * headroom;
}

function benchmarkWeights(benches, mode, priorRaters) {
  const upvoteMax = Math.max(
    0,
    ...benches.map((bench) => bench.cachedNetUpvotes ?? 1),
  );
  return benches.map((bench) => {
    const baseWeight = benchmarkBaseWeight(bench, mode, priorRaters);
    if (mode !== "bayesian") return baseWeight;
    const netUpvotes = bench.cachedNetUpvotes ?? 1;
    const communityTrust = upvoteMax > 0
      ? clamp(netUpvotes / upvoteMax, 0, 1)
      : 1;
    return baseWeight * communityTrust;
  });
}

function visibleSnapshot(snapshot) {
  const models = snapshot.models.filter((model) => !model.hidden);
  const benches = snapshot.benches.filter((bench) => !bench.hidden);
  const modelIds = new Set(models.map((model) => String(model._id)));
  const benchIds = new Set(benches.map((bench) => String(bench._id)));
  const scoreBuckets = new Map();

  for (const score of snapshot.scores) {
    const modelId = String(score.modelId);
    const benchId = String(score.benchId);
    if (!modelIds.has(modelId) || !benchIds.has(benchId)) continue;
    if (!Number.isFinite(score.normalizedScore)) continue;
    const key = `${modelId}\u0000${benchId}`;
    const values = scoreBuckets.get(key) ?? [];
    values.push(score.normalizedScore);
    scoreBuckets.set(key, values);
  }

  const scores = [];
  for (const [key, values] of scoreBuckets) {
    const [modelId, benchId] = key.split("\u0000");
    scores.push({ modelId, benchId, normalizedScore: median(values) });
  }
  return { models, benches, scores };
}

export function buildFamilyAggregateSnapshot(snapshot, mode = "max") {
  if (!["max", "median"].includes(mode)) {
    throw new Error(`Unknown family aggregate mode: ${mode}`);
  }
  const visible = visibleSnapshot(snapshot);
  const modelById = new Map(visible.models.map((model) => [String(model._id), model]));
  const families = new Map();
  for (const model of visible.models) {
    const familyTag = inferFamilyTag(model.name);
    const id = `family:${encodeURIComponent(model.provider)}:${encodeURIComponent(familyTag)}`;
    if (!families.has(id)) {
      families.set(id, {
        _id: id,
        name: familyTag,
        provider: model.provider,
        familyTag,
        tags: [],
        hidden: false,
      });
    }
  }
  const buckets = new Map();
  for (const score of visible.scores) {
    const model = modelById.get(score.modelId);
    if (!model) continue;
    const familyTag = inferFamilyTag(model.name);
    const modelId = `family:${encodeURIComponent(model.provider)}:${encodeURIComponent(familyTag)}`;
    const key = `${modelId}\u0001${score.benchId}`;
    const values = buckets.get(key) ?? [];
    values.push(score.normalizedScore);
    buckets.set(key, values);
  }
  const scores = [];
  for (const [key, values] of buckets) {
    const [modelId, benchId] = key.split("\u0001");
    scores.push({
      modelId,
      benchId,
      normalizedScore: mode === "max" ? Math.max(...values) : median(values),
      upvotes: 1,
      downvotes: 0,
    });
  }
  return { ...snapshot, models: [...families.values()], scores };
}

export function buildComparisonGraph(snapshot, inputOptions = {}) {
  const options = {
    outcomeMode: "binary",
    benchmarkWeightMode: "bayesian",
    priorRaters: 10,
    pairMassMode: "per-model",
    benchmarkMultipliers: {},
    ...inputOptions,
  };
  const { models, benches, scores } = visibleSnapshot(snapshot);
  const modelIndex = new Map(models.map((model, index) => [String(model._id), index]));
  const benchById = new Map(benches.map((bench) => [String(bench._id), bench]));
  const benchIndex = new Map(benches.map((bench, index) => [String(bench._id), index]));
  const rowsByBench = new Map();
  const observationCounts = new Uint32Array(models.length);

  for (const score of scores) {
    const model = modelIndex.get(score.modelId);
    if (model === undefined) continue;
    const rows = rowsByBench.get(score.benchId) ?? [];
    rows.push({ model, value: score.normalizedScore });
    rowsByBench.set(score.benchId, rows);
    observationCounts[model] += 1;
  }

  const rawWeights = benchmarkWeights(
    benches,
    options.benchmarkWeightMode,
    options.priorRaters,
  );
  const positiveWeightMean = mean(rawWeights.filter((weight) => weight > 0)) || 1;
  const rawWeightById = new Map(benches.map((bench, index) =>
    [String(bench._id), rawWeights[index]]));
  const balancedWeightById = new Map();
  if (options.primaryCategoryBySlug) {
    const categoryWeights = new Map();
    for (const bench of benches) {
      const category = options.primaryCategoryBySlug[bench.slug] ?? "other";
      categoryWeights.set(
        category,
        (categoryWeights.get(category) ?? 0) + (rawWeightById.get(String(bench._id)) ?? 0),
      );
    }
    const categories = [...categoryWeights.keys()];
    const suppliedShares = options.categoryShares ?? {};
    const suppliedTotal = categories.reduce((sum, category) =>
      sum + Math.max(0, suppliedShares[category] ?? 0), 0);
    for (const bench of benches) {
      const category = options.primaryCategoryBySlug[bench.slug] ?? "other";
      const share = suppliedTotal > 0
        ? Math.max(0, suppliedShares[category] ?? 0) / suppliedTotal
        : 1 / categories.length;
      const categoryWeight = categoryWeights.get(category) ?? 0;
      const rawWeight = rawWeightById.get(String(bench._id)) ?? 0;
      balancedWeightById.set(
        String(bench._id),
        categoryWeight > 0 ? benches.length * share * rawWeight / categoryWeight : 0,
      );
    }
  }
  const comparisons = [];
  const usedBenches = [];

  for (const [benchId, rows] of rowsByBench) {
    if (rows.length < 2) continue;
    const bench = benchById.get(benchId);
    const multiplier = options.benchmarkMultipliers[benchId] ?? 1;
    if (!bench || multiplier <= 0) continue;
    const baseWeight = options.primaryCategoryBySlug
      ? balancedWeightById.get(benchId) ?? 0
      : benchmarkBaseWeight(
        bench,
        options.benchmarkWeightMode,
        options.priorRaters,
      ) / positiveWeightMean;
    if (baseWeight <= 0) continue;
    const pairDenominator = options.pairMassMode === "fixed-benchmark"
      ? (rows.length * (rows.length - 1)) / 2
      : rows.length - 1;
    const values = rows.map((row) => row.value);
    const scale = robustScale(values);
    const pairWeight = (baseWeight * multiplier) / pairDenominator;

    for (let left = 0; left < rows.length; left++) {
      for (let right = left + 1; right < rows.length; right++) {
        const difference = rows[left].value - rows[right].value;
        let outcome = difference === 0 ? 0.5 : difference > 0 ? 1 : 0;
        let confidence = 1;
        if (options.outcomeMode === "probit-margin") {
          outcome = scale > 0
            ? normalCdf(difference / (Math.SQRT2 * scale))
            : outcome;
        } else if (options.outcomeMode === "margin-confidence") {
          confidence = difference === 0 || scale <= 0
            ? difference === 0 ? 1 : 0
            : Math.abs(difference) / (Math.abs(difference) + scale);
        } else if (options.outcomeMode !== "binary") {
          throw new Error(`Unknown outcomeMode: ${options.outcomeMode}`);
        }
        comparisons.push({
          left: rows[left].model,
          right: rows[right].model,
          outcome,
          weight: pairWeight * confidence,
          benchId,
          bench: benchIndex.get(benchId),
        });
      }
    }
    usedBenches.push(benchId);
  }

  return { models, benches, comparisons, observationCounts, usedBenches };
}

function deterministicRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export function fitMultidimensionalBradleyTerry(graph, inputOptions = {}) {
  const options = {
    latentDimensions: 2,
    regularization: 0.1,
    latentRegularization: 0.1,
    iterations: 1_500,
    learningRate: 0.02,
    seed: 20260825,
    ...inputOptions,
  };
  if (options.latentDimensions === 0) {
    const fitted = fitBradleyTerry(graph, options);
    return {
      ability: fitted.ability,
      modelFactors: new Float64Array(0),
      benchmarkFactors: new Float64Array(0),
      latentDimensions: 0,
    };
  }

  const modelCount = graph.models.length;
  const benchCount = graph.benches.length;
  const dimensions = options.latentDimensions;
  const ability = new Float64Array(modelCount);
  const modelFactors = new Float64Array(modelCount * dimensions);
  const benchmarkFactors = new Float64Array(benchCount * dimensions);
  const random = deterministicRandom(options.seed);
  for (let index = 0; index < modelFactors.length; index++) {
    modelFactors[index] = (random() - 0.5) * 0.02;
  }
  for (let index = 0; index < benchmarkFactors.length; index++) {
    benchmarkFactors[index] = (random() - 0.5) * 0.02;
  }

  const gradientAbility = new Float64Array(modelCount);
  const gradientModel = new Float64Array(modelFactors.length);
  const gradientBench = new Float64Array(benchmarkFactors.length);
  const moment1Ability = new Float64Array(modelCount);
  const moment2Ability = new Float64Array(modelCount);
  const moment1Model = new Float64Array(modelFactors.length);
  const moment2Model = new Float64Array(modelFactors.length);
  const moment1Bench = new Float64Array(benchmarkFactors.length);
  const moment2Bench = new Float64Array(benchmarkFactors.length);

  const update = (parameter, gradient, moment1, moment2, iteration) => {
    const correction1 = 1 - 0.9 ** iteration;
    const correction2 = 1 - 0.999 ** iteration;
    for (let index = 0; index < parameter.length; index++) {
      moment1[index] = 0.9 * moment1[index] + 0.1 * gradient[index];
      moment2[index] = 0.999 * moment2[index] + 0.001 * gradient[index] ** 2;
      parameter[index] += options.learningRate * (moment1[index] / correction1) /
        (Math.sqrt(moment2[index] / correction2) + EPSILON);
    }
  };

  for (let iteration = 1; iteration <= options.iterations; iteration++) {
    gradientAbility.fill(0);
    gradientModel.fill(0);
    gradientBench.fill(0);
    for (const comparison of graph.comparisons) {
      let difference = ability[comparison.left] - ability[comparison.right];
      const leftOffset = comparison.left * dimensions;
      const rightOffset = comparison.right * dimensions;
      const benchOffset = comparison.bench * dimensions;
      for (let dimension = 0; dimension < dimensions; dimension++) {
        difference +=
          (modelFactors[leftOffset + dimension] - modelFactors[rightOffset + dimension]) *
          benchmarkFactors[benchOffset + dimension];
      }
      const residual = comparison.weight * (comparison.outcome - sigmoid(difference));
      gradientAbility[comparison.left] += residual;
      gradientAbility[comparison.right] -= residual;
      for (let dimension = 0; dimension < dimensions; dimension++) {
        const leftIndex = leftOffset + dimension;
        const rightIndex = rightOffset + dimension;
        const benchmarkIndex = benchOffset + dimension;
        const benchmarkFactor = benchmarkFactors[benchmarkIndex];
        gradientModel[leftIndex] += residual * benchmarkFactor;
        gradientModel[rightIndex] -= residual * benchmarkFactor;
        gradientBench[benchmarkIndex] += residual *
          (modelFactors[leftIndex] - modelFactors[rightIndex]);
      }
    }
    for (let index = 0; index < ability.length; index++) {
      gradientAbility[index] -= options.regularization * ability[index];
    }
    for (let index = 0; index < modelFactors.length; index++) {
      gradientModel[index] -= options.latentRegularization * modelFactors[index];
    }
    for (let index = 0; index < benchmarkFactors.length; index++) {
      gradientBench[index] -= options.latentRegularization * benchmarkFactors[index];
    }
    update(ability, gradientAbility, moment1Ability, moment2Ability, iteration);
    update(modelFactors, gradientModel, moment1Model, moment2Model, iteration);
    update(benchmarkFactors, gradientBench, moment1Bench, moment2Bench, iteration);

    for (let dimension = 0; dimension < dimensions; dimension++) {
      let center = 0;
      for (let model = 0; model < modelCount; model++) {
        center += modelFactors[model * dimensions + dimension];
      }
      center /= modelCount || 1;
      for (let model = 0; model < modelCount; model++) {
        modelFactors[model * dimensions + dimension] -= center;
      }

      let benchmarkCenter = 0;
      for (let bench = 0; bench < benchCount; bench++) {
        benchmarkCenter += benchmarkFactors[bench * dimensions + dimension];
      }
      benchmarkCenter /= benchCount || 1;
      for (let model = 0; model < modelCount; model++) {
        ability[model] += modelFactors[model * dimensions + dimension] * benchmarkCenter;
      }
      for (let bench = 0; bench < benchCount; bench++) {
        benchmarkFactors[bench * dimensions + dimension] -= benchmarkCenter;
      }
    }
    const abilityCenter = mean(ability);
    for (let index = 0; index < ability.length; index++) ability[index] -= abilityCenter;
  }

  return { ability, modelFactors, benchmarkFactors, latentDimensions: dimensions };
}

function multidimensionalProbability(fitted, left, right, bench) {
  let difference = fitted.ability[left] - fitted.ability[right];
  for (let dimension = 0; dimension < fitted.latentDimensions; dimension++) {
    const leftFactor = fitted.modelFactors[left * fitted.latentDimensions + dimension];
    const rightFactor = fitted.modelFactors[right * fitted.latentDimensions + dimension];
    const benchFactor = fitted.benchmarkFactors[bench * fitted.latentDimensions + dimension];
    difference += (leftFactor - rightFactor) * benchFactor;
  }
  return sigmoid(difference);
}

function stableFold(modelId, benchId, folds) {
  let hash = 2166136261;
  for (const character of `${modelId}\u0000${benchId}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % folds;
}

export function crossValidateMissingCells(snapshot, inputOptions = {}) {
  const options = { folds: 5, ...inputOptions };
  const visible = visibleSnapshot(snapshot);
  const modelIds = visible.models.map((model) => String(model._id));
  const benchIds = visible.benches.map((bench) => String(bench._id));
  const originalModelIndex = new Map(modelIds.map((id, index) => [id, index]));
  const originalBenchIndex = new Map(benchIds.map((id, index) => [id, index]));
  const runs = [];

  for (let fold = 0; fold < options.folds; fold++) {
    const heldOut = visible.scores.filter((score) =>
      stableFold(score.modelId, score.benchId, options.folds) === fold);
    const heldOutKeys = new Set(heldOut.map((score) => `${score.modelId}\u0000${score.benchId}`));
    const trainingSnapshot = {
      ...snapshot,
      scores: snapshot.scores.filter((score) =>
        !heldOutKeys.has(`${String(score.modelId)}\u0000${String(score.benchId)}`)),
    };
    const graph = buildComparisonGraph(trainingSnapshot, options);
    const fitted = fitMultidimensionalBradleyTerry(graph, options);
    const graphModelIndex = new Map(graph.models.map((model, index) => [String(model._id), index]));
    const graphBenchIndex = new Map(graph.benches.map((bench, index) => [String(bench._id), index]));
    const trainingByBench = new Map();
    for (const score of visible.scores) {
      const key = `${score.modelId}\u0000${score.benchId}`;
      if (heldOutKeys.has(key)) continue;
      const rows = trainingByBench.get(score.benchId) ?? [];
      rows.push(score);
      trainingByBench.set(score.benchId, rows);
    }

    let correct = 0;
    let logLoss = 0;
    let pairs = 0;
    for (const score of heldOut) {
      const left = graphModelIndex.get(score.modelId);
      const bench = graphBenchIndex.get(score.benchId);
      if (left === undefined || bench === undefined) continue;
      for (const opponent of trainingByBench.get(score.benchId) ?? []) {
        const right = graphModelIndex.get(opponent.modelId);
        if (right === undefined || right === left) continue;
        const difference = score.normalizedScore - opponent.normalizedScore;
        if (difference === 0) continue;
        const outcome = difference > 0 ? 1 : 0;
        const probability = clamp(
          multidimensionalProbability(fitted, left, right, bench),
          EPSILON,
          1 - EPSILON,
        );
        if ((probability > 0.5) === (outcome === 1)) correct += 1;
        logLoss -= outcome * Math.log(probability) + (1 - outcome) * Math.log(1 - probability);
        pairs += 1;
      }
    }
    runs.push({ fold, pairs, accuracy: pairs > 0 ? correct / pairs : null, logLoss: pairs > 0 ? logLoss / pairs : null });
  }

  return {
    runs,
    pairs: runs.reduce((sum, run) => sum + run.pairs, 0),
    accuracy: weightedMean(runs, "accuracy", "pairs"),
    logLoss: weightedMean(runs, "logLoss", "pairs"),
  };
}

export function fitBradleyTerry(graph, inputOptions = {}) {
  const options = {
    regularization: 0.1,
    iterations: 1_500,
    learningRate: 0.03,
    ...inputOptions,
  };
  const count = graph.models.length;
  const ability = new Float64Array(count);
  const firstMoment = new Float64Array(count);
  const secondMoment = new Float64Array(count);
  const gradient = new Float64Array(count);

  for (let iteration = 1; iteration <= options.iterations; iteration++) {
    gradient.fill(0);
    for (const comparison of graph.comparisons) {
      const probability = sigmoid(ability[comparison.left] - ability[comparison.right]);
      const residual = comparison.weight * (comparison.outcome - probability);
      gradient[comparison.left] += residual;
      gradient[comparison.right] -= residual;
    }
    for (let index = 0; index < count; index++) {
      gradient[index] -= options.regularization * ability[index];
    }

    let center = 0;
    const beta1Correction = 1 - 0.9 ** iteration;
    const beta2Correction = 1 - 0.999 ** iteration;
    for (let index = 0; index < count; index++) {
      firstMoment[index] = 0.9 * firstMoment[index] + 0.1 * gradient[index];
      secondMoment[index] = 0.999 * secondMoment[index] + 0.001 * gradient[index] ** 2;
      const adjustedFirst = firstMoment[index] / beta1Correction;
      const adjustedSecond = secondMoment[index] / beta2Correction;
      ability[index] += options.learningRate * adjustedFirst / (Math.sqrt(adjustedSecond) + EPSILON);
      center += ability[index];
    }
    center /= count || 1;
    for (let index = 0; index < count; index++) ability[index] -= center;
  }

  const information = new Float64Array(count);
  information.fill(options.regularization);
  for (const comparison of graph.comparisons) {
    const probability = sigmoid(ability[comparison.left] - ability[comparison.right]);
    const value = comparison.weight * probability * (1 - probability);
    information[comparison.left] += value;
    information[comparison.right] += value;
  }

  return {
    ability,
    standardError: Float64Array.from(information, (value) =>
      value > 0 ? 1 / Math.sqrt(value) : Infinity),
  };
}

export function fitPairwisePageRank(graph, inputOptions = {}) {
  const options = { damping: 0.85, iterations: 200, ...inputOptions };
  const count = graph.models.length;
  const outgoing = new Float64Array(count);
  const edges = [];
  for (const comparison of graph.comparisons) {
    const leftToRight = comparison.weight * (1 - comparison.outcome);
    const rightToLeft = comparison.weight * comparison.outcome;
    if (leftToRight > 0) {
      edges.push({ from: comparison.left, to: comparison.right, weight: leftToRight });
      outgoing[comparison.left] += leftToRight;
    }
    if (rightToLeft > 0) {
      edges.push({ from: comparison.right, to: comparison.left, weight: rightToLeft });
      outgoing[comparison.right] += rightToLeft;
    }
  }
  let probability = new Float64Array(count).fill(1 / (count || 1));
  for (let iteration = 0; iteration < options.iterations; iteration++) {
    const next = new Float64Array(count).fill((1 - options.damping) / (count || 1));
    let dangling = 0;
    for (let index = 0; index < count; index++) {
      if (outgoing[index] === 0) dangling += probability[index];
    }
    const danglingShare = options.damping * dangling / (count || 1);
    for (let index = 0; index < count; index++) next[index] += danglingShare;
    for (const edge of edges) {
      next[edge.to] += options.damping * probability[edge.from] *
        edge.weight / outgoing[edge.from];
    }
    probability = next;
  }
  const meanProbability = 1 / (count || 1);
  return {
    probability,
    ability: Float64Array.from(probability, (value) => Math.log((value + EPSILON) / meanProbability)),
  };
}

export function crossValidatePageRankByBenchmark(snapshot, inputOptions = {}) {
  const visible = visibleSnapshot(snapshot);
  const heldOutWeights = benchmarkWeights(
    visible.benches,
    inputOptions.benchmarkWeightMode ?? "bayesian",
    inputOptions.priorRaters ?? 3,
  );
  const heldOutWeightById = new Map(visible.benches.map((bench, index) =>
    [String(bench._id), heldOutWeights[index]]));
  const runs = [];
  for (const heldOutBench of visible.benches) {
    const heldOutId = String(heldOutBench._id);
    const trainingSnapshot = {
      ...snapshot,
      scores: snapshot.scores.filter((score) => String(score.benchId) !== heldOutId),
    };
    const graph = buildComparisonGraph(trainingSnapshot, inputOptions);
    const fitted = fitPairwisePageRank(graph, inputOptions);
    const trainedIds = new Set(graph.models
      .filter((_, index) => graph.observationCounts[index] > 0)
      .map((model) => String(model._id)));
    const testSnapshot = {
      models: snapshot.models,
      benches: snapshot.benches,
      scores: snapshot.scores.filter((score) =>
        String(score.benchId) === heldOutId && trainedIds.has(String(score.modelId))),
    };
    const testGraph = buildComparisonGraph(testSnapshot, {
      ...inputOptions,
      outcomeMode: "binary",
      benchmarkWeightMode: "equal",
    });
    const trainingIndex = new Map(graph.models.map((model, index) => [String(model._id), index]));
    const testAbility = Float64Array.from(testGraph.models, (model) => {
      const index = trainingIndex.get(String(model._id));
      return index === undefined ? 0 : fitted.ability[index];
    });
    const metrics = predictionMetrics(testGraph.comparisons, testAbility);
    if (metrics.weight > 0) {
      runs.push({
        benchId: heldOutId,
        bench: heldOutBench.name,
        pairs: testGraph.comparisons.length,
        heldOutQuality: heldOutWeightById.get(heldOutId) ?? 0,
        ...metrics,
      });
    }
  }
  return {
    runs,
    meanBenchmarkLogLoss: mean(runs.map((run) => run.logLoss)),
    meanBenchmarkAccuracy: mean(runs.map((run) => run.accuracy)),
    qualityWeightedLogLoss: weightedMean(runs, "logLoss", "heldOutQuality"),
    qualityWeightedAccuracy: weightedMean(runs, "accuracy", "heldOutQuality"),
  };
}

function assignRanks(rows) {
  return [...rows]
    .sort((left, right) => right.ability - left.ability || left.name.localeCompare(right.name))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

export function buildPairwiseRanking(snapshot, inputOptions = {}) {
  const options = {
    representativeMinBenchCount: 3,
    ...inputOptions,
  };
  const graph = buildComparisonGraph(snapshot, options);
  const fitted = fitBradleyTerry(graph, options);
  const modelRows = assignRanks(graph.models.map((model, index) => ({
    id: String(model._id),
    name: model.name,
    provider: model.provider,
    familyTag: inferFamilyTag(model.name),
    ability: fitted.ability[index],
    score: 100 * sigmoid(fitted.ability[index]),
    standardError: fitted.standardError[index],
    benchCount: graph.observationCounts[index],
  })));

  const families = new Map();
  for (const row of modelRows) {
    const rows = families.get(row.familyTag) ?? [];
    rows.push(row);
    families.set(row.familyTag, rows);
  }
  const familyRows = [];
  for (const [familyTag, rows] of families) {
    const sufficientlyObserved = rows.filter((row) =>
      row.benchCount >= options.representativeMinBenchCount);
    const candidates = sufficientlyObserved.length > 0 ? sufficientlyObserved : rows;
    const representative = [...candidates].sort((left, right) =>
      right.ability - left.ability || right.benchCount - left.benchCount)[0];
    familyRows.push({
      name: familyTag,
      familyTag,
      provider: representative.provider,
      representative: representative.name,
      ability: representative.ability,
      score: representative.score,
      standardError: representative.standardError,
      benchCount: representative.benchCount,
      provisional: sufficientlyObserved.length === 0,
      modelCount: rows.length,
    });
  }

  return {
    options,
    graph: {
      modelCount: graph.models.length,
      benchmarkCount: graph.usedBenches.length,
      comparisonCount: graph.comparisons.length,
    },
    modelRanking: modelRows,
    familyRanking: assignRanks(familyRows),
  };
}

function predictionMetrics(comparisons, ability) {
  let logLoss = 0;
  let correct = 0;
  let weight = 0;
  for (const comparison of comparisons) {
    const probability = clamp(
      sigmoid(ability[comparison.left] - ability[comparison.right]),
      EPSILON,
      1 - EPSILON,
    );
    const outcome = comparison.outcome;
    logLoss += comparison.weight *
      (-(outcome * Math.log(probability) + (1 - outcome) * Math.log(1 - probability)));
    const predicted = probability === 0.5 ? 0.5 : probability > 0.5 ? 1 : 0;
    correct += comparison.weight * (predicted === outcome ? 1 : outcome === 0.5 ? 0.5 : 0);
    weight += comparison.weight;
  }
  return {
    logLoss: weight > 0 ? logLoss / weight : null,
    accuracy: weight > 0 ? correct / weight : null,
    weight,
  };
}

export function crossValidateByBenchmark(snapshot, inputOptions = {}) {
  const visible = visibleSnapshot(snapshot);
  const heldOutWeights = benchmarkWeights(
    visible.benches,
    inputOptions.benchmarkWeightMode ?? "bayesian",
    inputOptions.priorRaters ?? 10,
  );
  const heldOutWeightById = new Map(visible.benches.map((bench, index) =>
    [String(bench._id), heldOutWeights[index]]));
  const runs = [];
  for (const heldOutBench of visible.benches) {
    const heldOutId = String(heldOutBench._id);
    const trainingSnapshot = {
      ...snapshot,
      scores: snapshot.scores.filter((score) => String(score.benchId) !== heldOutId),
    };
    const trainingGraph = buildComparisonGraph(trainingSnapshot, inputOptions);
    const fitted = fitBradleyTerry(trainingGraph, inputOptions);
    const trainedIds = new Set(trainingGraph.models
      .filter((_, index) => trainingGraph.observationCounts[index] > 0)
      .map((model) => String(model._id)));

    const testSnapshot = {
      models: snapshot.models,
      benches: snapshot.benches,
      scores: snapshot.scores.filter((score) =>
        String(score.benchId) === heldOutId && trainedIds.has(String(score.modelId))),
    };
    const testGraph = buildComparisonGraph(testSnapshot, {
      ...inputOptions,
      outcomeMode: "binary",
      benchmarkWeightMode: "equal",
    });
    const trainingIndex = new Map(trainingGraph.models.map((model, index) =>
      [String(model._id), index]));
    const testAbility = Float64Array.from(testGraph.models, (model) => {
      const index = trainingIndex.get(String(model._id));
      return index === undefined ? 0 : fitted.ability[index];
    });
    const metrics = predictionMetrics(testGraph.comparisons, testAbility);
    if (metrics.weight > 0) {
      const heldOutQuality = heldOutWeightById.get(heldOutId) ?? 0;
      runs.push({
        benchId: heldOutId,
        bench: heldOutBench.name,
        pairs: testGraph.comparisons.length,
        heldOutQuality,
        ...metrics,
      });
    }
  }

  return {
    runs,
    meanBenchmarkLogLoss: mean(runs.map((run) => run.logLoss)),
    meanBenchmarkAccuracy: mean(runs.map((run) => run.accuracy)),
    qualityWeightedLogLoss: weightedMean(runs, "logLoss", "heldOutQuality"),
    qualityWeightedAccuracy: weightedMean(runs, "accuracy", "heldOutQuality"),
  };
}

export function crossValidatePercentileBaseline(snapshot, inputOptions = {}) {
  const options = {
    benchmarkWeightMode: "bayesian",
    priorRaters: 10,
    ...inputOptions,
  };
  const visible = visibleSnapshot(snapshot);
  const heldOutWeights = benchmarkWeights(
    visible.benches,
    options.benchmarkWeightMode,
    options.priorRaters,
  );
  const heldOutWeightById = new Map(visible.benches.map((bench, index) =>
    [String(bench._id), heldOutWeights[index]]));
  const runs = [];
  const ratingMode = options.benchmarkWeightMode === "equal"
    ? "equal"
    : options.benchmarkWeightMode;
  for (const heldOutBench of visible.benches) {
    const heldOutId = String(heldOutBench._id);
    const trainingSnapshot = {
      ...snapshot,
      scores: snapshot.scores.filter((score) => String(score.benchId) !== heldOutId),
    };
    const ranking = buildRanking(trainingSnapshot, {
      scoreTransform: "percentile",
      ratingMode,
      priorRaters: options.priorRaters,
      trustMode: options.benchmarkWeightMode === "equal" ? "equal" : "current",
      confidenceMode: "separate",
      familyAggregation: "best-config",
      taxonomyMode: "inferred",
    });
    const ability = new Map(ranking.modelRanking
      .filter((row) => row.benchCount > 0)
      .map((row) => [row.id, row.weightedMean]));
    const rows = visible.scores.filter((score) =>
      score.benchId === heldOutId && ability.has(score.modelId));
    let correct = 0;
    let pairs = 0;
    for (let left = 0; left < rows.length; left++) {
      for (let right = left + 1; right < rows.length; right++) {
        const actualDifference = rows[left].normalizedScore - rows[right].normalizedScore;
        if (actualDifference === 0) continue;
        const predictedDifference = ability.get(rows[left].modelId) - ability.get(rows[right].modelId);
        if (predictedDifference === 0) correct += 0.5;
        else if ((predictedDifference > 0) === (actualDifference > 0)) correct += 1;
        pairs += 1;
      }
    }
    if (pairs > 0) {
      runs.push({
        benchId: heldOutId,
        bench: heldOutBench.name,
        pairs,
        accuracy: correct / pairs,
        heldOutQuality: heldOutWeightById.get(heldOutId) ?? 0,
      });
    }
  }
  return {
    runs,
    meanBenchmarkAccuracy: mean(runs.map((run) => run.accuracy)),
    qualityWeightedAccuracy: weightedMean(runs, "accuracy", "heldOutQuality"),
  };
}

export function bootstrapPairedValidationDifference(
  candidateValidation,
  baselineValidation,
  inputOptions = {},
) {
  const options = { samples: 20_000, seed: 20260825, ...inputOptions };
  const baselineByBench = new Map(
    baselineValidation.runs.map((run) => [run.benchId, run]),
  );
  const pairs = candidateValidation.runs
    .map((candidate) => ({
      candidate,
      baseline: baselineByBench.get(candidate.benchId),
    }))
    .filter((pair) => pair.baseline && Number.isFinite(pair.baseline.accuracy));
  if (pairs.length === 0) {
    throw new Error("Paired validation bootstrap has no shared benchmark runs");
  }

  const difference = (rows) => {
    const candidate = weightedMean(
      rows.map((pair) => pair.candidate),
      "accuracy",
      "heldOutQuality",
    );
    const baseline = weightedMean(
      rows.map((pair) => pair.baseline),
      "accuracy",
      "heldOutQuality",
    );
    return candidate - baseline;
  };
  let state = options.seed >>> 0;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const samples = [];
  for (let sample = 0; sample < options.samples; sample++) {
    const rows = [];
    for (let draw = 0; draw < pairs.length; draw++) {
      rows.push(pairs[Math.floor(random() * pairs.length)]);
    }
    samples.push(difference(rows));
  }
  return {
    benchmarks: pairs.length,
    samples: options.samples,
    difference: difference(pairs),
    interval95: [quantile(samples, 0.025), quantile(samples, 0.975)],
    positiveRate: samples.filter((value) => value > 0).length / samples.length,
  };
}

export function bootstrapFamilyRanks(snapshot, inputOptions = {}) {
  const options = { samples: 100, seed: 20260825, ...inputOptions };
  const benches = snapshot.benches.filter((bench) => !bench.hidden);
  let state = options.seed >>> 0;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const ranks = new Map();
  for (let sample = 0; sample < options.samples; sample++) {
    const multipliers = Object.fromEntries(benches.map((bench) => [String(bench._id), 0]));
    for (let draw = 0; draw < benches.length; draw++) {
      const bench = benches[Math.floor(random() * benches.length)];
      const id = String(bench._id);
      multipliers[id] += 1;
    }
    const result = buildPairwiseRanking(snapshot, {
      ...options,
      benchmarkMultipliers: multipliers,
    });
    for (const row of result.familyRanking) {
      const values = ranks.get(row.familyTag) ?? [];
      values.push(row.rank);
      ranks.set(row.familyTag, values);
    }
  }
  return [...ranks].map(([familyTag, values]) => ({
    familyTag,
    samples: values.length,
    medianRank: median(values),
    rank05: quantile(values, 0.05),
    rank95: quantile(values, 0.95),
    top1Rate: values.filter((rank) => rank === 1).length / values.length,
    top3Rate: values.filter((rank) => rank <= 3).length / values.length,
  }));
}
