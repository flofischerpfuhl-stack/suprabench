# Cursor Composer Prompt — Initial Database Prefill

Paste the **entire** "Prompt" section below into Cursor Composer (or
any LLM assistant with web-browsing + file-write capability). The
prompt is self-contained — it explains the file format, the rules the
assistant must respect, where the data lives, and how to verify it.

After the assistant has populated `scripts/seed-data.json`, a human
(that's you, the project operator) runs:

```bash
node scripts/run-seed.mjs --dry-run      # format sanity check
node scripts/run-seed.mjs                # push to prod (idempotent)
# or for dev deployment:
node scripts/run-seed.mjs --dev
```

Re-running is safe — benches are deduped by slug, models by slug,
scores by `(model, bench, sourceUrl)`. Adding rows to the JSON and
re-running inserts only the delta.

---

## Prompt

> **Copy everything below this line into Cursor Composer.**

You are performing a **real-data research pass** for an AI benchmark
database called SupraBench. Your deliverable is a single file,
`scripts/seed-data.json`, that other code will then insert into the
Convex database.

This prompt is **non-negotiable about data honesty**. A human will
review every single row you produce. Rows that look fabricated,
approximate, or lifted from the wrong source will be rejected and
cost us your credibility for the rest of the task.

### 1. What you're building

An initial seed of AI-model benchmark scores covering the 15 – 20
most-cited public AI benchmarks of the last ~5 years, plus every
model on each benchmark's official leaderboard that you can verify
from a reputable source.

Minimum requirements:

- **≥ 15 benchmarks, ideally 18 – 22**. Coverage matters more than
  depth per bench, but each bench should have **at least 5 distinct
  models** scored or the bench is not interesting enough to include.
- **Every score must have a verifiable `sourceUrl`** that a human
  reviewer can open and read the number off. No "inferred from a
  benchmark roundup blog post". The URL must be the primary source.
- **No fabrication.** If you are unsure of a model's score on a bench,
  skip that model. It's better to have 8 verified models on MMLU than
  15 with 7 guesses.
- **Correct dates.** `accessedAt` must be a Unix-ms timestamp for the
  day you actually looked at the URL. Use `Date.now()` at research
  time, not the publication date of the source.
- **One upvote per submission** is baked into the loader — you do NOT
  specify upvote/downvote counts, they are always 1/0.

### 2. File format (strict)

`scripts/seed-data.json` is a JSON array of bench-entries. Each
bench-entry:

```jsonc
{
  "name": "MMLU",                         // canonical, human-readable
  "description": "One paragraph.",        // ≤ 400 chars, what the bench tests
  "url": "https://arxiv.org/abs/2009.03300", // PRIMARY source URL (paper, official leaderboard)
  "scaleMin": 0,                          // scores below this are impossible
  "scaleMax": 100,                        // scores above this are impossible
  "tags": ["reasoning", "knowledge"],     // lowercase, hyphen-separated, 2-5 tags
  "scores": [
    {
      "model": {
        "name": "GPT-4",                  // the public model name, exactly as the provider writes it
        "provider": "OpenAI",             // canonical provider name, NOT "openai" or "OPENAI"
        "familyTag": "GPT-4",             // a **short** family identifier — see §3
        "tags": ["proprietary"]           // optional extra tags for this model
      },
      "rawScore": 86.4,                   // the raw score as reported at sourceUrl
      "sourceUrl": "https://cdn.openai.com/papers/gpt-4.pdf", // where you read rawScore
      "accessedAt": 1745246400000         // Unix-ms when you captured this
    }
  ]
}
```

Top-level is an **array** (`[ … ]`). No wrapper object, no comments in
the final file (the template ships with `_comment` fields — strip them
before saving).

### 3. Taxonomy rules (match the existing DB's conventions)

Before adding a model, run this Convex query to see what's already
there:

```bash
npx convex run --prod models:listProviders
npx convex run --prod models:listFamilyTags
```

Then match the existing spelling **exactly** (case-sensitive, including
hyphens, dots and spaces).

#### Family ≈ one release. Variants are the suffix on `name`.

The DB uses a **narrow** definition of family: one family tag = one
specific model release. Variants (different sampling levels, context
windows, reasoning effort, fine-tune modes) are **not** separate
families — they all share the release's family and are disambiguated
by a **parenthetical suffix on the `name` field**.

This is NOT a grouping of model generations or vendors. "Claude 4.5
Opus" and "Claude Opus 4.6" are **separate families**. "Claude" is
NOT a family. "Opus" is NOT a family.

Live examples from the production DB (April 2026) — reuse these
spellings if the model you're adding belongs to any of them:

```text
Family tag             │ Models (name)
───────────────────────┼──────────────────────────────────────────
"Claude 4.5 Opus"      │ "Claude 4.5 Opus", "Claude 4.5 Opus (max)"
"Claude Opus 4.6"      │ "Claude Opus 4.6", "Claude Opus 4.6 (max)"
"Claude Opus 4.7"      │ "Claude Opus 4.7", "Claude Opus 4.7 (max)"
"GPT-5-2 Codex"        │ "GPT-5-2 Codex (low)", "… (med)", "… (high)", "… (xhigh)"
"GPT-5.3 Codex"        │ "GPT-5.3 Codex (low)", "… (med)", "… (high)", "… (xhigh)"
"GPT-5.4"              │ "GPT-5.4", "GPT-5.4 (thinking)"
"Gemini 3 Flash"       │ "Gemini 3 Flash", "Gemini 3 Flash (thinking)"
"Gemini 3.1"           │ "Gemini 3.1", "Gemini 3.1 (thinking)"
"MiniMax M2.5"         │ "MiniMax M2.5"
"Muse Spark"           │ "Muse Spark"
```

Rules you must follow:

- **familyTag = the release name without the variant suffix.**
  If the release has no variants, `familyTag == name`.
- **Variant suffix goes in parentheses at the end of `name`.**
  Examples of valid suffixes:
  - `(low)`, `(med)`, `(high)`, `(xhigh)` — sampling / reasoning-effort
    levels (primarily OpenAI and Anthropic).
  - `(thinking)` — explicit reasoning-mode (primarily Google, OpenAI).
  - `(max)`, `(ultra)` — provider-branded "best-effort" modes.
  - `(128k)`, `(200k)`, `(1M)` — context-length variants when the lab
    ships them as separate SKUs with measurably different benchmark
    scores.
  - `(instruct)`, `(chat)`, `(base)` — for open-weight models where
    the lab publishes multiple post-training variants.
  If a lab doesn't use a clear name variant (e.g. the release is just
  "Gemini 2.5 Pro" with no thinking/fast split reported in the source),
  `name == familyTag` and no suffix is needed.
