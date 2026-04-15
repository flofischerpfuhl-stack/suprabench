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
  }).index("by_slug", ["slug"]),

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
  }).index("by_slug", ["slug"]),

  benchQualityRatings: defineTable({
    benchId: v.id("benches"),
    userId: v.id("users"),
    relevance: v.number(),
    contamination: v.number(),
    discriminability: v.number(),
    reproducibility: v.number(),
  })
    .index("by_bench", ["benchId"])
    .index("by_bench_user", ["benchId", "userId"]),

  modelScores: defineTable({
    modelId: v.id("models"),
    benchId: v.id("benches"),
    rawScore: v.number(),
    normalizedScore: v.number(),
    sourceUrl: v.string(),
    submittedBy: v.id("users"),
    createdAt: v.number(),
    upvotes: v.number(),
    downvotes: v.number(),
  })
    .index("by_model", ["modelId"])
    .index("by_bench", ["benchId"])
    .index("by_model_bench", ["modelId", "benchId"]),

  votes: defineTable({
    targetId: v.string(),
    targetType: v.literal("modelScore"),
    userId: v.id("users"),
    value: v.union(v.literal(1), v.literal(-1)),
  })
    .index("by_target", ["targetId"])
    .index("by_user_target", ["userId", "targetId"]),
});
