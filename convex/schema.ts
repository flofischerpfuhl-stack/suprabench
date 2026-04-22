import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export default defineSchema({
  ...authTables,

  models: defineTable({
    name: v.string(),
    provider: v.string(),
    slug: v.string(),
    familyTag: v.optional(v.string()),
    tags: v.array(v.string()),
    addedBy: v.id("users"),
    createdAt: v.number(),
    hidden: v.optional(v.boolean()),
  })
    .index("by_slug", ["slug"])
    .index("by_added_by", ["addedBy"])
    .searchIndex("search_name", { searchField: "name" }),

  benches: defineTable({
    name: v.string(),
    slug: v.string(),
    description: v.string(),
    url: v.string(),
    isOfficial: v.boolean(),
    tags: v.array(v.string()),
    scaleMin: v.number(),
    scaleMax: v.number(),
    addedBy: v.id("users"),
    createdAt: v.number(),
    hidden: v.optional(v.boolean()),
    // ── Denormalized aggregate cache (recomputed by cache.recomputeBenchAggregates).
    // All fields optional to keep schema migration backward-compatible:
    // queries that read them must fall back to live computation when missing.
    cachedQualityScore: v.optional(v.number()),       // 0-100
    cachedDimensions: v.optional(
      v.object({
        relevance: v.number(),
        contamination: v.number(),
        discriminability: v.number(),
        reproducibility: v.number(),
        difficulty: v.number(),
      })
    ),
    cachedRaterCount: v.optional(v.number()),
    cachedModelCount: v.optional(v.number()),         // # distinct models with valid scores
    cachedFrontierMean: v.optional(v.number()),
    cachedHeadroom: v.optional(v.number()),
    cachedDifficultyMultiplier: v.optional(v.number()),
    cachedEffectiveWeight: v.optional(v.number()),    // quality × difficulty × headroom
    cachedTopK: v.optional(v.number()),
    cachedAggregatesAt: v.optional(v.number()),       // last refresh timestamp
  })
    .index("by_slug", ["slug"])
    .index("by_added_by", ["addedBy"])
    .searchIndex("search_name", { searchField: "name" }),

  benchQualityRatings: defineTable({
    benchId: v.id("benches"),
    userId: v.id("users"),
    relevance: v.number(),
    contamination: v.number(),
    discriminability: v.number(),
    reproducibility: v.number(),
    // Difficulty (1-5): how much intelligence does this bench probe?
    // Multiplied (not averaged) into the bench's effective weight, so a
    // trivial bench contributes 20% of a frontier bench at the same quality.
    difficulty: v.optional(v.number()),
  })
    .index("by_bench", ["benchId"])
    .index("by_bench_user", ["benchId", "userId"]),

  modelScores: defineTable({
    modelId: v.id("models"),
    benchId: v.id("benches"),
    rawScore: v.number(),
    normalizedScore: v.number(),
    sourceUrl: v.string(),
    accessedAt: v.number(),
    submittedBy: v.id("users"),
    createdAt: v.number(),
    upvotes: v.number(),
    downvotes: v.number(),
    // Denormalized submitter identity captured at insert-time. Saves an
    // O(1) db.get(submittedBy) per submission row in detail/profile queries.
    // May go stale if the user later changes their Google profile name/image
    // — that is acceptable for our use-case (display-only).
    submitterName: v.optional(v.string()),
    submitterImage: v.optional(v.string()),
  })
    .index("by_model", ["modelId"])
    .index("by_bench", ["benchId"])
    .index("by_model_bench", ["modelId", "benchId"])
    .index("by_submitter", ["submittedBy", "createdAt"]),

  votes: defineTable({
    targetId: v.string(),
    targetType: v.literal("modelScore"),
    userId: v.id("users"),
    value: v.union(v.literal(1), v.literal(-1)),
  })
    .index("by_target", ["targetId"])
    .index("by_user_target", ["userId", "targetId"]),

  tagVotes: defineTable({
    entityType: v.union(v.literal("model"), v.literal("bench")),
    entityId: v.string(),
    tag: v.string(),
    userId: v.id("users"),
    value: v.union(v.literal(1), v.literal(-1)),
  })
    .index("by_entity", ["entityType", "entityId"])
    .index("by_entity_tag", ["entityType", "entityId", "tag"])
    .index("by_user", ["userId"])
    .index("by_user_entity_tag", [
      "userId",
      "entityType",
      "entityId",
      "tag",
    ]),

  // Per-user up/down votes on the *existence* of a model or bench.
  // When net score ≤ ENTITY_HIDE_THRESHOLD (e.g. -3) the entity is
  // soft-hidden from listings / detail pages.
  entityVotes: defineTable({
    entityType: v.union(v.literal("model"), v.literal("bench")),
    entityId: v.string(),
    userId: v.id("users"),
    value: v.union(v.literal(1), v.literal(-1)),
  })
    .index("by_entity", ["entityType", "entityId"])
    .index("by_user_entity", ["userId", "entityType", "entityId"]),

  // Denormalized rankings cache — updated on mutations
  modelRankings: defineTable({
    modelId: v.id("models"),
    name: v.string(),
    provider: v.string(),
    slug: v.string(),
    familyTag: v.optional(v.string()),
    tags: v.array(v.string()),
    supraScore: v.number(),
    benchCount: v.number(),
    updatedAt: v.number(),
    // Mirror of models.hidden so listRanked doesn't need an N×db.get loop.
    // Kept in sync by entityVotes.applyHiddenState. Optional for migration:
    // queries treat undefined as "not hidden".
    hidden: v.optional(v.boolean()),
  })
    .index("by_model", ["modelId"])
    .index("by_score", ["supraScore"]),

  // Denormalized family rankings cache — recomputed alongside
  // modelRankings. One row per distinct (familyTag, provider) pair
  // across non-hidden models. A model without a familyTag is NOT
  // counted anywhere (we don't invent a pseudo-family from the
  // model's own name — that creates noise in the ranking table).
  //
  // supraScore here is the FAMILY score:
  //   • rebuilt from the constituent models' per-bench medians
  //   • same weighting formula as individual models (bench weight =
  //     quality × difficulty × headroom)
  //   • in plain words: "take every bench any family-member scored
  //     on, compute the family's median score on that bench from the
  //     members' own bench-medians, then weight-aggregate."
  // See rankings.recomputeFamily for the implementation.
  familyRankings: defineTable({
    familyTag: v.string(),
    provider: v.string(),
    supraScore: v.number(),
    benchCount: v.number(),     // # distinct benches ≥ 1 family-member has a valid score on
    modelCount: v.number(),     // # non-hidden models in the family
    tags: v.array(v.string()),  // union of member models' tags (for tag-filter)
    updatedAt: v.number(),
    hidden: v.optional(v.boolean()), // true when every member model is hidden
  })
    .index("by_family", ["familyTag"])
    .index("by_family_provider", ["familyTag", "provider"])
    .index("by_score", ["supraScore"]),

  // Global tag-count cache. Maintained incrementally by tagVotes.
  // Replaces the O(M+B) full-collect previously done on every tags.listAll
  // subscription update. Optional table — queries fall back to live compute
  // when row missing.
  tagCounts: defineTable({
    tag: v.string(),
    benches: v.number(),
    models: v.number(),
  }).index("by_tag", ["tag"]),

  // Public-API waitlist. The full API (apiKeys / Stripe / etc.) lives
  // behind commented-out blocks (see below + api.future.ts), but the
  // waitlist itself is LIVE so the dashboard can collect demand
  // signal before we flip the API on.
  apiWaitlist: defineTable({
    userId: v.optional(v.id("users")),  // null = signed-out signup (we still capture)
    email: v.string(),
    tier: v.string(),                   // "starter" | "pro" | "enterprise" | "enterprise_plus"
    createdAt: v.number(),
    notifiedAt: v.optional(v.number()),
  })
    .index("by_email", ["email"])
    .index("by_user", ["userId"])
    .index("by_tier", ["tier"]),

  // ════════════════════════════════════════════════════════════
  // PUBLIC API + STRIPE BILLING
  //
  // Backing tables for the public `/v1/*` API (see convex/api.ts,
  // convex/partners.ts, docs/api-roadmap.md) and for the dormant
  // Stripe integration (convex/stripe.future.ts).
  //
  // Activation status (April 2026):
  //   • api.ts + partners.ts        → LIVE. `/v1/*` answers requests
  //     on the production deployment, partner keys minted via
  //     `npx convex run partners:createPartnerKey` are fully
  //     functional.
  //   • stripe.future.ts            → still behind a .future fence.
  //     No Stripe routes registered, no webhook, no env secrets set.
  //     Paid tiers (starter/pro/enterprise) therefore cannot be
  //     self-subscribed yet — the Profile→API cards show "Join
  //     waitlist". This is deliberate; see ACTIVATION.md for the
  //     rest of the flip.
  //
  // The Stripe tables (stripeCustomers, stripeSubscriptions,
  // stripeEvents) ARE uncommented even though stripe.future.ts is
  // dormant, because api.ts's `createKey` mutation references
  // `stripeSubscriptions` in its subscription-liveness check. Storing
  // a few empty tables costs essentially nothing, and having them in
  // the schema means the eventual Stripe flip is purely an
  // uncomment-and-deploy (no schema migration). Partner and
  // enterprise_plus keys skip the subscription check entirely.
  // ════════════════════════════════════════════════════════════

  // Hashed API tokens. The plaintext key is shown to the user ONCE on
  // creation and never persisted; we only ever look up by hash.
  apiKeys: defineTable({
    hash: v.string(),                   // SHA-256(key) hex
    prefix: v.string(),                 // "sb_live_a1b2c3d4" — for UI display
    name: v.string(),                   // user-supplied label
    ownerUserId: v.id("users"),
    // Tier names are mirrored from convex/tiers.ts (the single source
    // of truth for pricing + quotas). Don't put numbers in this comment
    // — they'll drift; see tiers.ts.
    tier: v.union(
      v.literal("starter"),
      v.literal("pro"),
      v.literal("enterprise"),
      v.literal("enterprise_plus"),
      // Invite-only free tier for whitelisted partner sites. Keys are
      // minted exclusively via the CLI mutation
      // `partners:createPartnerKey` (see convex/partners.future.ts) and
      // carry NO Stripe subscription — the auth middleware skips the
      // subscription check for this tier.
      v.literal("partner"),
    ),
    monthlyQuota: v.number(),
    rpmLimit: v.number(),               // sliding-window per minute
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    // Stripe linkage. When the subscription lapses we set revokedAt.
    stripeSubscriptionId: v.optional(v.string()),
    stripeSubscriptionStatus: v.optional(v.string()),
  })
    .index("by_hash", ["hash"])
    .index("by_owner", ["ownerUserId"])
    .index("by_subscription", ["stripeSubscriptionId"]),

  // Per-key, per-month request counter. Atomically incremented on
  // every API call by api:consumeQuota. Cheap to reset (just stop
  // querying old months; documents auto-expire via a cron later).
  apiUsage: defineTable({
    apiKeyId: v.id("apiKeys"),
    yyyymm: v.string(),                 // "2026-04" — partition key
    count: v.number(),
    lastIncrementAt: v.number(),
  }).index("by_key_month", ["apiKeyId", "yyyymm"]),

  // Sliding-window rate-limit buckets. One row per (key, minute).
  // Document auto-pruning by a periodic cron (cleanupRateLimits).
  apiRateLimits: defineTable({
    apiKeyId: v.id("apiKeys"),
    minuteBucket: v.number(),           // floor(ts / 60_000)
    count: v.number(),
  }).index("by_key_bucket", ["apiKeyId", "minuteBucket"]),

  // Per-call audit log. Kept short (<= 1000 most recent per key) so
  // users can self-debug from the dashboard. Pruned by cron.
  apiRequestLog: defineTable({
    apiKeyId: v.id("apiKeys"),
    endpoint: v.string(),
    status: v.number(),
    ms: v.number(),                     // server time
    ts: v.number(),
    ip: v.optional(v.string()),         // hashed for privacy
    userAgent: v.optional(v.string()),
  }).index("by_key_ts", ["apiKeyId", "ts"]),

  // 1:1 mapping suprabench user → stripe customer. Populated on first
  // checkout. Survives subscription churn so we don't create duplicate
  // customers for the same person.
  stripeCustomers: defineTable({
    userId: v.id("users"),
    stripeCustomerId: v.string(),
    email: v.string(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_customer", ["stripeCustomerId"]),

  // Subscription state mirror. Source of truth is Stripe; this is our
  // queryable copy, kept fresh by the webhook handler.
  stripeSubscriptions: defineTable({
    userId: v.id("users"),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    stripePriceId: v.string(),
    tier: v.string(),                   // "starter" | "pro" | "enterprise" (not enterprise_plus — that's manual)
    status: v.string(),                 // "active" | "past_due" | "canceled" | "trialing" | …
    currentPeriodEnd: v.number(),
    cancelAtPeriodEnd: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_subscription", ["stripeSubscriptionId"])
    .index("by_customer", ["stripeCustomerId"]),

  // Idempotency log for the Stripe webhook. Stripe retries on 5xx
  // and we MUST NOT double-process events (would double-create keys,
  // double-cancel subs, etc.). We insert event.id once and bail on
  // re-delivery.
  stripeEvents: defineTable({
    stripeEventId: v.string(),
    type: v.string(),
    processedAt: v.number(),
  }).index("by_event_id", ["stripeEventId"]),

  // ════════════════════════════════════════════════════════════
  // USER ROLES — admin board (convex/admin.ts)
  //
  // `users` comes from @convex-dev/auth's authTables and we don't
  // extend it (would require forking authTables). Instead each
  // promoted user gets a `userRoles` row.
  //
  //   • role === "admin"   → can use the admin board. All admins
  //                          have the same abilities EXCEPT only the
  //                          primary admin (PRIMARY_ADMIN_EMAIL in
  //                          convex/admin.ts) can promote/demote
  //                          other admins.
  //   • grantedTier set    → user is authorised to own API keys of
  //                          that tier. `grantedLimits` are copied
  //                          onto every key minted for them.
  //
  // Absence of a row = regular user (no admin, no granted tier).
  // Both `role` and `grantedTier` are independent — a user can be
  // admin without having a granted API tier, and vice versa.
  // ════════════════════════════════════════════════════════════
  userRoles: defineTable({
    userId: v.id("users"),
    role: v.optional(v.literal("admin")),
    grantedTier: v.optional(
      v.union(v.literal("partner"), v.literal("enterprise_plus"))
    ),
    grantedLimits: v.optional(
      v.object({
        monthlyQuota: v.number(),
        rpmLimit: v.number(),
        maxKeys: v.number(),
        allowExport: v.boolean(),
      })
    ),
    grantedBy: v.optional(v.id("users")),
    grantedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
});
