import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { PRIMARY_ADMIN_EMAIL } from "./admin";
import { recomputeBenchAggregatesInline } from "./cache";
import { seedCreatorEntityVote } from "./entityVotes";
import { recomputeEffectiveTags } from "./tagVotes";
import { isOfficialUrl, normalizePublicHttpUrl } from "./urls";
import { canonicalFamilyTag } from "./modelFamilies";

const MAX_MODELS = 30;
const MAX_BENCHES = 5;
// A run may consist of several batches (YYYY-MM-DD, YYYY-MM-DD-b, …). 150 rows
// keeps one batch far below Convex's per-mutation read/write limits while
// letting a dense frontier import finish in a few batches.
const MAX_SCORES = 150;
const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}(-[a-z])?$/;
const MAX_EVIDENCE = 60;

const MAX_NAME_LEN = 120;
const MAX_PROVIDER_LEN = 80;
const MAX_DESCRIPTION_LEN = 1000;
const MAX_FAMILY_TAG_LEN = 80;

const RATING = v.object({
  relevance: v.number(),
  contamination: v.number(),
  discriminability: v.number(),
  reproducibility: v.number(),
  difficulty: v.number(),
});

const MODEL = v.object({
  name: v.string(),
  provider: v.string(),
  familyTag: v.string(),
  tags: v.array(v.string()),
});

const BENCH = v.object({
  name: v.string(),
  slug: v.string(),
  description: v.string(),
  url: v.string(),
  scaleMin: v.number(),
  scaleMax: v.number(),
  tags: v.array(v.string()),
  rating: RATING,
});

const SCORE = v.object({
  modelName: v.string(),
  benchSlug: v.string(),
  rawScore: v.number(),
  sourceUrl: v.string(),
  accessedAt: v.number(),
  operation: v.union(v.literal("insert"), v.literal("replace")),
});

const EVIDENCE = v.object({
  sourceUrl: v.string(),
  screenshotUrl: v.string(),
  screenshotPath: v.string(),
});

type ModelInput = {
  name: string;
  provider: string;
  familyTag: string;
  tags: string[];
};

type BenchInput = {
  name: string;
  slug: string;
  description: string;
  url: string;
  scaleMin: number;
  scaleMax: number;
  tags: string[];
  rating: {
    relevance: number;
    contamination: number;
    discriminability: number;
    reproducibility: number;
    difficulty: number;
  };
};

type ScoreInput = {
  modelName: string;
  benchSlug: string;
  rawScore: number;
  sourceUrl: string;
  accessedAt: number;
  operation: "insert" | "replace";
};

