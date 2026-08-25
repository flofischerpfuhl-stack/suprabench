import { describe, expect, it } from "vitest";
import { canonicalFamilyTag } from "../../convex/modelFamilies";

describe("canonical model families", () => {
  it("keeps GPT-5.6 product tiers separate from reasoning effort", () => {
    expect(canonicalFamilyTag("GPT-5.6 Sol (xhigh)", "GPT-5.6")).toBe("GPT-5.6 Sol");
    expect(canonicalFamilyTag("GPT-5.6 Sol (max)", "wrong")).toBe("GPT-5.6 Sol");
    expect(canonicalFamilyTag("GPT-5.6 Terra", "GPT-5.6")).toBe("GPT-5.6 Terra");
    expect(canonicalFamilyTag("GPT-5.6 Luna", "GPT-5.6")).toBe("GPT-5.6 Luna");
  });

  it("keeps versioned Muse Spark releases separate", () => {
    expect(canonicalFamilyTag("Muse Spark 1.1 (xhigh)", "Muse Spark")).toBe("Muse Spark 1.1");
    expect(canonicalFamilyTag("Muse Spark 1.2 (xhigh)", "Muse Spark")).toBe("Muse Spark 1.2");
  });

  it("does not guess at unreviewed names or split reasoning efforts", () => {
    expect(canonicalFamilyTag("GPT-5.5 (xhigh)", "GPT-5.5")).toBe("GPT-5.5");
    expect(canonicalFamilyTag("Claude Fable 5 (high)", "Claude Fable 5")).toBe("Claude Fable 5");
    expect(canonicalFamilyTag("Unknown Model", " Curated Family ")).toBe("Curated Family");
    expect(canonicalFamilyTag("Unknown Model", "  ")).toBeUndefined();
  });
});
