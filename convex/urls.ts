// Curated list of domains we consider "official" sources for benchmark
// scores. Hitting one of these gives the submission an "Official source"
// badge — everything else still works, just renders with the "Community"
// badge instead. The list intentionally errs on the side of inclusion for
// well-known academic / lab / leaderboard hosts; community sources like
// YouTube, Substack, X/Twitter, personal blogs are valid sources for
// community-evaluated benchmarks but do *not* get the official trust mark.

export const OFFICIAL_DOMAINS: ReadonlyArray<string> = [
  // Academic + paper hosts
  "arxiv.org",
  "openreview.net",
  "aclanthology.org",
  "neurips.cc",
  "iclr.cc",
  "icml.cc",
  "proceedings.mlr.press",

  // Aggregators / dedicated leaderboards
  "paperswithcode.com",
  "huggingface.co",
  "artificialanalysis.ai",
  "livebench.ai",
  "lmarena.ai",
  "chat.lmsys.org",
  "lmsys.org",
  "openllm-leaderboard.com",

  // Established benchmark project sites
  "swebench.com",
  "aider.chat",
  "evalplus.github.io",
  "bigcode-bench.github.io",
  "bigcode-project.github.io",
  "tau-bench.github.io",
  "math-eval.github.io",
  "arcprize.org",
  "mlperf.org",
  "mlcommons.org",
  "scale.com",
  "opencompass.org",
  "crfm.stanford.edu",
  "nlp.stanford.edu",
  "github.io",

  // Major model labs (their own scientific reports / model cards)
  "openai.com",
  "anthropic.com",
  "deepmind.google",
  "deepmind.com",
  "blog.google",
  "ai.google.dev",
  "ai.meta.com",
  "about.fb.com",
  "mistral.ai",
  "x.ai",
  "cohere.com",
  "databricks.com",
  "nvidia.com",
  "developer.nvidia.com",
  "blogs.nvidia.com",
  "research.microsoft.com",
  "microsoft.com",
  "qwenlm.github.io",
  "deepseek.com",
];

export function isOfficialUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return OFFICIAL_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith("." + d)
    );
  } catch {
    return false;
  }
}
