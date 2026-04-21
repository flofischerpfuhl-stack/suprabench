// ════════════════════════════════════════════════════════════
// PUBLIC API — TIER PRICING & QUOTAS (single source of truth)
//
// Every other place that needs to show or enforce a tier number
// MUST import from this file or render from the `listTiers` query
// below. Do NOT re-declare these numbers anywhere else.
//
// Things that already follow this rule:
//   • convex/api.future.ts   → imports TIERS from "./tiers"
//   • convex/stripe.future.ts → imports TIERS, Tier from "./tiers"
//   • scripts/check-tier-consistency.mjs runs in CI and greps the
//     repo for any drifted price/quota strings
//
// Things that for now still hard-code matching strings (the lint
// script keeps them honest):
//   • public/index.html               (Profile → API tier-grid)
//   • public/docs/api/index.html      (landing tier table)
//   • public/docs/api/authentication.html (max-keys table)
//   • public/docs/api/rate-limits.html (per-tier rate/quota table)
//   • public/docs/api/changelog.html  (initial-release line)
//   • docs/api-roadmap.md             (pricing table)
//
// PRICES: intentionally `null` everywhere right now. The API is
// finished and Stripe-wired, but pricing is published as "TBD"
// until launch — we want early adopters to see "community project
// finalising pricing with input" rather than "startup with a price
// list". The actual numbers we'll charge live exclusively in the
// Stripe dashboard (Products → recurring Prices) and never in this
// repo: at checkout time we send only the Stripe Price ID, Stripe
// itself owns the amount + currency. To launch, set `priceUsd` here
// to numbers AND update the matching `TBD` cells in:
//   • public/index.html              (Profile → API tier-grid)
//   • public/docs/api/index.html     (landing tier table)
//   • docs/api-roadmap.md            (pricing table)
// The lint script (npm run check:tiers) will fail the build if you
// forget any of those.
//
// Quotas / RPM / max-keys are NOT secret — they define the tier's
// value proposition and shape the waitlist signal we need before
// committing to a price.
// ════════════════════════════════════════════════════════════

import { query } from "./_generated/server";

// Internal keys are snake_case lowercase ("enterprise_plus"); the
// capitalised display labels ("Enterprise+") live in the UI HTML.
// Keeping them separate avoids URL-encoding headaches for the "+"
// character — the key is what goes into the DB / API responses, the
// label is what users see.
export const TIERS = {
  starter: {
    priceUsd:     null,             // TBD — set when launching
    monthlyQuota: 10_000,
    rpmLimit:     60,
    allowExport:  false,
    maxKeys:      1,
  },
  pro: {
    priceUsd:     null,             // TBD — set when launching
    monthlyQuota: 100_000,
    rpmLimit:     300,
    allowExport:  true,
    maxKeys:      3,
  },
  enterprise: {
    priceUsd:     null,             // TBD — set when launching
    monthlyQuota: 1_000_000,
    rpmLimit:     1_200,
    allowExport:  true,
    maxKeys:      10,
  },
  enterprise_plus: {
    priceUsd:     null,             // always negotiated
    monthlyQuota: 10_000_000,
    rpmLimit:     6_000,
    allowExport:  true,
    maxKeys:      50,
  },
} as const;

export type Tier = keyof typeof TIERS;

// Public query the frontend can subscribe to so the tier-grid in
// /#api always reflects this file. Not used yet (the cards are
// still hand-rolled HTML — see comment at top); wiring the cards
// to this query is the next step in eliminating drift.
export const listTiers = query({
  args: {},
  handler: async () => {
    return Object.entries(TIERS).map(([id, cfg]) => ({
      id: id as Tier,
      ...cfg,
    }));
  },
});
