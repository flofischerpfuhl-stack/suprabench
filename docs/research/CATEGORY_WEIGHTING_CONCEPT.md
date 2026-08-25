# Category-balanced SupraScore concept

Status: concept and shadow-test proposal; not active in production.

## Problem

Benchmark ratings answer "how trustworthy and informative is this benchmark?"
They do not answer "how much of the total leaderboard should coding, agents,
spatial reasoning, or knowledge occupy?" If one area has many correlated
benchmarks, it can accumulate more total mass merely because it is easier to
publish benchmarks in that area.

An editorial hard cap would solve duplication but would also impose the
maintainer's priorities on users. SupraBench should instead separate three
choices:

1. benchmark quality, supplied by community ratings;
2. benchmark category, transparently assigned and challengeable;
3. category importance, selected by the viewer or aggregated from explicit
   user preferences.

## Proposed hierarchy

Each benchmark receives exactly one audited primary category for aggregation.
Existing non-exclusive tags remain unchanged for search and filtered views.
Initial primary categories can be broad and provider-neutral:

- software engineering and coding;
- agents and tool use;
- reasoning and puzzles;
- multimodal, spatial, and embodied intelligence;
- knowledge and science;
- long-context and retrieval.

Let `w_b` be the existing community-controlled benchmark ability weight. For a
category `c`, normalize only within that category:

```text
withinCategory(b) = w_b / sum(w_j for j in category c)
finalWeight(b, profile) = categoryShare(c, profile) * withinCategory(b)
```

Adding a fifth similar coding benchmark would redistribute the coding share; it
would not automatically make coding five times as important. Community ratings
still decide which coding benchmarks receive that share.

## User control instead of paternalism

The UI should offer four explicit profiles and always show the active one:

- Current/uncapped: present SupraScore math, preserved as a comparison view.
- Community: category shares derived from users' explicit category-importance
  preferences, with a minimum participation threshold before activation.
- Balanced: equal shares across categories that have evidence for the selected
  model; useful as a neutral diagnostic, not asserted as universal truth.
- Custom: viewer-controlled sliders whose shares sum to 100 percent, stored in
  the browser by default and optionally in the signed-in profile.

No profile changes an individual benchmark rating. Users can inspect raw
category contribution, switch profiles, and share a URL that encodes the chosen
profile. The canonical leaderboard should remain Current/uncapped until the
shadow comparison, primary-category audit, and preference participation reach
published thresholds.

## Category governance

- Primary category is separate from community tags and has a visible history.
- A benchmark can expose secondary tags, but only one primary category enters
  the mass calculation; this prevents overlap from double-counting it.
- Category corrections use a proposal/vote flow with anti-brigading thresholds.
- New categories require a public rationale and at least two substantively
  different benchmarks; otherwise they become a cap-evasion mechanism.
- The website exposes each category's total mass and every benchmark's share.

## Feasibility and rollout

The current schema already stores benchmark tags, scores, ratings, and cached
weights. Implementation would add `primaryCategory` plus optional per-user
category preferences, then extend the existing tag-filtered simulator. No score
rows need migration.

Recommended gates:

1. audit and publish the primary-category mapping;
2. run Current, Balanced, and candidate Community profiles in shadow mode;
3. measure rank sensitivity and correlated-benchmark duplication attacks;
4. add the profile switcher and contribution breakdown;
5. only consider changing the default after real preference participation and
   a public methodology review.

This design is technically feasible. The remaining hard part is governance,
not calculation.
