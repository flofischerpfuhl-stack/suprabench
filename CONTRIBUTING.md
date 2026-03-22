# Contributing to SupraBench

Thank you for your interest in contributing to SupraBench! This platform relies on community expertise to evaluate and rank AI models fairly.

## Adding a Benchmark

Benchmarks are added by creating a new `.md` file in the `benchmarks/` directory.

### Pull Request Process

1. You can use the "Contribute" page on the SupraBench website to automatically generate a Pull Request.
2. Alternatively, fork this repository and create a Markdown file in `benchmarks/`. 
3. Include the YAML frontmatter with the following fields:
   - `name`: Benchmark name
   - `trust`: Trust score (1.0 to 5.0)
   - `gaming_risk`: Estimated gaming risk (0 to 100)
   - `capability_tags`: List of tags
4. Model scores are added using an explicit Markdown table in the body:
   ```markdown
   | Model | Score |
   |-------|-------|
   | Model Name | 95.0 |
   ```

### Important License Agreement

**By submitting a Pull Request, you agree your contributions may be used commercially by the project owner.** This repository operates under the BSL 1.1 license.

### Auto-Merge Rules
Approved PRs are automatically merged via our GitHub Action if they meet these criteria:
- Open for at least 48 hours.
- 2 approvals from trusted contributors.
- Do not modify files in the `.github/` directory.
