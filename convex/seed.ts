// ════════════════════════════════════════════════════════════
// Initial benchmark seed.
//
// Inserts the SWE-bench Verified / safe.ai dashboard / Artificial
// Analysis tables that Florian collected in `/Downloads/seed.txt` in
// April 2026. Idempotent: skips benches/models that already exist
// (by slug / name) and skips score submissions that already exist
// for the same (model, bench, sourceUrl) tuple. Safe to re-run.
//
// Run from the project root with:
//   npx convex run --prod seed:seedAll
//   npx convex run --prod seed:finalize
//
// All inserted records are attributed to the primary admin
// (PRIMARY_ADMIN_EMAIL in admin.ts) which must already exist as a
// `users` row before the first run.
// ════════════════════════════════════════════════════════════

import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { isOfficialUrl, normalizePublicHttpUrl } from "./urls";
import { recomputeBenchAggregatesInline } from "./cache";
import { recomputeEffectiveTags } from "./tagVotes";
import { seedCreatorEntityVote } from "./entityVotes";
import { PRIMARY_ADMIN_EMAIL } from "./admin";

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// ── Source URLs ─────────────────────────────────────────────
const SRC_SWEBENCH = "https://www.swebench.com/index.html";
const SRC_SAFEAI = "https://dashboard.safe.ai/";
const SRC_AA_HLE =
  "https://artificialanalysis.ai/evaluations/humanitys-last-exam";
const SRC_AA_MMMU = "https://artificialanalysis.ai/evaluations/mmmu-pro";
const SRC_AA_LCR =
  "https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning";
const SRC_AA_SCICODE = "https://artificialanalysis.ai/evaluations/scicode";
const SRC_AA_TBHARD =
  "https://artificialanalysis.ai/evaluations/terminalbench-hard";
const SRC_AA_TAU = "https://artificialanalysis.ai/evaluations/tau2-bench";
const SRC_AA_APEX =
  "https://artificialanalysis.ai/evaluations/apex-agents-aa";

// ── Bench definitions (existing benches are matched by slug) ──
type BenchDef = {
  name: string;
  description: string;
  url: string;
  scaleMin: number;
  scaleMax: number;
  tags: string[];
};

const BENCHES: BenchDef[] = [
  {
    name: "ARC-AGI-2",
    description:
      "ARC-AGI-2 is the second iteration of the Abstraction and Reasoning Corpus, designed to measure fluid intelligence in AI systems through novel visual grid puzzles. Each task requires inferring an unseen rule from a few input/output examples and applying it to a held-out grid. Frontier LLMs score in the low single digits while typical humans score above 80%, making it a sharp discriminator of compositional generalisation.",
    url: "https://arcprize.org/arc-agi/2",
    scaleMin: 0,
    scaleMax: 1000,
    tags: ["reasoning", "abstract reasoning", "fluid intelligence"],
  },
  {
    name: "SWE-Bench Pro",
    description:
      "SWE-Bench Pro is a contamination-resistant successor to SWE-bench focused on professional-grade software-engineering tasks drawn from 41 active enterprise and library codebases. Each task requires multi-file edits of non-trivial complexity (50–300+ LOC) and is graded by container-based test execution. Designed to evaluate LLM agents on realistic, evolving production codebases.",
    url: "https://labs.scale.com/leaderboard/swe_bench_pro_public",
    scaleMin: 0,
    scaleMax: 1000,
    tags: ["coding", "software engineering", "agents"],
  },
  {
    name: "TextQuests",
    description:
      "TextQuests benchmarks LLM agents on classic Infocom interactive-fiction games. Models must explore, learn from feedback, and plan over hundreds of turns purely through text — testing long-horizon reasoning, exploration, and natural-language game state tracking without external tools. Released by the Center for AI Safety.",
    url: "https://textquests.ai/",
    scaleMin: 0,
    scaleMax: 1000,
    tags: ["agents", "long context", "reasoning", "video games"],
  },
  {
    name: "ERQA",
    description:
      "Embodied Reasoning Question Answering (ERQA) measures spatial and physical reasoning capabilities of vision-language models in embodied / robotics-relevant settings. Questions probe scene geometry, affordances, and physical relations from egocentric or third-person images, requiring grounded multi-step reasoning rather than pattern matching.",
    url: "https://github.com/embodiedreasoning/ERQA",
    scaleMin: 0,
    scaleMax: 1000,
    tags: ["multimodal", "embodied", "spatial reasoning"],
  },
  {
    name: "MindCube",
    description:
      "MindCube evaluates whether vision-language models can build a coherent mental model of unseen 3D space from a small set of partial views. Tasks include cognitive mapping, perspective-taking, and mental simulation across 17,530 questions over 2,919 images, isolating spatial mental modeling from raw perception.",
    url: "https://arxiv.org/abs/2506.21458",
    scaleMin: 0,
    scaleMax: 1000,
    tags: ["multimodal", "spatial reasoning", "vlm"],
  },
  {
    name: "SpatialViz",
    description:
      "SpatialViz-Bench is a multimodal benchmark for spatial visualization — the ability to mentally imagine and manipulate visual images to infer unseen relationships. Contains 1,180 programmatically generated tasks across 12 task types and 4 sub-abilities, designed to avoid contamination from public IQ-test or competition data.",
    url: "https://arxiv.org/abs/2507.07610",
    scaleMin: 0,
    scaleMax: 1000,
    tags: ["multimodal", "spatial reasoning", "visualization"],
  },
  {
    name: "IntPhys 2",
    description:
      "IntPhys 2 is a video benchmark from Meta AI that evaluates whether models grasp the four core principles of intuitive physics — permanence, immutability, spatio-temporal continuity, and solidity — using a violation-of-expectation framework on 1,416 photorealistic Unreal Engine 5 clips. Frontier models score far below the human ceiling.",
    url: "https://ai.meta.com/research/publications/intphys-2-benchmarking-intuitive-physics-understanding-in-complex-synthetic-environments/",
    scaleMin: 0,
    scaleMax: 1000,
    tags: ["video", "physics", "multimodal"],
  },
  {
    name: "EnigmaEval",
    description:
      "EnigmaEval is a multimodal puzzle-hunt benchmark from Scale AI that tests creative, lateral, and cross-domain reasoning on long unstructured problems sourced from real-world puzzle hunts. Solutions require synthesising knowledge from many domains and following multi-step deductive chains the model has never seen before.",
    url: "https://labs.scale.com/leaderboard/enigma_eval",
    scaleMin: 0,
    scaleMax: 1000,
    tags: ["reasoning", "multimodal", "puzzles"],
  },
  {
    name: "MMMU-Pro",
    description:
      "MMMU-Pro is the harder, vision-only successor to MMMU. It removes text-only-answerable questions, expands the candidate set, and forces inputs through screenshots so models cannot bypass the image. Covers 30 academic disciplines, requiring expert multimodal reasoning grounded in actual visual content.",
    url: "https://mmmu-benchmark.github.io/",
    scaleMin: 0,
    scaleMax: 100,
    tags: ["multimodal", "reasoning", "knowledge"],
  },
  {
    name: "AA Long Context Reasoning",
    description:
      "Artificial Analysis Long Context Reasoning (AA-LCR) tests models on long-document reasoning across multiple sources totalling roughly 100k tokens. Tasks emulate real knowledge-work scenarios — synthesising facts from several reports rather than retrieving a single needle — exposing the gap between long-context retrieval and genuine multi-doc reasoning.",
    url: "https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning",
    scaleMin: 0,
    scaleMax: 1000,
    tags: ["long context", "reasoning", "retrieval"],
  },
  {
    name: "SciCode",
    description:
      "SciCode is a research-coding benchmark sourced from working scientists across 16 subfields. Each task asks the model to translate a scientific problem statement into executable code, with grading by hidden test cases that operate on real scientific objects (molecules, fields, signals). Tests practical scientific computing skill rather than competitive-programming puzzles.",
    url: "https://scicode-bench.github.io/",
    scaleMin: 0,
    scaleMax: 1000,
    tags: ["coding", "scientific computing", "science"],
  },
  {
    name: "Terminal-Bench Hard",
    description:
      "Terminal-Bench Hard is the difficult subset of Terminal-Bench, evaluating LLM agents on long-horizon real-world shell tasks — system administration, builds, multi-step automation — inside a containerised terminal environment. Requires correct tool use, error recovery, and multi-step planning over many commands.",
    url: "https://www.tbench.ai/",
    scaleMin: 0,
    scaleMax: 1000,
    tags: ["agents", "coding", "terminal"],
  },
  {
    name: "Tau2-Bench Telecom",
    description:
      "The Telecom split of Sierra's τ²-Bench evaluates conversational agents in a dual-control environment where an agent and a simulated user, each with their own tools, must collaborate to resolve customer-service scenarios. Grades policy adherence, tool use, and multi-turn coordination — a closer analogue of real-world deployed agents than single-turn benchmarks.",
    url: "https://sierra.ai/resources/research/tau-squared-bench",
    scaleMin: 0,
    scaleMax: 1000,
    tags: ["agents", "conversational", "tool use"],
  },
  {
    name: "APEX-Agents-AA",
    description:
      "APEX-Agents-AA is Artificial Analysis's implementation of the APEX-Agents benchmark, evaluating LLM agents on long-horizon, cross-application professional-services tasks (investment banking, law, consulting). Agents navigate file systems and realistic tooling to complete realistic multi-step workflows.",
    url: "https://artificialanalysis.ai/evaluations/apex-agents-aa",
    scaleMin: 0,
    scaleMax: 1000,
    tags: ["agents", "professional services", "tool use"],
  },
];

