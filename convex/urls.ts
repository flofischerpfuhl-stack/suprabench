// Curated list of domains we consider first-party/original sources for a
// benchmark. Hitting one of these gives the benchmark an "Official source"
// badge — it is provenance, not a quality endorsement. Everything else still
// works and renders with the "Community source" badge. YouTube, Substack,
// X/Twitter, personal blogs and third-party mirrors do not get the official
// provenance mark.

export const OFFICIAL_DOMAINS: ReadonlyArray<string> = [
  // ── Academic + paper hosts ──
  "arxiv.org",
  "openreview.net",
  "aclanthology.org",
  "neurips.cc",
  "iclr.cc",
  "icml.cc",
  "proceedings.mlr.press",
  "proceedings.neurips.cc",
  "papers.nips.cc",
  // Major journals + indexed publishers (HLE was published in Nature,
  // and benchmark papers regularly land in Science/Cell/PNAS too).
  "nature.com",
  "science.org",
  "cell.com",
  "pnas.org",
  "link.springer.com",
  "dl.acm.org",
  "ieeexplore.ieee.org",
  "ncbi.nlm.nih.gov",
  "pubmed.ncbi.nlm.nih.gov",

  // ── Aggregators / dedicated leaderboards ──
  "paperswithcode.com",
  "huggingface.co",
  "artificialanalysis.ai",
  "livebench.ai",
  "lmarena.ai",
  "chat.lmsys.org",
  "lmsys.org",
  "openllm-leaderboard.com",
  "kaggle.com",
  "scale.com",

  // ── Established benchmark project sites ──
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
  "opencompass.org",
  "agi.safe.ai",          // Humanity's Last Exam (CAIS + Scale AI)
  "safe.ai",              // Center for AI Safety umbrella
  "epoch.ai",             // Epoch AI evaluation research
  "epochai.org",
  "simple-bench.com",     // SimpleBench
  "simplebench.io",
  "osworld.ai",           // OSWorld agent benchmark
  "webarena.dev",         // WebArena
  "gaia-benchmark.github.io",
  "terminalbench.org",
  "tbench.ai",           // Terminal-Bench project + leaderboards
  "livecodebench.github.io",
  "github.io",            // catch-all for academic GitHub Pages benches
  "datacurve.ai",         // DeepSWE first-party project
  "textquests.ai",        // TextQuests first-party project
  "sierra.ai",            // tau / tau-squared benchmark publisher
  "skatebench.t3.gg",     // SkateBench project leaderboard

  // ── Research labs + universities (research subdomains) ──
  "crfm.stanford.edu",
  "nlp.stanford.edu",
  "csail.mit.edu",
  "bair.berkeley.edu",
  "allenai.org",
  "allen.ai",
  "eleuther.ai",
  "lifearchitect.ai",     // independent eval research (Alan Thompson)

  // ── Major model labs (their own scientific reports / model cards) ──
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
  "moonshot.cn",          // Kimi
  "ai21.com",
  "stability.ai",
  "perplexity.ai",
  "ollama.com",           // model cards
  "together.ai",          // model evals
  "groq.com",             // inference + model evals
  "replicate.com",        // model cards
  "fireworks.ai",
];

// GitHub.com cannot be allowlisted wholesale: any user can create a repository
// there. Exact reviewed project repositories are therefore represented as
// path prefixes. A repository root and its descendants qualify, similarly
// named sibling repositories do not.
export const OFFICIAL_URL_PREFIXES: ReadonlyArray<string> = [
  "https://github.com/embodiedreasoning/erqa",
];

function matchesOfficialPrefix(url: URL): boolean {
  const originAndPath = `${url.origin}${url.pathname}`
    .toLowerCase()
    .replace(/\/+$/, "");
  return OFFICIAL_URL_PREFIXES.some((prefix) => {
    const normalized = prefix.toLowerCase().replace(/\/+$/, "");
    return originAndPath === normalized || originAndPath.startsWith(`${normalized}/`);
  });
}

export function isOfficialUrl(url: string): boolean {
  try {
    const parsed = parsePublicHttpUrl(url);
    const hostname = parsed.hostname.toLowerCase();
    return (
      OFFICIAL_DOMAINS.some(
        (d) => hostname === d || hostname.endsWith("." + d)
      ) || matchesOfficialPrefix(parsed)
    );
  } catch {
    return false;
  }
}

export function parsePublicHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("URL must start with http:// or https://");
  }
  if (!url.hostname || url.username || url.password) {
    throw new Error("URL must be a public http(s) URL without embedded credentials");
  }
  return url;
}

export function normalizePublicHttpUrl(raw: string): string {
  return parsePublicHttpUrl(raw.trim()).toString();
}
