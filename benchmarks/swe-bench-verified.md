---
name: "SWE-bench Verified"
subtitle: "Real-World Software Engineering"
year: 2023
trust: 3.2
gaming_risk: 54
paper_url: "https://arxiv.org/abs/2310.06770"
repo_url: "https://github.com/princeton-nlp/SWE-bench"
capability_tags: ["coding", "debugging"]
use_case_tags: []
---

# SWE-bench Verified

500 human-verified software engineering tasks sourced from real GitHub issues across popular Python repos. Models must understand codebases, diagnose bugs, and generate working patches.

## Community Verdict

Important real-world benchmark but high gaming risk due to training data contamination — many source repos are in LLM training sets. The "Verified" subset helps but scaffolding differences across evaluations make comparison difficult.

## Model Scores

| Model | Score | Proof |
|-------|-------|-------|
| DeepSeek R1 | 49.2 | |
| Claude 3.5 Sonnet | 50.8 | |
| GPT-4o | 38.8 | |
| Gemini 1.5 Pro | 36.2 | |
| Llama 3.3 70B | 26.5 | |