// ── Model definitions (new models to insert) ────────────────
type ModelDef = {
  name: string;
  provider: string;
  familyTag: string;
};

const MODELS: ModelDef[] = [
  // ─ From SWE-bench Verified seed (new) ─
  { name: "GLM-5 (high reasoning)", provider: "Zhipu AI", familyTag: "GLM-5" },
  { name: "GPT-5-2 (high reasoning)", provider: "OpenAI", familyTag: "GPT-5-2" },
  { name: "Claude 4.5 Sonnet (high reasoning)", provider: "Anthropic", familyTag: "Claude 4.5 Sonnet" },
  { name: "Kimi K2.5 (high reasoning)", provider: "Moonshot AI", familyTag: "Kimi K2.5" },
  { name: "DeepSeek V3.2 (high reasoning)", provider: "DeepSeek", familyTag: "DeepSeek V3.2" },
  { name: "Gemini 3 Pro", provider: "Google", familyTag: "Gemini 3 Pro" },
  { name: "Claude 4.5 Haiku (high reasoning)", provider: "Anthropic", familyTag: "Claude 4.5 Haiku" },
  { name: "GPT-5 mini", provider: "OpenAI", familyTag: "GPT-5 mini" },

  // ─ From safe.ai dashboard seed (new) ─
  { name: "GPT-5.4", provider: "OpenAI", familyTag: "GPT-5.4" },
  { name: "Claude Opus 4.7", provider: "Anthropic", familyTag: "Claude Opus 4.7" },
  { name: "Claude 4.5 Opus", provider: "Anthropic", familyTag: "Claude 4.5 Opus" },
  { name: "Gemini 3 Flash", provider: "Google", familyTag: "Gemini 3 Flash" },
  { name: "GPT-5.2", provider: "OpenAI", familyTag: "GPT-5.2" },
  { name: "Claude Sonnet 4.6", provider: "Anthropic", familyTag: "Claude Sonnet 4.6" },
  { name: "Grok 4.2", provider: "xAI", familyTag: "Grok 4.2" },
  { name: "GPT-5.1", provider: "OpenAI", familyTag: "GPT-5.1" },
  { name: "Kimi K2.5", provider: "Moonshot AI", familyTag: "Kimi K2.5" },
  { name: "Claude 4.5 Sonnet", provider: "Anthropic", familyTag: "Claude 4.5 Sonnet" },
  { name: "GPT-5.4 mini", provider: "OpenAI", familyTag: "GPT-5.4 mini" },
  { name: "GPT-5", provider: "OpenAI", familyTag: "GPT-5" },
  { name: "Grok 4", provider: "xAI", familyTag: "Grok 4" },
  { name: "o3", provider: "OpenAI", familyTag: "o3" },
  { name: "DeepSeek V3.2", provider: "DeepSeek", familyTag: "DeepSeek V3.2" },
  { name: "Kimi K2", provider: "Moonshot AI", familyTag: "Kimi K2" },
  { name: "Claude Sonnet 4", provider: "Anthropic", familyTag: "Claude Sonnet 4" },
  { name: "GPT-5.4 nano", provider: "OpenAI", familyTag: "GPT-5.4 nano" },
  { name: "Claude 4.5 Haiku", provider: "Anthropic", familyTag: "Claude 4.5 Haiku" },
  { name: "Gemini 2.5 Pro", provider: "Google", familyTag: "Gemini 2.5 Pro" },
  { name: "Gemini 3.1 Flash-Lite", provider: "Google", familyTag: "Gemini 3.1" },
  { name: "Grok 4 Fast", provider: "xAI", familyTag: "Grok 4 Fast" },
  { name: "Grok 4.1 Fast", provider: "xAI", familyTag: "Grok 4.1 Fast" },
  { name: "Gemini 2.5 Flash", provider: "Google", familyTag: "Gemini 2.5 Flash" },
  { name: "o3-mini", provider: "OpenAI", familyTag: "o3-mini" },
  { name: "GPT-4o", provider: "OpenAI", familyTag: "GPT-4o" },
  { name: "Gemini 2.5 Flash-Lite", provider: "Google", familyTag: "Gemini 2.5 Flash-Lite" },
  { name: "GPT-5 nano", provider: "OpenAI", familyTag: "GPT-5 nano" },
  { name: "o1", provider: "OpenAI", familyTag: "o1" },

  // ─ From Artificial Analysis tables (new) ─
  { name: "GPT-5.5 (medium)", provider: "OpenAI", familyTag: "GPT-5.5" },
  { name: "GPT-5.5 (high)", provider: "OpenAI", familyTag: "GPT-5.5" },
  { name: "GPT-5.5 (xhigh)", provider: "OpenAI", familyTag: "GPT-5.5" },
  { name: "GPT-5.5 (low)", provider: "OpenAI", familyTag: "GPT-5.5" },
  { name: "GPT-5 (high)", provider: "OpenAI", familyTag: "GPT-5" },
  { name: "GPT-5.4 mini (xhigh)", provider: "OpenAI", familyTag: "GPT-5.4 mini" },
  { name: "GPT-5.4 nano (xhigh)", provider: "OpenAI", familyTag: "GPT-5.4 nano" },
  { name: "GPT-5.2 Codex (xhigh)", provider: "OpenAI", familyTag: "GPT-5.2 Codex" },
  { name: "GPT-6.3 Codex (xhigh)", provider: "OpenAI", familyTag: "GPT-6.3 Codex" },
  { name: "Gemini 3 Pro Preview (high)", provider: "Google", familyTag: "Gemini 3 Pro" },
  { name: "Kimi K2.6", provider: "Moonshot AI", familyTag: "Kimi K2.6" },
  { name: "Qwen 3.5 397B A17B", provider: "Alibaba", familyTag: "Qwen 3.5" },
  { name: "Claude Opus 4.7 (Non-reasoning, high)", provider: "Anthropic", familyTag: "Claude Opus 4.7" },
  { name: "Claude Opus 4.6 (max)", provider: "Anthropic", familyTag: "Claude Opus 4.6" },
  { name: "Claude Sonnet 4.6 (max)", provider: "Anthropic", familyTag: "Claude Sonnet 4.6" },
  { name: "Grok 4.20 0309", provider: "xAI", familyTag: "Grok 4.20" },
  { name: "Grok 4.20 0309 v2", provider: "xAI", familyTag: "Grok 4.20" },
  { name: "Gemma 4 31B", provider: "Google", familyTag: "Gemma 4" },
  { name: "Nova 2.0 Pro Preview (medium)", provider: "Amazon", familyTag: "Nova 2.0 Pro" },
  { name: "Mistral Small 4", provider: "Mistral AI", familyTag: "Mistral Small 4" },
  { name: "DeepSeek V4 Pro (Max)", provider: "DeepSeek", familyTag: "DeepSeek V4 Pro" },
  { name: "DeepSeek V4 Flash (Max)", provider: "DeepSeek", familyTag: "DeepSeek V4 Flash" },
  { name: "MiMo V2.5 Pro", provider: "Xiaomi", familyTag: "MiMo V2.5 Pro" },
  { name: "Qwen 3.6 Max Preview", provider: "Alibaba", familyTag: "Qwen 3.6 Max" },
  { name: "Qwen 3.6 Plus", provider: "Alibaba", familyTag: "Qwen 3.6 Plus" },
  { name: "MiniMax M2.7", provider: "MiniMax", familyTag: "MiniMax M2.7" },
  { name: "GLM-5", provider: "Zhipu AI", familyTag: "GLM-5" },
  { name: "GLM-5.1", provider: "Zhipu AI", familyTag: "GLM-5.1" },
  { name: "GLM-5 Turbo", provider: "Zhipu AI", familyTag: "GLM-5 Turbo" },
  { name: "GLM-5V Turbo", provider: "Zhipu AI", familyTag: "GLM-5V Turbo" },
  { name: "GLM-4.7 Flash", provider: "Zhipu AI", familyTag: "GLM-4.7 Flash" },
  { name: "NVIDIA Nemotron 3 Super", provider: "NVIDIA", familyTag: "Nemotron 3" },
  { name: "gpt-oss-120B (high)", provider: "OpenAI", familyTag: "gpt-oss 120B" },
  { name: "gpt-oss-20B (high)", provider: "OpenAI", familyTag: "gpt-oss 20B" },
  { name: "Solar Pro 3", provider: "Upstage", familyTag: "Solar Pro 3" },
  { name: "KAT-Coder-Pro V1", provider: "Kuaishou", familyTag: "KAT-Coder-Pro" },
];

