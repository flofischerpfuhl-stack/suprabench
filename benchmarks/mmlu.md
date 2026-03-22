---
name: "MMLU"
subtitle: "Massive Multitask Language Understanding"
year: 2020
trust: 1.8
gaming_risk: 91
paper_url: "https://arxiv.org/abs/2009.03300"
repo_url: "https://github.com/hendrycks/test"
capability_tags: ["knowledge-breadth"]
use_case_tags: []
---

# MMLU

14,042 multiple-choice questions across 57 academic subjects from STEM to humanities. Originally designed to measure breadth of knowledge and reasoning across diverse domains.

## Community Verdict

Once the standard benchmark, now considered deeply compromised. Massive contamination in training data, inconsistent question quality, and ceiling effects make differences between top models meaningless. Scores above 85% reflect memorization more than understanding.

## Model Scores

| Model | Score |
|-------|-------|
| DeepSeek R1 | 90.8 |
| Claude 3.5 Sonnet | 88.7 |
| GPT-4o | 88.7 |
| Gemini 1.5 Pro | 85.9 |
| Llama 3.3 70B | 86.0 |