type ScorePlan = "insert" | "replace" | "refresh" | "unchanged";

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function cleanText(value: string, label: string, maxLength: number): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${label} is required`);
  if (cleaned.length > maxLength) throw new Error(`${label} is too long`);
  return cleaned;
}

function cleanTags(tags: string[], label: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (!tag) continue;
    if (tag.length > 30) throw new Error(`${label} tag is too long: ${tag}`);
    if (seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

function validateRating(rating: BenchInput["rating"], slug: string): void {
  for (const [dimension, value] of Object.entries(rating)) {
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new Error(`${slug} ${dimension} rating must be an integer from 1 to 5`);
    }
  }
}

function normalizeModel(input: ModelInput): ModelInput {
  const name = cleanText(input.name, "Model name", MAX_NAME_LEN);
  const requestedFamilyTag = cleanText(input.familyTag, "Model familyTag", MAX_FAMILY_TAG_LEN);
  return {
    name,
    provider: cleanText(input.provider, "Model provider", MAX_PROVIDER_LEN),
    familyTag: canonicalFamilyTag(name, requestedFamilyTag)!,
    tags: cleanTags(input.tags, input.name || "Model"),
  };
}

function normalizeBench(input: BenchInput): BenchInput {
  const name = cleanText(input.name, "Benchmark name", MAX_NAME_LEN);
  const slug = cleanText(input.slug, "Benchmark slug", MAX_NAME_LEN);
  if (slug !== generateSlug(name)) {
    throw new Error(`Benchmark slug ${slug} does not match generated slug ${generateSlug(name)}`);
  }
  if (!Number.isFinite(input.scaleMin) || !Number.isFinite(input.scaleMax)) {
    throw new Error(`${slug} scale must be finite`);
  }
  if (input.scaleMax <= input.scaleMin) {
    throw new Error(`${slug} scale must satisfy min < max`);
  }
  validateRating(input.rating, slug);
  return {
    ...input,
    name,
    slug,
    description: cleanText(input.description, "Benchmark description", MAX_DESCRIPTION_LEN),
    url: normalizePublicHttpUrl(input.url),
    tags: cleanTags(input.tags, slug),
  };
}

async function findAdminUserId(ctx: any): Promise<Id<"users">> {
  const users = await ctx.db.query("users").take(5000);
  const admin = users.find((user: any) => (user.email ?? "") === PRIMARY_ADMIN_EMAIL);
  if (!admin) {
    throw new Error(`Primary admin user (${PRIMARY_ADMIN_EMAIL}) not found`);
  }
  return admin._id as Id<"users">;
}

async function addTags(
  ctx: any,
  entityType: "model" | "bench",
  entityId: string,
  userId: Id<"users">,
  tags: string[]
): Promise<void> {
  for (const tag of tags) {
    await ctx.db.insert("tagVotes", {
      entityType,
      entityId,
      tag,
      userId,
      value: 1,
    });
  }
  await recomputeEffectiveTags(ctx, entityType, entityId);
}

function expectedReportPath(runId: string): string {
  return `public/reports/curation/${runId}/index.html`;
}

function sourceUrlsMatch(left: string, right: string): boolean {
  try {
    return normalizePublicHttpUrl(left) === right;
  } catch {
    return false;
  }
}

function classifyScore(
  score: ScoreInput,
  existing: any | undefined,
  label: string
): ScorePlan {
  if (score.operation === "insert") {
    if (!existing) return "insert";
    if (existing.rawScore !== score.rawScore) {
      throw new Error(`Existing score differs for ${label}; use operation=replace`);
    }
    return score.accessedAt > existing.accessedAt ? "refresh" : "unchanged";
  }

  if (!existing) throw new Error(`Cannot replace missing curated score: ${label}`);
  if (existing.rawScore !== score.rawScore && score.accessedAt <= existing.accessedAt) {
    throw new Error(`Replacement is not newer for ${label}`);
  }
  if (existing.rawScore === score.rawScore) {
    return score.accessedAt > existing.accessedAt ? "refresh" : "unchanged";
  }
  return "replace";
}

/**
 * Apply one evidence-backed curation batch. The mutation is deliberately
 * internal: scheduled runs must use a deployment-scoped Convex credential,
 * never an unauthenticated public write endpoint.
 *
 * All writes are idempotent. A score identity is
 * (admin, model, benchmark, normalized source URL). `insert` may only create
 * a missing identity; `replace` may only update an existing identity and must
 * carry a newer accessedAt timestamp when the numeric value changes.
 */
export const applyBatch = internalMutation({
  args: {
    runId: v.string(),
    reportPath: v.string(),
    dryRun: v.boolean(),
    models: v.array(MODEL),
    benches: v.array(BENCH),
    scores: v.array(SCORE),
    evidence: v.array(EVIDENCE),
  },
  handler: async (ctx, args) => {
    if (!RUN_ID_PATTERN.test(args.runId)) {
      throw new Error("runId must use YYYY-MM-DD or YYYY-MM-DD-<letter>");
    }
    if (args.reportPath !== expectedReportPath(args.runId)) {
      throw new Error(`reportPath must be ${expectedReportPath(args.runId)}`);
    }
    if (args.models.length > MAX_MODELS) throw new Error(`Max ${MAX_MODELS} models per batch`);
    if (args.benches.length > MAX_BENCHES) throw new Error(`Max ${MAX_BENCHES} benches per batch`);
    if (args.scores.length > MAX_SCORES) throw new Error(`Max ${MAX_SCORES} scores per batch`);
    if (args.evidence.length > MAX_EVIDENCE) throw new Error(`Max ${MAX_EVIDENCE} evidence rows per batch`);

    const screenshotPrefix = `public/reports/curation/${args.runId}/screenshots/`;
    const evidenceUrls = new Set<string>();
    for (const row of args.evidence) {
      const sourceUrl = normalizePublicHttpUrl(row.sourceUrl);
      normalizePublicHttpUrl(row.screenshotUrl);
      if (!row.screenshotPath.startsWith(screenshotPrefix)) {
        throw new Error(`Screenshot must be stored below ${screenshotPrefix}`);
      }
      if (!/\.(png|jpe?g|webp)$/i.test(row.screenshotPath)) {
        throw new Error(`Unsupported screenshot file: ${row.screenshotPath}`);
      }
      evidenceUrls.add(sourceUrl);
    }

    const models = args.models.map(normalizeModel);
    const benches = args.benches.map(normalizeBench);
    const modelInputs = new Map<string, ModelInput>();
    const benchInputs = new Map<string, BenchInput>();
    for (const model of models) {
      if (modelInputs.has(model.name)) throw new Error(`Duplicate model in batch: ${model.name}`);
      modelInputs.set(model.name, model);
    }
    for (const bench of benches) {
      if (benchInputs.has(bench.slug)) throw new Error(`Duplicate benchmark in batch: ${bench.slug}`);
      if (!evidenceUrls.has(bench.url)) {
        throw new Error(`Benchmark ${bench.slug} has no screenshot-backed evidence for ${bench.url}`);
      }
      benchInputs.set(bench.slug, bench);
    }

    const now = Date.now();
    const scoreKeys = new Set<string>();
    const normalizedScores: ScoreInput[] = args.scores.map((score) => {
      const sourceUrl = normalizePublicHttpUrl(score.sourceUrl);
      if (!Number.isFinite(score.rawScore)) throw new Error(`Invalid score for ${score.modelName}`);
      if (!Number.isFinite(score.accessedAt) || score.accessedAt <= 0 || score.accessedAt > now + 86_400_000) {
        throw new Error(`Invalid accessedAt for ${score.modelName} | ${score.benchSlug}`);
      }
      if (!evidenceUrls.has(sourceUrl)) {
        throw new Error(`Score source has no screenshot-backed evidence: ${sourceUrl}`);
      }
      const normalized = {
        ...score,
        modelName: cleanText(score.modelName, "Score modelName", MAX_NAME_LEN),
        benchSlug: cleanText(score.benchSlug, "Score benchSlug", MAX_NAME_LEN),
        sourceUrl,
      };
      const key = `${normalized.modelName}\n${normalized.benchSlug}\n${sourceUrl}`;
      if (scoreKeys.has(key)) throw new Error(`Duplicate score in batch: ${key.replace(/\n/g, " | ")}`);
      scoreKeys.add(key);
      return normalized;
    });

    const adminId = await findAdminUserId(ctx);
    const admin = await ctx.db.get(adminId);
    const existingModels = await ctx.db.query("models").collect();
    const existingBenches = await ctx.db.query("benches").collect();
    const modelByName = new Map(existingModels.map((model: any) => [model.name, model]));
    const modelBySlug = new Map(existingModels.map((model: any) => [model.slug, model]));
    const benchBySlug = new Map(existingBenches.map((bench: any) => [bench.slug, bench]));

    for (const model of models) {
      const existing: any = modelByName.get(model.name);
      if (existing) {
        if (existing.hidden) throw new Error(`Model is hidden: ${model.name}`);
        if (existing.provider !== model.provider || (existing.familyTag ?? "") !== model.familyTag) {
          throw new Error(`Model metadata conflict: ${model.name}`);
        }
      } else {
        const slugCollision: any = modelBySlug.get(generateSlug(model.name));
        if (slugCollision) {
          throw new Error(`Model slug collision: ${model.name} vs ${slugCollision.name}`);
        }
      }
    }

    for (const bench of benches) {
      const existing: any = benchBySlug.get(bench.slug);
      if (!existing) continue;
      if (existing.hidden) throw new Error(`Benchmark is hidden: ${bench.slug}`);
      if (
        existing.name !== bench.name ||
        existing.scaleMin !== bench.scaleMin ||
        existing.scaleMax !== bench.scaleMax ||
        normalizePublicHttpUrl(existing.url) !== bench.url
      ) {
        throw new Error(`Benchmark metadata conflict: ${bench.slug}`);
      }
    }

    for (const score of normalizedScores) {
      const model: any = modelByName.get(score.modelName) ?? modelInputs.get(score.modelName);
      const bench: any = benchBySlug.get(score.benchSlug) ?? benchInputs.get(score.benchSlug);
      if (!model) throw new Error(`Score references unknown model: ${score.modelName}`);
      if (!bench) throw new Error(`Score references unknown benchmark: ${score.benchSlug}`);
      if (score.rawScore < bench.scaleMin || score.rawScore > bench.scaleMax) {
        throw new Error(`Score ${score.rawScore} out of range for ${score.benchSlug}`);
      }
    }

    const preflightPlans: Array<{ label: string; plan: ScorePlan }> = [];
    for (const score of normalizedScores) {
      const model: any = modelByName.get(score.modelName);
      const bench: any = benchBySlug.get(score.benchSlug);
      const label = `${score.modelName} | ${score.benchSlug}`;
      if (!model || !bench) {
        if (score.operation === "replace") {
          throw new Error(`Cannot replace missing curated score: ${label}`);
        }
        preflightPlans.push({ label, plan: "insert" });
        continue;
      }
      const candidates = await ctx.db
        .query("modelScores")
        .withIndex("by_model_bench", (q: any) =>
          q.eq("modelId", model._id).eq("benchId", bench._id)
        )
        .collect();
      const matching = candidates.filter(
        (row: any) => row.submittedBy === adminId && sourceUrlsMatch(row.sourceUrl, score.sourceUrl)
      );
      if (matching.length > 1) throw new Error(`Ambiguous existing curated score: ${label}`);
      preflightPlans.push({ label, plan: classifyScore(score, matching[0], label) });
    }

    if (args.dryRun) {
      return {
        runId: args.runId,
        dryRun: true,
        modelsToCreate: models.filter((model) => !modelByName.has(model.name)).map((model) => model.name),
        benchesToCreate: benches.filter((bench) => !benchBySlug.has(bench.slug)).map((bench) => bench.slug),
        scoresToInsert: preflightPlans.filter(({ plan }) => plan === "insert").map(({ label }) => label),
        scoresToReplace: preflightPlans.filter(({ plan }) => plan === "replace").map(({ label }) => label),
        scoresToRefresh: preflightPlans.filter(({ plan }) => plan === "refresh").map(({ label }) => label),
        scoresUnchanged: preflightPlans.filter(({ plan }) => plan === "unchanged").map(({ label }) => label),
      };
    }

    const createdModels: string[] = [];
    const createdBenches: string[] = [];
    const insertedScores: string[] = [];
    const replacedScores: string[] = [];
    const refreshedScores: string[] = [];
    const unchangedScores: string[] = [];
    const changedScoreIds: Id<"modelScores">[] = [];

    for (const model of models) {
      if (modelByName.has(model.name)) continue;
      const slug = generateSlug(model.name);
      const modelId = await ctx.db.insert("models", {
        name: model.name,
        provider: model.provider,
        slug,
        familyTag: model.familyTag,
        tags: [],
        addedBy: adminId,
        createdAt: now,
      });
      await ctx.db.insert("modelRankings", {
        modelId,
        name: model.name,
        provider: model.provider,
        slug,
        familyTag: model.familyTag,
        tags: [],
        supraScore: 0,
        benchCount: 0,
        updatedAt: now,
        hidden: false,
      });
      await seedCreatorEntityVote(ctx, "model", modelId as unknown as string, adminId);
      await addTags(ctx, "model", modelId as unknown as string, adminId, model.tags);
      const created = await ctx.db.get(modelId);
      modelByName.set(model.name, created);
      modelBySlug.set(slug, created);
      createdModels.push(model.name);
    }

    for (const bench of benches) {
      if (benchBySlug.has(bench.slug)) continue;
      const benchId = await ctx.db.insert("benches", {
        name: bench.name,
        slug: bench.slug,
        description: bench.description,
        url: bench.url,
        isOfficial: isOfficialUrl(bench.url),
        tags: [],
        scaleMin: bench.scaleMin,
        scaleMax: bench.scaleMax,
        addedBy: adminId,
        createdAt: now,
      });
      await seedCreatorEntityVote(ctx, "bench", benchId as unknown as string, adminId);
      await addTags(ctx, "bench", benchId as unknown as string, adminId, bench.tags);
      await ctx.db.insert("benchQualityRatings", {
        benchId,
        userId: adminId,
        ...bench.rating,
      });
      await recomputeBenchAggregatesInline(ctx, benchId);
      const created = await ctx.db.get(benchId);
      benchBySlug.set(bench.slug, created);
      createdBenches.push(bench.slug);
    }

    const touchedBenches = new Set<string>();
    for (const score of normalizedScores) {
      const model: any = modelByName.get(score.modelName);
      const bench: any = benchBySlug.get(score.benchSlug);
      const normalizedScore =
        Math.round(
          (((score.rawScore - bench.scaleMin) / (bench.scaleMax - bench.scaleMin)) * 100) * 100
        ) / 100;
      const candidates = await ctx.db
        .query("modelScores")
        .withIndex("by_model_bench", (q: any) =>
          q.eq("modelId", model._id).eq("benchId", bench._id)
        )
        .collect();
      const matching = candidates.filter(
        (row: any) => row.submittedBy === adminId && sourceUrlsMatch(row.sourceUrl, score.sourceUrl)
      );
      const label = `${score.modelName} | ${score.benchSlug}`;
      if (matching.length > 1) throw new Error(`Ambiguous existing curated score: ${label}`);
      const existing: any = matching[0];

      const plan = classifyScore(score, existing, label);

      if (plan === "unchanged") {
        unchangedScores.push(label);
        continue;
      }
      if (plan === "refresh") {
        await ctx.db.patch(existing._id, { accessedAt: score.accessedAt });
        changedScoreIds.push(existing._id);
        refreshedScores.push(label);
        continue;
      }
      if (plan === "replace") {
        await ctx.db.patch(existing._id, {
          rawScore: score.rawScore,
          normalizedScore,
          accessedAt: score.accessedAt,
        });
        changedScoreIds.push(existing._id);
        touchedBenches.add(bench._id as string);
        replacedScores.push(label);
        continue;
      }

      const scoreId = await ctx.db.insert("modelScores", {
        modelId: model._id,
        benchId: bench._id,
        rawScore: score.rawScore,
        normalizedScore,
        sourceUrl: score.sourceUrl,
        accessedAt: score.accessedAt,
        submittedBy: adminId,
        createdAt: now,
        upvotes: 1,
        downvotes: 0,
        submitterName: (admin as any)?.name ?? "Florian",
        submitterImage: (admin as any)?.image ?? undefined,
      });
      await ctx.db.insert("votes", {
        targetId: scoreId as unknown as string,
        targetType: "modelScore",
        userId: adminId,
        value: 1,
      });
      changedScoreIds.push(scoreId);
      touchedBenches.add(bench._id as string);
      insertedScores.push(label);
    }

    for (const benchId of touchedBenches) {
      await recomputeBenchAggregatesInline(ctx, benchId as Id<"benches">);
    }
    if (changedScoreIds.length > 0) {
      await ctx.scheduler.runAfter(0, internal.scoresWorker.mirrorScoresAndRebuild, {
        scoreIds: changedScoreIds,
      });
    }

    return {
      runId: args.runId,
      dryRun: false,
      createdModels,
      createdBenches,
      insertedScores,
      replacedScores,
      refreshedScores,
      unchangedScores,
      mirroredScores: changedScoreIds.length,
    };
  },
});