// ── Score entries ───────────────────────────────────────────
//
// Each entry's `modelName` must match either an existing DB model name
// or a name from MODELS above; `benchSlug` must match either an existing
// bench slug or one generated from BENCHES above. Duplicate
// (modelName, benchSlug, sourceUrl) tuples are skipped at insert time.
type ScoreEntry = {
  modelName: string;
  benchSlug: string;
  pct: number;
  sourceUrl: string;
};

// ── SWE-bench Verified (existing bench) ─
// Existing scores in prod were inserted with the same sourceUrl and
// will be skipped by the dedup check.
const SCORES_SWEBENCH: ScoreEntry[] = [
  { modelName: "Claude 4.5 Opus (high reasoning)", benchSlug: "swe-bench-verified", pct: 76.8, sourceUrl: SRC_SWEBENCH },
  { modelName: "Gemini 3 Flash (high reasoning)", benchSlug: "swe-bench-verified", pct: 75.8, sourceUrl: SRC_SWEBENCH },
  { modelName: "MiniMax M2.5 (high reasoning)", benchSlug: "swe-bench-verified", pct: 75.8, sourceUrl: SRC_SWEBENCH },
  { modelName: "Claude Opus 4.6", benchSlug: "swe-bench-verified", pct: 75.6, sourceUrl: SRC_SWEBENCH },
  { modelName: "GPT-5-2 Codex", benchSlug: "swe-bench-verified", pct: 72.8, sourceUrl: SRC_SWEBENCH },
  { modelName: "GLM-5 (high reasoning)", benchSlug: "swe-bench-verified", pct: 72.8, sourceUrl: SRC_SWEBENCH },
  { modelName: "GPT-5-2 (high reasoning)", benchSlug: "swe-bench-verified", pct: 72.8, sourceUrl: SRC_SWEBENCH },
  // "GPT 5.2 Codex / 72.80" → mapped to existing "GPT-5-2 Codex" per user clarification (skip dupe).
  { modelName: "Claude 4.5 Sonnet (high reasoning)", benchSlug: "swe-bench-verified", pct: 71.4, sourceUrl: SRC_SWEBENCH },
  { modelName: "Kimi K2.5 (high reasoning)", benchSlug: "swe-bench-verified", pct: 70.8, sourceUrl: SRC_SWEBENCH },
  { modelName: "DeepSeek V3.2 (high reasoning)", benchSlug: "swe-bench-verified", pct: 70.0, sourceUrl: SRC_SWEBENCH },
  { modelName: "Gemini 3 Pro", benchSlug: "swe-bench-verified", pct: 69.6, sourceUrl: SRC_SWEBENCH },
  { modelName: "Claude 4.5 Haiku (high reasoning)", benchSlug: "swe-bench-verified", pct: 66.6, sourceUrl: SRC_SWEBENCH },
  { modelName: "GPT-5 mini", benchSlug: "swe-bench-verified", pct: 56.2, sourceUrl: SRC_SWEBENCH },
];