- **Dot vs dash in the release name.** Match the lab's own
  capitalisation and punctuation exactly. `"Claude Opus 4.7"` has a
  space, `"GPT-5.3 Codex"` has a hyphen-then-dot, `"Claude 4.5 Opus"`
  puts the number before "Opus". Don't normalise these — the
  family-ranking table uses the raw string as the key, so any drift
  creates a phantom family.
- **Family is not the provider, not the generation, not the
  architecture class.** Bad:
  - `familyTag: "Claude"` ❌ (too broad — merges unrelated releases)
  - `familyTag: "Gemini 3"` ❌ (exists as `"Gemini 3 Flash"` and
    `"Gemini 3.1"` — they are separate releases)
  - `familyTag: "GPT-5 family"` ❌ (label, not release)
  - `familyTag: "Sonnet"` ❌ (line, not release)

  Good:
  - `familyTag: "Claude Opus 4.7"` ✓ (matches live DB)
  - `familyTag: "Gemini 3.1"` ✓
  - `familyTag: "o3"` if the release is just "o3" ✓

- **Provider**: prefer the spelling already in the DB. If the provider
  isn't already there, pick the version that matches the provider's
  own marketing (e.g. "Google DeepMind" for Gemini papers; "Anthropic"
  not "anthropic"; "xAI" with the lowercase x).
- **Tags on models**: broad capability labels only — `proprietary`,
  `open-weights`, `reasoning`, `multimodal`, `coding`, `small`,
  `frontier`. 2-5 tags max. If unsure, `proprietary` or `open-weights`.
- **Tags on benches**: match the bench's actual topic — `math`,
  `coding`, `reasoning`, `knowledge`, `agentic`, `multimodal`,
  `safety`, `long-context`, `factuality`, `tool-use`, `web`. 2-5 tags
  max. Avoid invented tags.

#### When you're unsure if two models belong in the same family

Ask yourself:

1. Did the lab ship them in the **same release announcement**?
   If no → separate families.
