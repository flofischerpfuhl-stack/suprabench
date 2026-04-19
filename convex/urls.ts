// Curated list of domains we consider "official" sources for benchmark
// scores. Hitting one of these gives the submission an "Official source"
// badge — everything else still works, just renders with the "Community"
// badge instead. The list intentionally errs on the side of inclusion for
// well-known academic / lab / leaderboard hosts; community sources like
// YouTube, Substack, X/Twitter, personal blogs are valid sources for
// community-evaluated benchmarks but do *not* get the official trust mark.

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
  "livecodebench.github.io",
  "github.io",            // catch-all for academic GitHub Pages benches

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