// ── safe.ai dashboard table 1 ─
// Columns: HLE / ARC-AGI-2 / SWE-Bench Pro / TextQuests
type Safe1Row = { model: string; hle: number; arc: number; swe: number; tq: number };
const SAFEAI_TABLE_1: Safe1Row[] = [
  { model: "Gemini 3.1 Pro Preview", hle: 45.9, arc: 73.3, swe: 46.7, tq: 45.8 },
  { model: "GPT-5.4", hle: 40.3, arc: 65.0, swe: 49.7, tq: 42.2 },
  { model: "Claude Opus 4.7", hle: 39.0, arc: 50.8, swe: 60.9, tq: 37.0 },
  { model: "Claude Opus 4.6", hle: 34.2, arc: 44.3, swe: 56.7, tq: 40.8 },
  { model: "Gemini 3 Pro", hle: 38.3, arc: 31.1, swe: 43.3, tq: 41.0 },
  { model: "Claude 4.5 Opus", hle: 25.8, arc: 30.6, swe: 51.4, tq: 38.7 },
  { model: "Gemini 3 Flash", hle: 36.6, arc: 30.8, swe: 38.6, tq: 36.4 },
  { model: "GPT-5.2", hle: 29.9, arc: 38.3, swe: 29.9, tq: 37.0 },
  { model: "Claude Sonnet 4.6", hle: 21.1, arc: 24.2, swe: 53.8, tq: 31.5 },
  { model: "Grok 4.2", hle: 30.2, arc: 55.0, swe: 26.3, tq: 18.5 },
  { model: "GPT-5.1", hle: 27.2, arc: 17.6, swe: 37.0, tq: 34.2 },
  { model: "Kimi K2.5", hle: 25.4, arc: 10.8, swe: 44.0, tq: 24.4 },
  { model: "Claude 4.5 Sonnet", hle: 14.7, arc: 13.6, swe: 42.4, tq: 31.0 },
  { model: "GPT-5.4 mini", hle: 23.5, arc: 5.8, swe: 37.9, tq: 29.6 },
  { model: "GPT-5", hle: 25.3, arc: 9.9, swe: 18.2, tq: 30.0 },
  { model: "Grok 4", hle: 24.5, arc: 16.0, swe: 15.0, tq: 27.8 },
  { model: "o3", hle: 20.3, arc: 6.5, swe: 24.4, tq: 30.9 },
  { model: "DeepSeek V3.2", hle: 21.8, arc: 5.0, swe: 33.1, tq: 21.2 },
  { model: "Kimi K2", hle: 21.4, arc: 5.0, swe: 27.7, tq: 18.3 },
  { model: "Claude Sonnet 4", hle: 9.6, arc: 5.9, swe: 32.1, tq: 24.7 },
  { model: "GPT-5.4 nano", hle: 18.6, arc: 3.3, swe: 36.1, tq: 13.7 },
  { model: "Claude 4.5 Haiku", hle: 9.7, arc: 4.0, swe: 41.0, tq: 15.1 },
  { model: "Gemini 2.5 Pro", hle: 21.6, arc: 4.0, swe: 18.1, tq: 23.2 },
  { model: "Gemini 3.1 Flash-Lite", hle: 17.4, arc: 2.5, swe: 24.4, tq: 18.8 },
  { model: "GPT-5 mini", hle: 19.4, arc: 4.4, swe: 15.9, tq: 17.6 },
  { model: "Grok 4 Fast", hle: 17.8, arc: 3.3, swe: 12.0, tq: 20.1 },
  { model: "Grok 4.1 Fast", hle: 18.4, arc: 6.7, swe: 10.7, tq: 16.4 },
  { model: "Gemini 2.5 Flash", hle: 12.1, arc: 2.5, swe: 7.1, tq: 14.4 },
  { model: "o3-mini", hle: 13.4, arc: 3.0, swe: 3.1, tq: 11.9 },
  { model: "GPT-4o", hle: 2.7, arc: 0.0, swe: 4.9, tq: 13.1 },
  { model: "Gemini 2.5 Flash-Lite", hle: 6.7, arc: 0.0, swe: 2.1, tq: 11.7 },
  { model: "GPT-5 nano", hle: 8.2, arc: 2.6, swe: 7.1, tq: 1.2 },
];

// ── safe.ai dashboard table 2 ─
// Columns: ERQA / MindCube / SpatialViz / IntPhys 2 / EnigmaEval
type Safe2Row = {
  model: string;
  erqa: number;
  mindcube: number;
  spatialviz: number;
  intphys: number;
  enigma: number;
};
const SAFEAI_TABLE_2: Safe2Row[] = [
  { model: "Gemini 3.1 Pro Preview", erqa: 74.2, mindcube: 84.1, spatialviz: 66.1, intphys: 53.6, enigma: 32.4 },
  { model: "Gemini 3 Flash", erqa: 71.0, mindcube: 78.3, spatialviz: 65.3, intphys: 63.4, enigma: 18.3 },
  { model: "GPT-5.4", erqa: 64.8, mindcube: 70.4, spatialviz: 69.3, intphys: 56.4, enigma: 27.6 },
  { model: "Gemini 3 Pro", erqa: 70.2, mindcube: 77.3, spatialviz: 63.2, intphys: 56.9, enigma: 17.8 },
  { model: "GPT-5.2", erqa: 60.7, mindcube: 61.7, spatialviz: 65.8, intphys: 58.3, enigma: 14.5 },
  { model: "Claude Opus 4.7", erqa: 58.1, mindcube: 63.9, spatialviz: 62.6, intphys: 56.0, enigma: 15.6 },
  { model: "Grok 4.2", erqa: 59.1, mindcube: 67.7, spatialviz: 45.6, intphys: 62.6, enigma: 7.7 },
  { model: "GPT-5", erqa: 58.8, mindcube: 59.7, spatialviz: 54.1, intphys: 56.1, enigma: 10.5 },
  { model: "Claude Opus 4.6", erqa: 54.8, mindcube: 67.0, spatialviz: 55.7, intphys: 53.6, enigma: 7.6 },
  { model: "GPT-5 mini", erqa: 56.5, mindcube: 61.1, spatialviz: 52.5, intphys: 59.2, enigma: 8.2 },
  { model: "GPT-5.1", erqa: 59.8, mindcube: 62.0, spatialviz: 51.3, intphys: 52.0, enigma: 11.7 },
  { model: "GPT-5.4 mini", erqa: 58.0, mindcube: 56.5, spatialviz: 59.6, intphys: 52.0, enigma: 6.9 },
  { model: "Claude Sonnet 4.6", erqa: 56.6, mindcube: 60.0, spatialviz: 54.9, intphys: 50.8, enigma: 9.1 },
  { model: "o3", erqa: 57.0, mindcube: 57.6, spatialviz: 47.7, intphys: 54.7, enigma: 11.9 },
  { model: "Gemini 2.5 Pro", erqa: 60.8, mindcube: 59.6, spatialviz: 46.6, intphys: 56.0, enigma: 5.6 },
  { model: "Claude 4.5 Opus", erqa: 54.0, mindcube: 61.2, spatialviz: 43.0, intphys: 56.3, enigma: 12.4 },
  { model: "Gemini 3.1 Flash-Lite", erqa: 61.7, mindcube: 53.9, spatialviz: 44.8, intphys: 58.4, enigma: 4.6 },
  { model: "Claude 4.5 Sonnet", erqa: 50.3, mindcube: 58.3, spatialviz: 41.6, intphys: 56.3, enigma: 6.0 },
  { model: "Grok 4", erqa: 50.1, mindcube: 64.7, spatialviz: 34.8, intphys: 54.9, enigma: 7.8 },
  { model: "Gemini 2.5 Flash", erqa: 53.7, mindcube: 53.0, spatialviz: 38.2, intphys: 58.0, enigma: 2.7 },
  { model: "o1", erqa: 53.3, mindcube: 51.2, spatialviz: 41.4, intphys: 53.1, enigma: 5.7 },
  { model: "Grok 4.1 Fast", erqa: 46.3, mindcube: 52.7, spatialviz: 38.5, intphys: 55.0, enigma: 5.2 },
  { model: "Gemini 2.5 Flash-Lite", erqa: 51.0, mindcube: 49.2, spatialviz: 35.2, intphys: 54.1, enigma: 0.8 },
  { model: "Grok 4 Fast", erqa: 42.9, mindcube: 50.6, spatialviz: 36.8, intphys: 53.4, enigma: 4.7 },
  { model: "Claude 4.5 Haiku", erqa: 44.6, mindcube: 50.4, spatialviz: 38.4, intphys: 51.9, enigma: 2.3 },
  { model: "GPT-5.4 nano", erqa: 45.5, mindcube: 40.9, spatialviz: 44.6, intphys: 50.8, enigma: 4.9 },
  { model: "GPT-5 nano", erqa: 41.8, mindcube: 40.3, spatialviz: 35.7, intphys: 51.0, enigma: 2.9 },
  { model: "GPT-4o", erqa: 47.0, mindcube: 38.0, spatialviz: 31.1, intphys: 53.0, enigma: 0.8 },
];

