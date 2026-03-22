---
name: "LiveCodeBench"
subtitle: "Contamination-Free Coding Eval"
year: 2024
score: 10
paper_url: "https://arxiv.org/abs/2403.07974"
repo_url: "https://github.com/LiveCodeBench/LiveCodeBench"
capability_tags: ["coding", "algorithms"]
use_case_tags: []
---

# LiveCodeBench

Continuously updated coding benchmark using problems from competitive programming contests published after model training cutoffs. Eliminates data contamination by design.

## Community Verdict

Clever approach to contamination. The rolling time window is its biggest strength. However, competitive programming measures a narrow slice of coding ability, and difficulty calibration varies across contest sources.

## Model Scores

| Model | Score | Proof |
|-------|-------|-------|
| DeepSeek R1 | 65.9 | |
| Claude 3.5 Sonnet | 51.3 | |
| GPT-4o | 45.2 | |
| Gemini 1.5 Pro | 43.8 | |
| Llama 3.3 70B | 33.1 | |
