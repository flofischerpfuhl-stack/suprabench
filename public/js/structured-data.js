/* ════════════════════════════════════════════════════════════════════
   STRUCTURED DATA (JSON-LD) — what search engines + Google Dataset
   Search read to understand SupraBench.

   Three entities, linked via @id so Google sees one coherent graph:

     1. Organization  — operator + sameAs links (logo, social).
     2. WebSite       — top-level site entity, "publisher" → Organization.
     3. Dataset       — the leaderboard itself, declared as a research-
                        grade dataset so it surfaces in Google Dataset
                        Search (datasetsearch.research.google.com) and
                        is properly citeable by ML researchers, AI
                        infra vendors, journalists, etc.

   Loaded via external script (no inline JSON-LD) so the strict CSP
   in public/_headers can keep blocking inline <script>.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const SITE_URL = "https://suprabench.com/";

  const ORG = {
    "@type": "Organization",
    "@id": "https://suprabench.com/#organization",
    name: "SupraBench",
    url: SITE_URL,
    logo: {
      "@type": "ImageObject",
      url: "https://suprabench.com/img/icon-512.png",
      width: 512,
      height: 512,
    },
    sameAs: [
      "https://gitlab.com/florian-fischer-group/suprabench",
    ],
  };

  const WEBSITE = {
    "@type": "WebSite",
    "@id": "https://suprabench.com/#website",
    url: SITE_URL,
    name: "SupraBench",
    description:
      "Community-driven AI model rankings based on benchmark trustworthiness.",
    publisher: { "@id": ORG["@id"] },
    inLanguage: "en",
  };

  /* ── DATASET ──
     Why this exists: SupraBench is structurally a dataset (model ×
     bench → score, plus quality ratings, plus aggregate SupraScores).
     Declaring it as schema.org/Dataset makes it eligible for Google
     Dataset Search results and for academic citation tools. The
     `variableMeasured` block spells out the columns; `distribution`
     points at the JSON export endpoint so a researcher knows there's
     a programmatic way to grab the data once a Pro-tier API key is
     active.

     Why no `dateModified`: this dataset mutates on every submission /
     vote / rating, so any hardcoded value would lie within hours.
     Generating one at render time would force every crawler-render to
     hit Convex for a freshness query — wasted volume for marginal
     SEO benefit. Google falls back to other freshness signals when
     dateModified is absent: HTTP Last-Modified header (set by
     Cloudflare Pages on every asset), the sitemap's <lastmod>
     entry for `/` (changefreq=daily), and its own crawl timestamp.
     `temporalCoverage` below stays open-ended ("2025-01-01/..") so
     consumers know the series is ongoing. */
  const DATASET = {
    "@type": "Dataset",
    "@id": "https://suprabench.com/#dataset",
    name: "SupraBench AI Model Rankings",
    alternateName: "SupraScore Leaderboard",
    description:
      "Community-curated, trustworthiness-weighted rankings of large language models across crowd-rated benchmarks. Each model receives a SupraScore — the bench-weighted mean of its per-bench medians, shrunk by a coverage-share factor so that models tested on few benches cannot outrank well-covered rivals. Benchmarks themselves are rated by the community on relevance, contamination resistance, discriminability, reproducibility and difficulty. The dataset is updated continuously as new submissions, votes and quality ratings land — the snapshot a crawler sees reflects the state at request time; consult the HTTP Last-Modified header on the page response, or fetch /v1/export.json, for the most recent values.",
    url: SITE_URL,
    identifier: SITE_URL,
    keywords: [
      "large language models",
      "LLM benchmarks",
      "AI model evaluation",
      "leaderboard",
      "model rankings",
      "benchmark quality",
      "SupraScore",
      "AI evaluation",
      "AI rankings",
    ],
    inLanguage: "en",
    isAccessibleForFree: true,
    license: "https://opensource.org/licenses/Apache-2.0",
    creator: { "@id": ORG["@id"] },
    publisher: { "@id": ORG["@id"] },
    creativeWorkStatus: "Published",
    temporalCoverage: "2025-01-01/..",
    variableMeasured: [
      {
        "@type": "PropertyValue",
        name: "SupraScore",
        description:
          "Trust-weighted aggregate score of an AI model across all benchmarks it has been evaluated on (range 0–100).",
      },
      {
        "@type": "PropertyValue",
        name: "Bench Score",
        description:
          "A benchmark's contribution weight, combining community quality ratings, difficulty, headroom and coverage shares (range 0–100).",
      },
      {
        "@type": "PropertyValue",
        name: "Quality — Relevance",
        description: "Community 1–5 rating of how well a benchmark reflects real-world capability.",
      },
      {
        "@type": "PropertyValue",
        name: "Quality — Contamination Resistance",
        description: "Community 1–5 rating of how resistant a benchmark is to training-data contamination.",
      },
      {
        "@type": "PropertyValue",
        name: "Quality — Discriminability",
        description: "Community 1–5 rating of how well a benchmark separates strong from weak models.",
      },
      {
        "@type": "PropertyValue",
        name: "Quality — Reproducibility",
        description: "Community 1–5 rating of how independently runnable a benchmark is.",
      },
      {
        "@type": "PropertyValue",
        name: "Difficulty",
        description: "Median rater difficulty (1–5) feeding the SupraScore via the D(b) factor.",
      },
    ],
    distribution: [
      {
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: "https://api.suprabench.com/v1/export.json",
        description:
          "Full leaderboard snapshot, JSON. Requires a Pro-tier API key (paid tiers are demand-gated as of April 2026; partner keys available on request).",
      },
    ],
  };

  const data = {
    "@context": "https://schema.org",
    "@graph": [WEBSITE, ORG, DATASET],
  };

  const script = document.createElement("script");
  script.type = "application/ld+json";
  script.textContent = JSON.stringify(data);
  document.head.appendChild(script);
})();