const SCORES_SAFEAI: ScoreEntry[] = [
  ...SAFEAI_TABLE_1.flatMap((r) => [
    { modelName: r.model, benchSlug: "humanity-s-last-exam", pct: r.hle, sourceUrl: SRC_SAFEAI },
    { modelName: r.model, benchSlug: "arc-agi-2", pct: r.arc, sourceUrl: SRC_SAFEAI },
    { modelName: r.model, benchSlug: "swe-bench-pro", pct: r.swe, sourceUrl: SRC_SAFEAI },
    { modelName: r.model, benchSlug: "textquests", pct: r.tq, sourceUrl: SRC_SAFEAI },
  ]),
  ...SAFEAI_TABLE_2.flatMap((r) => [
    { modelName: r.model, benchSlug: "erqa", pct: r.erqa, sourceUrl: SRC_SAFEAI },
    { modelName: r.model, benchSlug: "mindcube", pct: r.mindcube, sourceUrl: SRC_SAFEAI },
    { modelName: r.model, benchSlug: "spatialviz", pct: r.spatialviz, sourceUrl: SRC_SAFEAI },
    { modelName: r.model, benchSlug: "intphys-2", pct: r.intphys, sourceUrl: SRC_SAFEAI },
    { modelName: r.model, benchSlug: "enigmaeval", pct: r.enigma, sourceUrl: SRC_SAFEAI },
  ]),
];