2. Do they have **measurably different benchmark scores** while the
   lab markets them as "the same model at different effort levels"?
   If yes → same family, disambiguate with a variant suffix on `name`.
3. Is one the "thinking" or "reasoning-enabled" variant of the other?
   If yes → same family, `(thinking)` suffix.

If still unsure: **put them in separate families.** A human can merge
two over-narrow families later; nobody can un-merge a bad grouping
without manual dedup.

#### "Models without a family"

If a release is a one-off with no variants and you don't expect
follow-up variants, it's perfectly fine for `familyTag == name`
(which is how "MiniMax M2.5" and "Muse Spark" look in the DB). Don't
omit the field unless the lab's own naming is genuinely non-committal
("proto-v0-preview").

### 4. Which benchmarks to include

A strong default portfolio for the 15-20 slots, ordered roughly by
how well-known they are in the community:

1. **MMLU** (knowledge + reasoning, saturated but historically important)
2. **MMLU-Pro** (harder successor, still active)
3. **GPQA / GPQA Diamond** (graduate-level science QA)
4. **HumanEval** (code completion, saturated)
5. **SWE-bench** (real GitHub issues, agentic coding)
6. **SWE-bench Verified** (OpenAI's curated subset — pick this over raw
   SWE-bench if you can verify both)
7. **HellaSwag** (common-sense reasoning, older)
8. **ARC-Challenge** or **ARC-AGI / ARC-AGI 2** (depending on recency;
   ARC-AGI is the active frontier)
9. **BIG-Bench Hard**
10. **MATH** / **MATH-500** (competition math)
11. **AIME 2024** / **AIME 2025** (olympiad math, the o-series bench of choice)
12. **GSM8K** (grade-school math, saturated)
13. **TruthfulQA** (factuality)
14. **WinoGrande** (common-sense reasoning)
15. **DROP** (reading comprehension)
16. **LiveCodeBench** (recent code gen, actively maintained)
17. **Aider Polyglot Coding Benchmark** (edit-based coding)
18. **SimpleBench** (community-curated, humans solve easily)
19. **Humanity's Last Exam** (HLE — frontier, Nature paper)
20. **LMArena / Chatbot Arena** (ELO leaderboard)
21. **Tau-bench** (agentic tool use)
22. **OSWorld** (GUI agentic)

You may substitute if you find a bench is obsolete or data is too
sparse to verify. You may ADD benches if you find a popular one
missing — prefer academic + lab-official sources.

### 5. Sources — authoritative only

Use ONLY these tiers of sources. Our schema has a whitelist of
"official" domains (see `convex/urls.ts`) — URLs from these domains
get an "Official source" badge. Stick to them.

**Tier 1 (preferred):**
- The paper itself on `arxiv.org`, `openreview.net`, or
  `nature.com` / `science.org` when a benchmark appears there.
- The official benchmark project site (`arcprize.org`, `swebench.com`,
  `agi.safe.ai`, `epoch.ai`, `lmarena.ai`, `livebench.ai`,
  `livecodebench.github.io`, `aider.chat`, `simple-bench.com`,
  `osworld.ai`, etc.)
- Official model-lab reports / blog posts / model cards
  (`openai.com`, `anthropic.com`, `deepmind.google`, `x.ai`,
  `ai.meta.com`, `mistral.ai`, `qwenlm.github.io`, `deepseek.com`,
  `moonshot.cn`, …).
- `paperswithcode.com` leaderboard pages when they cite the primary
  source.

**Tier 2 (acceptable when nothing else has it):**
- `huggingface.co` leaderboards (OpenLLM Leaderboard)
- `artificialanalysis.ai` (they aggregate reproducibly)
- `scale.com` (their SEAL leaderboards)
- `kaggle.com` when the bench lives on Kaggle

**Not acceptable:**
- News sites, Twitter/X posts, random blog posts that aren't the lab's
  own blog.
- LinkedIn, Reddit, YouTube.
- Any site that doesn't show you the actual score.

If a bench has BOTH a leaderboard page and a paper, prefer the
leaderboard for the bench's `url` (users click to see rankings) and
the **paper** for individual scores IF the paper reports the exact
score. Otherwise use the leaderboard URL for both.

### 6. Numeric conventions

- Scores in the JSON are **raw**, as reported at `sourceUrl`. The
  loader normalises them to 0-100 using `scaleMin` / `scaleMax`.
