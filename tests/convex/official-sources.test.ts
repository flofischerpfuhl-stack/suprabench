import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isOfficialUrl,
  OFFICIAL_DOMAINS,
  OFFICIAL_URL_PREFIXES,
} from "../../convex/urls";

function clientArray(name: string): string[] {
  const source = readFileSync(
    new URL("../../public/js/app.js", import.meta.url),
    "utf8",
  );
  const match = source.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`));
  if (!match) throw new Error(`Missing ${name} in public/js/app.js`);
  return Function(`"use strict"; return ${match[1]};`)() as string[];
}

describe("official benchmark source classification", () => {
  it.each([
    "https://www.tbench.ai/",
    "https://deepswe.datacurve.ai/",
    "https://www.textquests.ai/",
    "https://github.com/embodiedreasoning/ERQA",
    "https://github.com/embodiedreasoning/ERQA/tree/main/data",
    "https://sierra.ai/resources/research/tau-squared-bench",
    "https://skatebench.t3.gg/",
  ])("recognizes reviewed first-party source %s", (url) => {
    expect(isOfficialUrl(url)).toBe(true);
  });

  it.each([
    "https://github.com/random-user/random-benchmark",
    "https://github.com/embodiedreasoning/ERQA-lookalike",
    "https://youtube.com/watch?v=not-a-primary-source",
    "https://example.com/benchmark-roundup",
  ])("does not promote unreviewed or third-party source %s", (url) => {
    expect(isOfficialUrl(url)).toBe(false);
  });

  it("keeps browser preview and server classification lists identical", () => {
    expect(clientArray("OFFICIAL_DOMAINS").sort()).toEqual(
      [...OFFICIAL_DOMAINS].sort(),
    );
    expect(clientArray("OFFICIAL_URL_PREFIXES").sort()).toEqual(
      [...OFFICIAL_URL_PREFIXES].sort(),
    );
  });
});