// ── Artificial Analysis tables ─
// Each row is one (model, score) pair on the named benchmark.
// Duplicates within a section (where the source page repeats a model
// across reasoning-effort columns) keep the FIRST occurrence only.
const SCORES_AA: ScoreEntry[] = [
  // MMMU-Pro (scale 0–100, integer percentages)
  { modelName: "Gemini 3.1 Pro Preview", benchSlug: "mmmu-pro", pct: 82, sourceUrl: SRC_AA_MMMU },
  { modelName: "GPT-5.5 (medium)", benchSlug: "mmmu-pro", pct: 81, sourceUrl: SRC_AA_MMMU },
  { modelName: "GPT-5.5 (high)", benchSlug: "mmmu-pro", pct: 81, sourceUrl: SRC_AA_MMMU },
  { modelName: "Muse Spark", benchSlug: "mmmu-pro", pct: 81, sourceUrl: SRC_AA_MMMU },
  { modelName: "Gemini 3 Pro Preview (high)", benchSlug: "mmmu-pro", pct: 80, sourceUrl: SRC_AA_MMMU },
  { modelName: "GPT-5.5 (xhigh)", benchSlug: "mmmu-pro", pct: 80, sourceUrl: SRC_AA_MMMU },
  { modelName: "Gemini 3 Flash", benchSlug: "mmmu-pro", pct: 80, sourceUrl: SRC_AA_MMMU },
  { modelName: "Kimi K2.6", benchSlug: "mmmu-pro", pct: 79, sourceUrl: SRC_AA_MMMU },
  { modelName: "GPT-5.5 (low)", benchSlug: "mmmu-pro", pct: 79, sourceUrl: SRC_AA_MMMU },
  { modelName: "GPT-5.4 (xhigh)", benchSlug: "mmmu-pro", pct: 78, sourceUrl: SRC_AA_MMMU },
  { modelName: "Qwen 3.5 397B A17B", benchSlug: "mmmu-pro", pct: 77, sourceUrl: SRC_AA_MMMU },
  { modelName: "Claude Opus 4.7 (Non-reasoning, high)", benchSlug: "mmmu-pro", pct: 76, sourceUrl: SRC_AA_MMMU },
  { modelName: "Claude Opus 4.6 (max)", benchSlug: "mmmu-pro", pct: 75, sourceUrl: SRC_AA_MMMU },
  { modelName: "Grok 4.20 0309 v2", benchSlug: "mmmu-pro", pct: 75, sourceUrl: SRC_AA_MMMU },
  { modelName: "Gemma 4 31B", benchSlug: "mmmu-pro", pct: 73, sourceUrl: SRC_AA_MMMU },
  { modelName: "GPT-5.4 mini (xhigh)", benchSlug: "mmmu-pro", pct: 73, sourceUrl: SRC_AA_MMMU },
  { modelName: "Claude Sonnet 4.6 (max)", benchSlug: "mmmu-pro", pct: 73, sourceUrl: SRC_AA_MMMU },
  { modelName: "Grok 4.20 0309", benchSlug: "mmmu-pro", pct: 73, sourceUrl: SRC_AA_MMMU },
  { modelName: "Nova 2.0 Pro Preview (medium)", benchSlug: "mmmu-pro", pct: 65, sourceUrl: SRC_AA_MMMU },
  { modelName: "Claude 4.5 Haiku", benchSlug: "mmmu-pro", pct: 59, sourceUrl: SRC_AA_MMMU },
  { modelName: "Mistral Small 4", benchSlug: "mmmu-pro", pct: 57, sourceUrl: SRC_AA_MMMU },

  // Humanity's Last Exam (scale 0–1000, 1-decimal percentages)
  // Per user clarification, AA scores are submitted alongside the existing
  // safe.ai scores — both submissions are kept.
  { modelName: "Gemini 3.1 Pro Preview", benchSlug: "humanity-s-last-exam", pct: 44.7, sourceUrl: SRC_AA_HLE },
  { modelName: "GPT-5.5 (xhigh)", benchSlug: "humanity-s-last-exam", pct: 44.3, sourceUrl: SRC_AA_HLE },
  { modelName: "GPT-5.5 (high)", benchSlug: "humanity-s-last-exam", pct: 43.0, sourceUrl: SRC_AA_HLE },
  { modelName: "GPT-5.4 (xhigh)", benchSlug: "humanity-s-last-exam", pct: 41.6, sourceUrl: SRC_AA_HLE },
  { modelName: "GPT-5.5 (medium)", benchSlug: "humanity-s-last-exam", pct: 40.6, sourceUrl: SRC_AA_HLE },
  { modelName: "GPT-5.3 Codex (xhigh)", benchSlug: "humanity-s-last-exam", pct: 39.9, sourceUrl: SRC_AA_HLE },
  { modelName: "Muse Spark", benchSlug: "humanity-s-last-exam", pct: 39.9, sourceUrl: SRC_AA_HLE },
  { modelName: "Claude Opus 4.7 (max)", benchSlug: "humanity-s-last-exam", pct: 39.6, sourceUrl: SRC_AA_HLE },
  { modelName: "Gemini 3 Pro Preview (high)", benchSlug: "humanity-s-last-exam", pct: 37.2, sourceUrl: SRC_AA_HLE },
  { modelName: "Claude Opus 4.6 (max)", benchSlug: "humanity-s-last-exam", pct: 36.7, sourceUrl: SRC_AA_HLE },
  { modelName: "DeepSeek V4 Pro (Max)", benchSlug: "humanity-s-last-exam", pct: 35.9, sourceUrl: SRC_AA_HLE },
  { modelName: "Kimi K2.6", benchSlug: "humanity-s-last-exam", pct: 35.9, sourceUrl: SRC_AA_HLE },
  { modelName: "Gemini 3 Flash", benchSlug: "humanity-s-last-exam", pct: 34.7, sourceUrl: SRC_AA_HLE },
  { modelName: "MiMo V2.5 Pro", benchSlug: "humanity-s-last-exam", pct: 33.8, sourceUrl: SRC_AA_HLE },
  { modelName: "Grok 4.20 0309 v2", benchSlug: "humanity-s-last-exam", pct: 32.2, sourceUrl: SRC_AA_HLE },
  { modelName: "DeepSeek V4 Flash (Max)", benchSlug: "humanity-s-last-exam", pct: 32.1, sourceUrl: SRC_AA_HLE },
  { modelName: "Claude Sonnet 4.6 (max)", benchSlug: "humanity-s-last-exam", pct: 30.0, sourceUrl: SRC_AA_HLE },
  { modelName: "Qwen 3.6 Max Preview", benchSlug: "humanity-s-last-exam", pct: 28.9, sourceUrl: SRC_AA_HLE },
  { modelName: "MiniMax M2.7", benchSlug: "humanity-s-last-exam", pct: 28.1, sourceUrl: SRC_AA_HLE },
  { modelName: "GLM-5.1", benchSlug: "humanity-s-last-exam", pct: 28.0, sourceUrl: SRC_AA_HLE },
  { modelName: "Qwen 3.5 397B A17B", benchSlug: "humanity-s-last-exam", pct: 27.3, sourceUrl: SRC_AA_HLE },
  { modelName: "GPT-5.4 mini (xhigh)", benchSlug: "humanity-s-last-exam", pct: 26.6, sourceUrl: SRC_AA_HLE },
  { modelName: "Gemma 4 31B", benchSlug: "humanity-s-last-exam", pct: 22.7, sourceUrl: SRC_AA_HLE },
  { modelName: "DeepSeek V3.2", benchSlug: "humanity-s-last-exam", pct: 22.2, sourceUrl: SRC_AA_HLE },
  { modelName: "NVIDIA Nemotron 3 Super", benchSlug: "humanity-s-last-exam", pct: 19.2, sourceUrl: SRC_AA_HLE },
  { modelName: "gpt-oss-120B (high)", benchSlug: "humanity-s-last-exam", pct: 18.5, sourceUrl: SRC_AA_HLE },
  { modelName: "Solar Pro 3", benchSlug: "humanity-s-last-exam", pct: 10.1, sourceUrl: SRC_AA_HLE },
  { modelName: "gpt-oss-20B (high)", benchSlug: "humanity-s-last-exam", pct: 9.8, sourceUrl: SRC_AA_HLE },
  { modelName: "Claude 4.5 Haiku", benchSlug: "humanity-s-last-exam", pct: 9.7, sourceUrl: SRC_AA_HLE },
  { modelName: "Mistral Small 4", benchSlug: "humanity-s-last-exam", pct: 9.5, sourceUrl: SRC_AA_HLE },

  // AA Long Context Reasoning (scale 0–1000)
  { modelName: "GPT-5.2 Codex (xhigh)", benchSlug: "aa-long-context-reasoning", pct: 75.7, sourceUrl: SRC_AA_LCR },
  { modelName: "GPT-5 (high)", benchSlug: "aa-long-context-reasoning", pct: 75.6, sourceUrl: SRC_AA_LCR },
  { modelName: "GPT-5.1", benchSlug: "aa-long-context-reasoning", pct: 75.0, sourceUrl: SRC_AA_LCR },
  { modelName: "GPT-5.5 (xhigh)", benchSlug: "aa-long-context-reasoning", pct: 74.3, sourceUrl: SRC_AA_LCR },
  { modelName: "GPT-5.4 (xhigh)", benchSlug: "aa-long-context-reasoning", pct: 74.0, sourceUrl: SRC_AA_LCR },
  { modelName: "GPT-6.3 Codex (xhigh)", benchSlug: "aa-long-context-reasoning", pct: 74.0, sourceUrl: SRC_AA_LCR },
  { modelName: "KAT-Coder-Pro V1", benchSlug: "aa-long-context-reasoning", pct: 74.0, sourceUrl: SRC_AA_LCR },
  // "Claude Opus 4.5" → canonical "Claude 4.5 Opus".
  { modelName: "Claude 4.5 Opus", benchSlug: "aa-long-context-reasoning", pct: 74.0, sourceUrl: SRC_AA_LCR },
  { modelName: "GPT-5.5 (high)", benchSlug: "aa-long-context-reasoning", pct: 73.3, sourceUrl: SRC_AA_LCR },
  { modelName: "MiMo V2.5 Pro", benchSlug: "aa-long-context-reasoning", pct: 73.3, sourceUrl: SRC_AA_LCR },
  { modelName: "Gemini 3.1 Pro Preview", benchSlug: "aa-long-context-reasoning", pct: 72.7, sourceUrl: SRC_AA_LCR },
  { modelName: "Claude Sonnet 4.6 (max)", benchSlug: "aa-long-context-reasoning", pct: 70.7, sourceUrl: SRC_AA_LCR },
  { modelName: "Claude 4.5 Haiku", benchSlug: "aa-long-context-reasoning", pct: 70.3, sourceUrl: SRC_AA_LCR },
  { modelName: "Claude Opus 4.7 (max)", benchSlug: "aa-long-context-reasoning", pct: 70.3, sourceUrl: SRC_AA_LCR },

  // SciCode (scale 0–1000)
  { modelName: "Gemini 3.1 Pro Preview", benchSlug: "scicode", pct: 58.9, sourceUrl: SRC_AA_SCICODE },
  { modelName: "GPT-5.4 (xhigh)", benchSlug: "scicode", pct: 56.6, sourceUrl: SRC_AA_SCICODE },
  { modelName: "GPT-5.5 (xhigh)", benchSlug: "scicode", pct: 56.1, sourceUrl: SRC_AA_SCICODE },
  { modelName: "Gemini 3 Pro Preview (high)", benchSlug: "scicode", pct: 56.1, sourceUrl: SRC_AA_SCICODE },
  { modelName: "GPT-5.5 (high)", benchSlug: "scicode", pct: 55.9, sourceUrl: SRC_AA_SCICODE },
  { modelName: "GPT-5.2 Codex (xhigh)", benchSlug: "scicode", pct: 54.6, sourceUrl: SRC_AA_SCICODE },
  { modelName: "Claude Opus 4.7 (max)", benchSlug: "scicode", pct: 54.5, sourceUrl: SRC_AA_SCICODE },
  { modelName: "GPT-5.5 (medium)", benchSlug: "scicode", pct: 53.5, sourceUrl: SRC_AA_SCICODE },
  { modelName: "Kimi K2.6", benchSlug: "scicode", pct: 53.5, sourceUrl: SRC_AA_SCICODE },
  { modelName: "GPT-5.3 Codex (xhigh)", benchSlug: "scicode", pct: 53.2, sourceUrl: SRC_AA_SCICODE },
  { modelName: "Muse Spark", benchSlug: "scicode", pct: 51.5, sourceUrl: SRC_AA_SCICODE },
  { modelName: "Gemini 3 Flash", benchSlug: "scicode", pct: 50.6, sourceUrl: SRC_AA_SCICODE },

  // Terminal-Bench Hard (scale 0–1000)
  { modelName: "GPT-5.5 (xhigh)", benchSlug: "terminal-bench-hard", pct: 60.6, sourceUrl: SRC_AA_TBHARD },
  { modelName: "GPT-5.5 (high)", benchSlug: "terminal-bench-hard", pct: 59.8, sourceUrl: SRC_AA_TBHARD },
  { modelName: "GPT-5.4 (xhigh)", benchSlug: "terminal-bench-hard", pct: 57.6, sourceUrl: SRC_AA_TBHARD },
  { modelName: "GPT-5.5 (medium)", benchSlug: "terminal-bench-hard", pct: 57.6, sourceUrl: SRC_AA_TBHARD },
  { modelName: "Claude Opus 4.7 (Non-reasoning, high)", benchSlug: "terminal-bench-hard", pct: 54.5, sourceUrl: SRC_AA_TBHARD },
  { modelName: "Gemini 3.1 Pro Preview", benchSlug: "terminal-bench-hard", pct: 53.8, sourceUrl: SRC_AA_TBHARD },
  { modelName: "GPT-5.3 Codex (xhigh)", benchSlug: "terminal-bench-hard", pct: 53.0, sourceUrl: SRC_AA_TBHARD },
  { modelName: "Claude Sonnet 4.6 (max)", benchSlug: "terminal-bench-hard", pct: 53.0, sourceUrl: SRC_AA_TBHARD },
  { modelName: "GPT-5.5 (low)", benchSlug: "terminal-bench-hard", pct: 52.3, sourceUrl: SRC_AA_TBHARD },
  { modelName: "GPT-5.4 mini (xhigh)", benchSlug: "terminal-bench-hard", pct: 52.3, sourceUrl: SRC_AA_TBHARD },
  { modelName: "Claude Opus 4.7 (max)", benchSlug: "terminal-bench-hard", pct: 51.5, sourceUrl: SRC_AA_TBHARD },

  // Tau²-Bench Telecom (scale 0–1000)
  // The seed text repeats a few models with a second value (likely
  // different reasoning-effort columns); only the first occurrence is
  // submitted to avoid silently choosing one variant over the other.
  { modelName: "GLM-4.7 Flash", benchSlug: "tau2-bench-telecom", pct: 98.8, sourceUrl: SRC_AA_TAU },
  { modelName: "GLM-5 Turbo", benchSlug: "tau2-bench-telecom", pct: 98.5, sourceUrl: SRC_AA_TAU },
  { modelName: "GLM-5V Turbo", benchSlug: "tau2-bench-telecom", pct: 98.5, sourceUrl: SRC_AA_TAU },
  { modelName: "GLM-5", benchSlug: "tau2-bench-telecom", pct: 98.2, sourceUrl: SRC_AA_TAU },
  { modelName: "GLM-5.1", benchSlug: "tau2-bench-telecom", pct: 97.7, sourceUrl: SRC_AA_TAU },
  { modelName: "Qwen 3.6 Plus", benchSlug: "tau2-bench-telecom", pct: 97.7, sourceUrl: SRC_AA_TAU },
  { modelName: "Grok 4.20 0309", benchSlug: "tau2-bench-telecom", pct: 96.5, sourceUrl: SRC_AA_TAU },
  { modelName: "DeepSeek V4 Pro (Max)", benchSlug: "tau2-bench-telecom", pct: 96.2, sourceUrl: SRC_AA_TAU },
  { modelName: "Kimi K2.6", benchSlug: "tau2-bench-telecom", pct: 95.9, sourceUrl: SRC_AA_TAU },
  { modelName: "Gemini 3.1 Pro Preview", benchSlug: "tau2-bench-telecom", pct: 95.6, sourceUrl: SRC_AA_TAU },

  // APEX-Agents-AA (scale 0–1000)
  { modelName: "GPT-5.5 (xhigh)", benchSlug: "apex-agents-aa", pct: 37.7, sourceUrl: SRC_AA_APEX },
  { modelName: "GPT-5.4 (xhigh)", benchSlug: "apex-agents-aa", pct: 33.3, sourceUrl: SRC_AA_APEX },
  { modelName: "Claude Opus 4.6 (max)", benchSlug: "apex-agents-aa", pct: 33.0, sourceUrl: SRC_AA_APEX },
  { modelName: "Gemini 3.1 Pro Preview", benchSlug: "apex-agents-aa", pct: 32.0, sourceUrl: SRC_AA_APEX },
  { modelName: "GPT-5.4 mini (xhigh)", benchSlug: "apex-agents-aa", pct: 28.2, sourceUrl: SRC_AA_APEX },
  { modelName: "Claude Sonnet 4.6 (max)", benchSlug: "apex-agents-aa", pct: 28.0, sourceUrl: SRC_AA_APEX },
  { modelName: "Gemini 3 Flash", benchSlug: "apex-agents-aa", pct: 27.7, sourceUrl: SRC_AA_APEX },
  { modelName: "GPT-5.4 nano (xhigh)", benchSlug: "apex-agents-aa", pct: 24.9, sourceUrl: SRC_AA_APEX },
  { modelName: "Qwen 3.5 397B A17B", benchSlug: "apex-agents-aa", pct: 15.3, sourceUrl: SRC_AA_APEX },
  { modelName: "DeepSeek V3.2", benchSlug: "apex-agents-aa", pct: 14.5, sourceUrl: SRC_AA_APEX },
  { modelName: "GLM-5", benchSlug: "apex-agents-aa", pct: 14.5, sourceUrl: SRC_AA_APEX },
  { modelName: "Grok 4.20 0309", benchSlug: "apex-agents-aa", pct: 14.2, sourceUrl: SRC_AA_APEX },

  // GDPval-AA Leaderboard: skipped per user clarification (Elo doesn't
  // fit the percentage-based SupraScore model).
];