- **If the bench reports as %**, use the percentage directly
  (`rawScore: 86.4`), with `scaleMin: 0, scaleMax: 100`.
- **If the bench reports as fraction 0-1** (HumanEval sometimes), you
  may either convert to % (prefer this, rescale to 0-100) or keep
  fraction with `scaleMin: 0, scaleMax: 1`. Pick one per bench and
  stick with it.
- **Arena ELO** (LMArena): use the raw ELO as-is with
  `scaleMin: 800, scaleMax: 1500` (the practical range). Note in the
  description that scores are ELO, not %.
- **SWE-bench** scores are % solved — use `scaleMin: 0, scaleMax: 100`.
- When in doubt, match the scale the benchmark's own leaderboard uses.

### 7. Workflow (do this, in order)

1. Read `convex/urls.ts` for the whitelist of trusted sources.
2. Read `convex/schema.ts` for the data model, in particular
   `benches`, `models`, `modelScores`.
3. Read `scripts/seed-data.template.json` for the exact format.
4. Run these two Convex queries to see what's already in the DB:
   ```bash
   npx convex run --prod benches:listAll      # for bench dedup
   npx convex run --prod models:listProviders
   npx convex run --prod models:listFamilyTags
   ```
   (If those query names don't exist as-is, read `convex/benches.ts`
   and pick the equivalent — the DB already has N benches and M models
   from the project operator's manual entry. Match their spelling.)
5. For each benchmark in §4, open the official source, read the
   scores, and write a new entry to `scripts/seed-data.json`.
6. **Capture `accessedAt`** correctly — use `Date.now()` at the moment
   you're looking at the page, a single value per bench-entry is fine
   (you probably looked at the page once and read 10 scores off it).
7. Validate locally:
   ```bash
   node scripts/run-seed.mjs --dry-run
   ```
   Fix any format errors it reports.
8. Stop. Do NOT run without `--dry-run`. The human operator does the
   real run.

### 8. What you are NOT allowed to do

- ❌ Estimate a score because you "remember" it. Every number needs
  a URL you can open.
- ❌ Invent synthetic "placeholder" scores.
- ❌ Attribute a score to a model it's not from ("close enough"
  reasoning — e.g. citing GPT-4's score for GPT-4-Turbo).
- ❌ Convert scales silently (e.g. mixing 0-1 and 0-100 in the same
  `scores[]`).
- ❌ Add upvote/downvote counts to the JSON. The loader always sets
  `upvotes: 1, downvotes: 0` automatically. Adding counts in the JSON
  is a red-flag signal that you're inventing social-proof data.
- ❌ Create bench entries with fewer than 5 verified scores — if you
  can only find 3 real scores, skip the bench and pick a different
  one.

### 9. When you're done

Report back to the operator with:
- a one-line summary (`N benches, M model-scores, X unique models`)
- a list of any benches you intended to include but couldn't
  ("skipped: X because only 3 scores were findable on official
  sources")
- any taxonomy ambiguities you resolved with a guess (so the human
  can override — e.g. "put both gpt-4 and gpt-4-turbo in familyTag
  GPT-4, fork if you disagree")

Do NOT push to Convex yourself. The operator runs `node scripts/
run-seed.mjs` after spot-checking.

---

## What the seed loader does (for your reference, human)

- Creates a single `users` row with `name: "SupraBench Initial
  Prefill"`, `email: "prefill@suprabench.internal"`. No auth account
  is attached — this user can never log in.
- Inserts each bench with `addedBy = serviceUser`, each score with
  `submittedBy = serviceUser`, `upvotes: 1, downvotes: 0` plus the
  self-upvote row in `votes`. This is byte-for-byte what a normal
  user's `submitOne` call does, minus the user-level rate-limit check.
- Idempotent: re-running dedups benches by slug, models by slug,
  scores by `(modelId, benchId, sourceUrl)`. Adding rows to the JSON
  and re-running inserts only the delta.
- After all chunks are applied, runs `rankings:recomputeAll` +
  `migrations:backfillBenchAggregates` + `migrations:backfillTagCounts`
  so the leaderboard reflects the new data on next subscription tick.

To audit what the service user has produced:

```bash
npx convex run --prod seed:summary
```

To revert (nuclear option — drops all service-user data):

```bash
# Not implemented as a convenience mutation because it's destructive.
# Use the Convex dashboard's table browser and filter by submittedBy
# = the service user's _id, or write a one-shot internalMutation.
```
