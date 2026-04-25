// ════════════════════════════════════════════════════════════
// PUBLIC API — TIER PRICING & QUOTAS (single source of truth)
//
// Every other place that needs to show or enforce a tier number
// MUST import from this file or render from the `listTiers` query
// below. Do NOT re-declare these numbers anywhere else.
//
// Things that already follow this rule:
//   • convex/api.ts          → imports TIERS from "./tiers" (LIVE)
//   • convex/partners.ts     → imports PARTNER_DEFAULTS (LIVE)
//   • convex/stripe.future.ts → imports TIERS, Tier from "./tiers"
//     (activates when paid tiers ship)
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
// Fallback defaults the CLI uses when a partner key is minted
// without explicit --quota / --rpm flags. These are NOT the
// advertised numbers for the partner tier (there are none —
// every partner is negotiated individually, see the partner entry
// below). They exist so `partners:createPartnerKey --name=foo`
// without further arguments produces a usable key instead of
// crashing on null.
export const PARTNER_DEFAULTS = {
  monthlyQuota: 100_000,   // Pro-equivalent
  rpmLimit:     300,
  allowExport:  true,
  maxKeys:      1,
} as const;

export const TIERS = {
  starter: {
    priceUsd:     null,             // TBD — set when launching
    monthlyQuota: 10_000,
    rpmLimit:     60,
    allowExport:  false,
    maxKeys:      1,
    isPubliclySubscribable: true,
  },
  pro: {
    priceUsd:     null,             // TBD — set when launching
    monthlyQuota: 100_000,
    rpmLimit:     300,
    allowExport:  true,
    maxKeys:      3,
    isPubliclySubscribable: true,
  },
  enterprise: {
    priceUsd:     null,             // TBD — set when launching
    monthlyQuota: 1_000_000,
    rpmLimit:     1_200,
    allowExport:  true,
    maxKeys:      10,
    isPubliclySubscribable: true,
  },
  enterprise_plus: {
    priceUsd:     null,             // always negotiated
    monthlyQuota: 10_000_000,
    rpmLimit:     6_000,
    allowExport:  true,
    maxKeys:      50,
    isPubliclySubscribable: false,  // contract-only; no self-serve
  },
  // ─── INVITE-ONLY FREE TIER FOR PARTNER SITES ─────────────────────
  // Free API access for whitelisted partner projects (my other
  // properties, friendly non-profit / open-source projects I
  // explicitly approve). Quotas are **negotiated individually** —
  // the CLI mutation `partners:createPartnerKey` accepts --quota
  // and --rpm overrides per key and falls back to PARTNER_DEFAULTS
  // (see above) when omitted.
  //
  // Public UI behaviour: the tier IS rendered in the pricing grid
  // (the user wanted it visible so partners know to apply) but with
  // a "Negotiated / Apply" CTA instead of a subscribe button. Self-mint
  // via `api.createKey` is still blocked — `isPubliclySubscribable:
  // false` keeps `createKey` from accepting `tier: "partner"` from an
  // ordinary signed-in user.
  //
  // The auth middleware in `convex/api.ts` skips the Stripe
  // subscription check for `tier === "partner"`; everything else
  // (rate limit, per-key monthly quota, audit log) behaves
  // identically to the paid tiers.
  //
  // The monthlyQuota / rpmLimit numbers below are **display
  // fallbacks** used only when the CLI mints a partner key without
  // override flags; the tier-card doesn't render them (see the card
  // rendering in public/index.html).
  partner: {
    priceUsd:     0,
    monthlyQuota: PARTNER_DEFAULTS.monthlyQuota,
    rpmLimit:     PARTNER_DEFAULTS.rpmLimit,
    allowExport:  PARTNER_DEFAULTS.allowExport,
    maxKeys:      PARTNER_DEFAULTS.maxKeys,
    isPubliclySubscribable: false,  // invite-only; CLI-minted
  },
} as const;

// Tiers the `api.createKey` mutation will accept as input from a
// normal signed-in user. `enterprise_plus` and `partner` are both
// excluded because they're minted manually (enterprise_plus through
// Stripe-then-CLI with an account manager; partner through
// `partners:createPartnerKey` only).
export const PUBLIC_TIERS = [
  "starter",
  "pro",
  "enterprise",
] as const;
export type PublicTier = (typeof PUBLIC_TIERS)[number];

export type Tier = keyof typeof TIERS;

// Public query the frontend can subscribe to so the tier-grid in
// /#api reflects this file. The frontend iterates this list and
// renders a card per tier; it uses `isPubliclySubscribable` to pick
// between a "Subscribe / Join waitlist" CTA and a contact-us CTA
// (used for enterprise_plus and partner).
//
// We return ALL tiers here — including partner — because the user
// explicitly wants the partner option visible on the pricing page as
// a "hey, got a non-profit project? apply to be a SupraBench partner"
// invitation. The frontend is responsible for rendering a key-creation
// button only when `isPubliclySubscribable === true`. Server-side
// enforcement still happens in `api.createKey` (it hard-rejects
// non-public tiers regardless of what the frontend sent).
export const listTiers = query({
  args: {},
  handler: async () => {
    return Object.entries(TIERS).map(([id, cfg]) => ({
      id: id as Tier,
      ...cfg,
    }));
  },
});