const ALL_SCORES: ScoreEntry[] = [
  ...SCORES_SWEBENCH,
  ...SCORES_SAFEAI,
  ...SCORES_AA,
];

// ── Idempotent admin lookup ─────────────────────────────────
async function findAdminUserId(ctx: any): Promise<Id<"users">> {
  const users = await ctx.db.query("users").take(5000);
  const admin = users.find(
    (u: any) => (u.email ?? "") === PRIMARY_ADMIN_EMAIL
  );
  if (!admin) {
    throw new Error(
      `Primary admin user (${PRIMARY_ADMIN_EMAIL}) not found in users table — sign in once before seeding.`
    );
  }
  return admin._id as Id<"users">;
}

// ── Step 1: insert missing benches ──────────────────────────
export const seedBenches = internalMutation({
  args: {},
  handler: async (ctx) => {
    const adminId = await findAdminUserId(ctx);

    const existing = await ctx.db.query("benches").collect();
    const slugSet = new Set(existing.map((b) => b.slug));

    const created: { slug: string; name: string }[] = [];
    for (const def of BENCHES) {
      const slug = generateSlug(def.name);
      if (slugSet.has(slug)) continue;
      const url = normalizePublicHttpUrl(def.url);

      const benchId = await ctx.db.insert("benches", {
        name: def.name,
        slug,
        description: def.description,
        url,
        isOfficial: isOfficialUrl(url),
        tags: [],
        scaleMin: def.scaleMin,
        scaleMax: def.scaleMax,
        addedBy: adminId,
        createdAt: Date.now(),
      });
      slugSet.add(slug);
      await seedCreatorEntityVote(
        ctx,
        "bench",
        benchId as unknown as string,
        adminId
      );

      const seen = new Set<string>();
      for (const raw of def.tags) {
        const t = raw.trim().toLowerCase();
        if (!t || t.length > 30 || seen.has(t)) continue;
        seen.add(t);
        await ctx.db.insert("tagVotes", {
          entityType: "bench",
          entityId: benchId as unknown as string,
          tag: t,
          userId: adminId,
          value: 1,
        });
      }
      await recomputeEffectiveTags(
        ctx,
        "bench",
        benchId as unknown as string
      );
      created.push({ slug, name: def.name });
    }
    return { createdBenches: created.length, names: created.map((c) => c.name) };
  },
});

