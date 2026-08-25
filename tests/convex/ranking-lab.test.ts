import { describe, expect, it } from "vitest";
import {
  auditFamilyTags,
  analyzeLeaveOneBenchOut,
  buildRanking,
  inferFamilyTag,
} from "../../scripts/lib/ranking-lab-core.mjs";

function snapshot() {
  return {
    models: [
      { _id: "m1", name: "GPT-5.6 Sol (xhigh)", provider: "OpenAI", familyTag: "GPT-5.6", hidden: false },
      { _id: "m2", name: "GPT-5.6 Terra (max)", provider: "OpenAI", familyTag: "GPT-5.6", hidden: false },
      { _id: "m3", name: "Claude Fable 5 (high)", provider: "Anthropic", familyTag: "Claude Fable 5", hidden: false },
    ],
    benches: [
      {
        _id: "b1",
        name: "Hard",
        slug: "hard",
        hidden: false,
        cachedEffectiveWeight: 50,
        cachedHeadroom: 1,
        cachedModelCount: 3,
        cachedNetUpvotes: 1,
        cachedRaterCount: 1,
        cachedDimensions: { relevance: 5, contamination: 5, discriminability: 5, reproducibility: 5, difficulty: 5 },
      },
      {
        _id: "b2",
        name: "Easy",
        slug: "easy",
        hidden: false,
        cachedEffectiveWeight: 25,
        cachedHeadroom: 0.5,
        cachedModelCount: 3,
        cachedNetUpvotes: 1,
        cachedRaterCount: 1,
        cachedDimensions: { relevance: 3, contamination: 3, discriminability: 3, reproducibility: 3, difficulty: 3 },
      },
    ],
    scores: [
      { modelId: "m1", benchId: "b1", normalizedScore: 30, upvotes: 1, downvotes: 0 },
      { modelId: "m2", benchId: "b1", normalizedScore: 20, upvotes: 1, downvotes: 0 },
      { modelId: "m3", benchId: "b1", normalizedScore: 10, upvotes: 1, downvotes: 0 },
      { modelId: "m1", benchId: "b2", normalizedScore: 60, upvotes: 1, downvotes: 0 },
      { modelId: "m2", benchId: "b2", normalizedScore: 80, upvotes: 1, downvotes: 0 },
      { modelId: "m3", benchId: "b2", normalizedScore: 70, upvotes: 1, downvotes: 0 },
    ],
  };
}

