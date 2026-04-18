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

  // Global tag-count cache. Maintained incrementally by tagVotes.
  // Replaces the O(M+B) full-collect previously done on every tags.listAll
  // subscription update. Optional table — queries fall back to live compute
  // when row missing.
  tagCounts: defineTable({
    tag: v.string(),
    benches: v.number(),
    models: v.number(),
  }).index("by_tag", ["tag"]),
});