// ── Step 2: insert missing models ───────────────────────────
export const seedModels = internalMutation({
  args: {},
  handler: async (ctx) => {
    const adminId = await findAdminUserId(ctx);

    const existing = await ctx.db.query("models").collect();
    const nameSet = new Set(existing.map((m) => m.name));
    const slugSet = new Set(existing.map((m) => m.slug));

    const created: string[] = [];
    for (const def of MODELS) {
      if (nameSet.has(def.name)) continue;

      let slug = generateSlug(def.name);
      let counter = 2;
      while (slugSet.has(slug)) {
        slug = `${generateSlug(def.name)}-${counter}`;
        counter++;
      }

      const modelId = await ctx.db.insert("models", {
        name: def.name,
        provider: def.provider,
        slug,
        familyTag: def.familyTag,
        tags: [],
        addedBy: adminId,
        createdAt: Date.now(),
      });

      await ctx.db.insert("modelRankings", {
        modelId,
        name: def.name,
        provider: def.provider,
        slug,
        familyTag: def.familyTag,
        tags: [],
        supraScore: 0,
        benchCount: 0,
        updatedAt: Date.now(),
        hidden: false,
      });

      await seedCreatorEntityVote(
        ctx,
        "model",
        modelId as unknown as string,
        adminId
      );

      nameSet.add(def.name);
      slugSet.add(slug);
      created.push(def.name);
    }
    return { createdModels: created.length, names: created };
  },
});

// ── Step 3: insert missing scores ───────────────────────────
//
// Splits SCORES into chunks so each invocation stays well under
// Convex's per-mutation limits. `chunk` is 0-indexed; the final chunk
// is detected when no scores remain. Returns `{ done: true }` once
// every chunk has been processed.
const SCORE_CHUNK_SIZE = 100;

export const seedScores = internalMutation({
  args: {},
  handler: async (ctx) => {
    const adminId = await findAdminUserId(ctx);
    const submitter = await ctx.db.get(adminId);

    const allBenches = await ctx.db.query("benches").collect();
    const benchBySlug = new Map<string, any>();
    for (const b of allBenches) benchBySlug.set(b.slug, b);

    const allModels = await ctx.db.query("models").collect();
    const modelByName = new Map<string, any>();
    for (const m of allModels) modelByName.set(m.name, m);

    let inserted = 0;
    let skippedExisting = 0;
    const touchedBenches = new Set<string>();
    const missing: string[] = [];

    for (const e of ALL_SCORES) {
      const model = modelByName.get(e.modelName);
      const bench = benchBySlug.get(e.benchSlug);
      if (!model || !bench) {
        missing.push(
          `${e.modelName} | ${e.benchSlug} (model:${!!model} bench:${!!bench})`
        );
        continue;
      }

      const sourceUrl = normalizePublicHttpUrl(e.sourceUrl);

      const existing = await ctx.db
        .query("modelScores")
        .withIndex("by_model_bench", (q) =>
          q.eq("modelId", model._id).eq("benchId", bench._id)
        )
        .collect();
      if (existing.some((s) => s.sourceUrl === sourceUrl)) {
        skippedExisting++;
        continue;
      }

      // Convert displayed % to raw score on the bench's chosen scale.
      // For 0-100 benches → use the % directly. For 0-1000 benches →
      // multiply by 10 (so 45.9% → 459, 76.80% → 768; SWE-bench Verified
      // is 0-10000 → 76.80% → 7680). Done by linear remap from the
      // canonical [0..100] domain to the bench's [scaleMin..scaleMax].
      const rawFloat =
        bench.scaleMin + ((bench.scaleMax - bench.scaleMin) * e.pct) / 100;
      const rawScore = Math.round(rawFloat);
      if (
        !Number.isFinite(rawScore) ||
        rawScore < bench.scaleMin ||
        rawScore > bench.scaleMax
      ) {
        throw new Error(
          `Score ${rawScore} out of range for ${bench.slug} (${bench.scaleMin}–${bench.scaleMax})`
        );
      }
      const normalized =
        bench.scaleMax === bench.scaleMin
          ? 0
          : ((rawScore - bench.scaleMin) /
              (bench.scaleMax - bench.scaleMin)) *
            100;

      const scoreId = await ctx.db.insert("modelScores", {
        modelId: model._id,
        benchId: bench._id,
        rawScore,
        normalizedScore: Math.round(normalized * 100) / 100,
        sourceUrl,
        accessedAt: Date.now(),
        submittedBy: adminId,
        createdAt: Date.now(),
        upvotes: 1,
        downvotes: 0,
        submitterName: (submitter as any)?.name ?? "Florian",
        submitterImage: (submitter as any)?.image ?? undefined,
      });
      await ctx.db.insert("votes", {
        targetId: scoreId as unknown as string,
        targetType: "modelScore",
        userId: adminId,
        value: 1,
      });
      inserted++;
      touchedBenches.add(bench._id as string);

      if (inserted >= SCORE_CHUNK_SIZE) break;
    }

    return {
      inserted,
      skippedExisting,
      missing,
      touchedBenches: Array.from(touchedBenches),
      remaining: ALL_SCORES.length - inserted - skippedExisting,
    };
  },
});

// ── Step 4: refresh per-bench aggregate caches ──────────────
export const recomputeAllBenchCaches = internalMutation({
  args: {},
  handler: async (ctx) => {
    const benches = await ctx.db.query("benches").collect();
    let touched = 0;
    for (const b of benches) {
      await recomputeBenchAggregatesInline(ctx, b._id as Id<"benches">);
      touched++;
    }
    return { touched };
  },
});

// ── Step 5: rankings + family rankings ─────────────────────
//
// Full table rebuild. Run last, once every bench aggregate cache is
// fresh. rankings.recomputeAll runs the unified rebuild that
// refreshes both modelRankings and familyRankings from a single
// shared read pass — no separate family cascade required.
export const finalize = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(internal.rankings.recomputeAll, {});
    return { ok: true };
  },
});