describe("ranking lab", () => {
  it("keeps product tiers and strips only reasoning effort", () => {
    expect(inferFamilyTag("GPT-5.6 Sol (xhigh)")).toBe("GPT-5.6 Sol");
    expect(inferFamilyTag("GPT-5.6 Terra (max)")).toBe("GPT-5.6 Terra");
    expect(inferFamilyTag("Claude Fable 5 (adaptive max/fallback)")).toBe("Claude Fable 5");
    expect(inferFamilyTag("Gemini 3 Flash (high reasoning)")).toBe("Gemini 3 Flash");
    expect(inferFamilyTag("GPT-5 (minimal)")).toBe("GPT-5");
    expect(inferFamilyTag("Qwen3.8-Max (xhigh)")).toBe("Qwen3.8-Max");
  });

  it("reproduces database grouping when requested", () => {
    const result = buildRanking(snapshot(), {
      scoreTransform: "raw",
      ratingMode: "current",
      confidenceMode: "current",
      familyAggregation: "median-per-bench",
      taxonomyMode: "database",
    });
    expect(result.familyRanking.filter((row) => row.provider === "OpenAI")).toHaveLength(1);
  });

  it("splits Sol and Terra under conservative inferred taxonomy", () => {
    const result = buildRanking(snapshot(), {
      scoreTransform: "percentile",
      ratingMode: "current",
      confidenceMode: "separate",
      familyAggregation: "best-config",
      taxonomyMode: "inferred",
    });
    const openAi = result.familyRanking.filter((row) => row.provider === "OpenAI");
    expect(openAi.map((row) => row.familyTag).sort()).toEqual(["GPT-5.6 Sol", "GPT-5.6 Terra"]);
  });

  it("reports family-tag mismatches without mutating the snapshot", () => {
    const input = snapshot();
    const before = JSON.stringify(input);
    const mismatches = auditFamilyTags(input).filter((row) => row.differs);
    expect(mismatches.map((row) => row.name)).toEqual([
      "GPT-5.6 Sol (xhigh)",
      "GPT-5.6 Terra (max)",
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("treats a high placement on a low-scale benchmark as high relative performance", () => {
    const values = [30.16, 7.78, 1.5, 0.8, 0.43, 0.42, 0.3, 0.18];
    const input = {
      models: values.map((_, index) => ({
        _id: `m${index}`,
        name: index === 1 ? "GPT-5.6 Sol" : `Other ${index}`,
        provider: index === 1 ? "OpenAI" : "Other",
        familyTag: index === 1 ? "GPT-5.6 Sol" : `Other ${index}`,
        hidden: false,
      })),
      benches: [{
        _id: "arc3",
        name: "ARC-AGI-3",
        slug: "arc-agi-3",
        hidden: false,
        cachedEffectiveWeight: 95,
        cachedHeadroom: 1,
        cachedModelCount: values.length,
        cachedNetUpvotes: 1,
      }],
      scores: values.map((normalizedScore, index) => ({
        modelId: `m${index}`,
        benchId: "arc3",
        normalizedScore,
        upvotes: 1,
        downvotes: 0,
      })),
    };
    const result = buildRanking(input, {
      scoreTransform: "percentile",
      confidenceMode: "separate",
      familyAggregation: "best-config",
      taxonomyMode: "inferred",
    });
    const sol = result.modelRanking.find((row) => row.name === "GPT-5.6 Sol");
    expect(sol?.weightedMean).toBe(81.25);
  });

  it("makes percentile and robust-z rankings invariant to positive affine score scales", () => {
    for (const scoreTransform of ["percentile", "robust-z"]) {
      const baseline = buildRanking(snapshot(), {
        scoreTransform,
        confidenceMode: "separate",
        familyAggregation: "best-config",
        taxonomyMode: "inferred",
      });
      const transformed = snapshot();
      transformed.scores = transformed.scores.map((score) =>
        score.benchId === "b1"
          ? { ...score, normalizedScore: 10 + score.normalizedScore * 0.5 }
          : score,
      );
      const changed = buildRanking(transformed, {
        scoreTransform,
        confidenceMode: "separate",
        familyAggregation: "best-config",
        taxonomyMode: "inferred",
      });
      expect(changed.modelRanking.map((row) => [row.name, row.score])).toEqual(
        baseline.modelRanking.map((row) => [row.name, row.score]),
      );
    }
  });

  it("can apply the existing sqrt coverage reliability to ability weight", () => {
    const input = snapshot();
    input.benches[0].cachedModelCount = 1;
    const current = buildRanking(input, {
      scoreTransform: "raw",
      confidenceMode: "separate",
      benchCoverageMode: "evidence-only",
      familyAggregation: "best-config",
      taxonomyMode: "inferred",
    });
    const reliabilityWeighted = buildRanking(input, {
      scoreTransform: "raw",
      confidenceMode: "separate",
      benchCoverageMode: "ability-and-evidence",
      familyAggregation: "best-config",
      taxonomyMode: "inferred",
    });
    const currentSol = current.modelRanking.find((row) => row.name === "GPT-5.6 Sol (xhigh)");
    const weightedSol = reliabilityWeighted.modelRanking.find((row) => row.name === "GPT-5.6 Sol (xhigh)");
    expect(weightedSol?.weightedMean).toBeGreaterThan(currentSol?.weightedMean ?? Infinity);
  });

  it("reports leave-one-benchmark-out stability without changing the input", () => {
    const input = snapshot();
    const before = JSON.stringify(input);
    const result = analyzeLeaveOneBenchOut(
      input,
      {
        scoreTransform: "percentile",
        confidenceMode: "current",
        familyAggregation: "best-config",
        taxonomyMode: "inferred",
      },
      ["GPT-5.6 Sol"],
    );
    expect(result.runs).toBe(2);
    expect(result.meanPairwiseStability).toBeGreaterThanOrEqual(0);
    expect(result.meanPairwiseStability).toBeLessThanOrEqual(1);
    expect(result.tracked[0].familyTag).toBe("GPT-5.6 Sol");
    expect(JSON.stringify(input)).toBe(before);
  });
});
