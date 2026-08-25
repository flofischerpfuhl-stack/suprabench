import { describe, expect, it } from "vitest";
import {
  auditFamilyTags,
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
});
