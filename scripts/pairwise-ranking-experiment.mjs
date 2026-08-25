#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  bootstrapPairedValidationDifference,
  bootstrapFamilyRanks,
  buildFamilyAggregateSnapshot,
  buildPairwiseRanking,
  crossValidateByBenchmark,
  crossValidatePercentileBaseline,
} from "./lib/pairwise-ranking.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const snapshotPath = path.resolve(argument("--snapshot", ".ranking-lab/snapshot.json"));
const mode = argument("--mode", "search");
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
const categoryGroups = JSON.parse(fs.readFileSync(
  new URL("./ranking-lab-categories.json", import.meta.url),
  "utf8",
));
const primaryCategoryBySlug = Object.fromEntries(
  Object.entries(categoryGroups).flatMap(([category, slugs]) =>
    slugs.map((slug) => [slug, category])),
);
const targets = [
  "Claude Mythos 5",
  "Claude Fable 5",
  "GPT-5.6 Sol",
  "Kimi K3",
  "GLM-5.3",
  "Grok 4.6",
  "Muse Spark 1.2",
  "Gemini 3.5 Flash",
];

if (mode === "search") {
  const baselines = ["current", "bayesian", "equal"].map((benchmarkWeightMode) => ({
    benchmarkWeightMode,
    ...crossValidatePercentileBaseline(snapshot, { benchmarkWeightMode, priorRaters: 10 }),
  }));
  const candidates = [];
  for (const outcomeMode of ["binary", "probit-margin", "margin-confidence"]) {
    for (const benchmarkWeightMode of ["current", "bayesian", "equal"]) {
      for (const regularization of [0.03, 0.1, 0.3, 1]) {
        const options = {
          outcomeMode,
          benchmarkWeightMode,
          priorRaters: 10,
          regularization,
          iterations: 600,
        };
        const validation = crossValidateByBenchmark(snapshot, options);
        candidates.push({ options, ...validation });
        process.stderr.write(
          `${outcomeMode} ${benchmarkWeightMode} lambda=${regularization}: ` +
          `loss=${validation.meanBenchmarkLogLoss.toFixed(4)} ` +
          `accuracy=${validation.meanBenchmarkAccuracy.toFixed(4)}\n`,
        );
      }
    }
  }
  for (const outcomeMode of ["binary", "probit-margin"]) {
    for (const regularization of [0.03, 0.1, 0.3]) {
      const options = {
        outcomeMode,
        benchmarkWeightMode: "bayesian",
        priorRaters: 10,
        regularization,
        iterations: 600,
        primaryCategoryBySlug,
      };
      const validation = crossValidateByBenchmark(snapshot, options);
      candidates.push({ options: { ...options, primaryCategoryBySlug: "balanced-v1" }, ...validation });
      process.stderr.write(
        `${outcomeMode} balanced-v1 lambda=${regularization}: ` +
        `loss=${validation.meanBenchmarkLogLoss.toFixed(4)} ` +
        `accuracy=${validation.meanBenchmarkAccuracy.toFixed(4)}\n`,
      );
    }
  }
  for (const familyAggregate of ["max", "median"]) {
    const familySnapshot = buildFamilyAggregateSnapshot(snapshot, familyAggregate);
    for (const regularization of [0.05, 0.1, 0.15]) {
      const options = {
        outcomeMode: "binary",
        benchmarkWeightMode: "bayesian",
        priorRaters: 3,
        regularization,
        iterations: 600,
        familyAggregate,
      };
      const validation = crossValidateByBenchmark(familySnapshot, options);
      candidates.push({ options, ...validation });
      process.stderr.write(
        `family-${familyAggregate} binary lambda=${regularization}: ` +
        `loss=${validation.meanBenchmarkLogLoss.toFixed(4)} ` +
        `accuracy=${validation.meanBenchmarkAccuracy.toFixed(4)}\n`,
      );
    }
  }
  candidates.sort((left, right) =>
    left.meanBenchmarkLogLoss - right.meanBenchmarkLogLoss ||
    right.meanBenchmarkAccuracy - left.meanBenchmarkAccuracy);
  console.log(JSON.stringify({ baselines, candidates }, null, 2));
} else if (mode === "verify") {
  const options = {
    outcomeMode: argument("--outcome", "binary"),
    benchmarkWeightMode: argument("--weights", "bayesian"),
    priorRaters: Number(argument("--prior-raters", "10")),
    regularization: Number(argument("--regularization", "0.1")),
    iterations: Number(argument("--iterations", "1500")),
    samples: Number(argument("--bootstrap-samples", "100")),
  };
  if (process.argv.includes("--balanced-categories")) {
    options.primaryCategoryBySlug = primaryCategoryBySlug;
  }
  const aggregateMode = argument("--family-aggregate", null);
  const analysisSnapshot = aggregateMode
    ? buildFamilyAggregateSnapshot(snapshot, aggregateMode)
    : snapshot;
  const ranking = buildPairwiseRanking(analysisSnapshot, options);
  const validation = crossValidateByBenchmark(analysisSnapshot, options);
  const bootstrap = bootstrapFamilyRanks(analysisSnapshot, options);
  let comparisons;
  if (aggregateMode === "max") {
    const concreteValidation = crossValidateByBenchmark(snapshot, {
      ...options,
      regularization: 0.1,
    });
    const medianValidation = crossValidateByBenchmark(
      buildFamilyAggregateSnapshot(snapshot, "median"),
      options,
    );
    comparisons = {
      concreteConfiguration: {
        validation: concreteValidation,
        pairedBootstrap: bootstrapPairedValidationDifference(
          validation,
          concreteValidation,
          { samples: Number(argument("--validation-bootstrap-samples", "20000")) },
        ),
      },
      familyMedian: {
        validation: medianValidation,
        pairedBootstrap: bootstrapPairedValidationDifference(
          validation,
          medianValidation,
          { samples: Number(argument("--validation-bootstrap-samples", "20000")) },
        ),
      },
    };
  }
  const targetRows = targets.map((familyTag) => ({
    ...ranking.familyRanking.find((row) => row.familyTag === familyTag),
    bootstrap: bootstrap.find((row) => row.familyTag === familyTag),
  }));
  console.log(JSON.stringify({
    options,
    graph: ranking.graph,
    validation,
    comparisons,
    targetRows,
  }, null, 2));
} else {
  throw new Error(`Unknown --mode ${mode}`);
}
