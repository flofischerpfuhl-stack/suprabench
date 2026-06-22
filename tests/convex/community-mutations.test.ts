// ════════════════════════════════════════════════════════════
// COMMUNITY MUTATION CONTRACTS.
//
// The audit report flagged that the public mutation surface used
// by every signed-in visitor — submission votes, tag votes, entity
// votes, bench-quality ratings, the abuse rate-limiter, and the
// admin authorization gate — had no direct unit tests. The
// adversarial-robustness suite exercises all of them transitively
// but only checks the *aggregate* output (SupraScore must shrink
// under attack X). When one of these mutations regresses on its
// own contract — e.g. tag-vote toggle behaviour, or admin
// authorization — that suite passes while the user-facing
// behaviour breaks.
//
// This file is the per-mutation contract guard. Each describe()
// block targets one file under convex/ and asserts the documented
// behaviour with the smallest possible fixture. Anything that
// requires the SupraScore math to actually move stays in the
// adversarial suite.
//
// All tests run in <1s combined. They use convex-test (real
// runtime in-process) and exercise the public mutation API the
// way a real signed-in browser would, including:
//   • auth required → "Not authenticated"
//   • upsert / toggle / switch semantics
//   • per-day rate limit (`enforceDailyActionLimit`)
//   • input validation (1-5 dimensions, max tag length, etc.)
//   • admin gate (`assertAdmin`)
//
// The Convex scheduler may queue rebuild actions after some of
// these mutations. We don't drain it: the assertion here is
// "the mutation handler did the right thing in its own
// transaction"; ranking-rebuild correctness is covered by
// d1-migration.test.ts and adversarial-robustness.test.ts.
// ════════════════════════════════════════════════════════════

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { setupTestDb as rawSetupTestDb, api } from "./_fixtures";

// Tracks every test-db instance the current test created so the
// afterEach hook can drain its scheduled-function queue. Without
// this, vote / rating mutations leave `mirrorScoresAndRebuild`
// or `recomputeForBenchFromD1` pending in the scheduler; those
// fire after the test transaction has closed and convex-test
// raises a "Write outside of transaction" unhandled rejection.
const _activeTestDbs: Array<ReturnType<typeof rawSetupTestDb>> = [];
function setupTestDb() {
  const t = rawSetupTestDb();
  _activeTestDbs.push(t);
  return t;
}

beforeEach(() => {
  _activeTestDbs.length = 0;
  // The vote / rating mutations schedule actions that mirror
  // scores to the Cloudflare D1 worker. We're not testing the
  // mirror here — silence the network so the scheduler doesn't
  // throw "fetch is not defined" / "ECONNREFUSED" when it later
  // runs the action. d1-migration.test.ts already covers the
  // mirror end-to-end.
  vi.stubEnv("SCORES_WORKER_URL", "https://fake-scores-worker.test");
  vi.stubEnv("SCORES_WORKER_SECRET", "test-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.startsWith("/scores")) {
        return new Response(JSON.stringify({ scores: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    })
  );
});

afterEach(async () => {
  // Yield + drain so the scheduler executes any tail of the
  // chain (mirror → rebuild → persist) before the test's
  // transaction context disappears. Same fix d1-migration.test.ts
  // uses; see its comment for the full rationale.
  await new Promise((r) => setTimeout(r, 20));
  for (const t of _activeTestDbs) {
    try {
      await t.finishAllScheduledFunctions(() => {});
    } catch {
      // The drain itself may surface a scheduled-action failure
      // (e.g. mirror's POST returning a 200 with empty body that
      // confuses the next step). We don't care — this hook only
      // exists so unhandled rejections don't pollute teardown.
    }
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ─── Tiny shared seeding helpers ────────────────────────────
// Kept inline (rather than in _fixtures.ts) because every test
// in this file needs a slightly different shape and the
// boilerplate is genuinely small.

async function seedUser(
  t: ReturnType<typeof setupTestDb>,
  email = "u@test.internal",
  name = "U"
) {
  return await t.run((ctx) =>
    ctx.db.insert("users", { name, email } as any)
  );
}

async function seedAdminUser(
  t: ReturnType<typeof setupTestDb>,
  isPrimary: boolean,
) {
  // Primary admin is identified solely by email, so no userRoles
  // row needed. Promoted admin needs the row.
  if (isPrimary) {
    return await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Primary",
        email: "flofischer.pfuhl@gmail.com",
      } as any)
    );
  }
  const userId = await seedUser(t, "promoted@test.internal", "Promoted");
  await t.run((ctx) =>
    ctx.db.insert("userRoles", {
      userId,
      role: "admin",
      updatedAt: Date.now(),
    } as any)
  );
  return userId;
}

async function seedBench(
  t: ReturnType<typeof setupTestDb>,
  ownerId: any,
  name = "Test Bench"
) {
  return await t.run(async (ctx) => {
    const id = await ctx.db.insert("benches", {
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-"),
      description: name,
      url: "https://arxiv.org/abs/2026.00001",
      isOfficial: true,
      tags: [],
      scaleMin: 0,
      scaleMax: 100,
      addedBy: ownerId,
      createdAt: Date.now(),
    });
    return id;
  });
}

async function seedModel(
  t: ReturnType<typeof setupTestDb>,
  ownerId: any,
  name = "Test Model"
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("models", {
      name,
      provider: "TestLab",
      slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-"),
      tags: [],
      addedBy: ownerId,
      createdAt: Date.now(),
    });
  });
}

async function seedScore(
  t: ReturnType<typeof setupTestDb>,
  ownerId: any,
  modelId: any,
  benchId: any
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("modelScores", {
      modelId,
      benchId,
      rawScore: 80,
      normalizedScore: 80,
      sourceUrl: "https://example.com/source",
      accessedAt: Date.now(),
      submittedBy: ownerId,
      createdAt: Date.now(),
      upvotes: 0,
      downvotes: 0,
      submitterName: "fixture",
    });
  });
}

const asSubject = (id: any) => ({ subject: id as unknown as string });

// ════════════════════════════════════════════════════════════
// votes.cast — score upvote / downvote / toggle / switch
// ════════════════════════════════════════════════════════════

describe("votes.cast (modelScores)", () => {
  it("requires authentication", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const benchId = await seedBench(t, owner);
    const modelId = await seedModel(t, owner);
    const scoreId = await seedScore(t, owner, modelId, benchId);

    await expect(
      t.mutation(api.votes.cast, { targetId: String(scoreId), value: 1 })
    ).rejects.toThrow(/not authenticated/i);
  });

  it("upvote increments upvotes; getMyVote returns 1", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const voter = await seedUser(t, "voter@test.internal", "Voter");
    const benchId = await seedBench(t, owner);
    const modelId = await seedModel(t, owner);
    const scoreId = await seedScore(t, owner, modelId, benchId);

    await t
      .withIdentity(asSubject(voter))
      .mutation(api.votes.cast, { targetId: String(scoreId), value: 1 });

    const after = await t.run((ctx) => ctx.db.get(scoreId));
    expect(after?.upvotes).toBe(1);
    expect(after?.downvotes).toBe(0);

    const mine = await t
      .withIdentity(asSubject(voter))
      .query(api.votes.getMyVote, { targetId: String(scoreId) });
    expect(mine).toBe(1);
  });

  it("re-voting the same direction toggles the vote off", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const voter = await seedUser(t, "v@test.internal", "V");
    const benchId = await seedBench(t, owner);
    const modelId = await seedModel(t, owner);
    const scoreId = await seedScore(t, owner, modelId, benchId);

    await t
      .withIdentity(asSubject(voter))
      .mutation(api.votes.cast, { targetId: String(scoreId), value: 1 });
    await t
      .withIdentity(asSubject(voter))
      .mutation(api.votes.cast, { targetId: String(scoreId), value: 1 });

    const after = await t.run((ctx) => ctx.db.get(scoreId));
    expect(after?.upvotes).toBe(0);
    const mine = await t
      .withIdentity(asSubject(voter))
      .query(api.votes.getMyVote, { targetId: String(scoreId) });
    expect(mine).toBeNull();
  });

  it("flipping the direction moves the vote, not duplicates it", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const voter = await seedUser(t, "v@test.internal", "V");
    const benchId = await seedBench(t, owner);
    const modelId = await seedModel(t, owner);
    const scoreId = await seedScore(t, owner, modelId, benchId);

    await t
      .withIdentity(asSubject(voter))
      .mutation(api.votes.cast, { targetId: String(scoreId), value: 1 });
    await t
      .withIdentity(asSubject(voter))
      .mutation(api.votes.cast, { targetId: String(scoreId), value: -1 });

    const after = await t.run((ctx) => ctx.db.get(scoreId));
    expect(after?.upvotes).toBe(0);
    expect(after?.downvotes).toBe(1);
  });

  it("rejects votes against a non-existent submission", async () => {
    const t = setupTestDb();
    const voter = await seedUser(t);
    await expect(
      t
        .withIdentity(asSubject(voter))
        .mutation(api.votes.cast, {
          // Random plausible-looking id that doesn't exist.
          targetId: "k571gvadefhe7nx5dazb0p2zfk7m1ned",
          value: 1,
        })
    ).rejects.toThrow(/submission not found/i);
  });
});

// ════════════════════════════════════════════════════════════
// tagVotes.cast — votes that change effective tag set
// ════════════════════════════════════════════════════════════

describe("tagVotes.cast", () => {
  it("requires authentication", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const modelId = await seedModel(t, owner);
    await expect(
      t.mutation(api.tagVotes.cast, {
        entityType: "model",
        entityId: String(modelId),
        tag: "reasoning",
        value: 1,
      })
    ).rejects.toThrow(/not authenticated/i);
  });

  it("normalises tag (trim + lowercase) before storing", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const voter = await seedUser(t, "v@t.internal", "V");
    const modelId = await seedModel(t, owner);

    await t
      .withIdentity(asSubject(voter))
      .mutation(api.tagVotes.cast, {
        entityType: "model",
        entityId: String(modelId),
        tag: "  ReAsOnInG  ",
        value: 1,
      });

    const list = await t.query(api.tagVotes.listForEntity, {
      entityType: "model",
      entityId: String(modelId),
    });
    expect(list).toHaveLength(1);
    expect(list[0].tag).toBe("reasoning");
    expect(list[0].score).toBe(1);
  });

  it("a positive net tag vote propagates to model.tags", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const voter = await seedUser(t, "v@t.internal", "V");
    const modelId = await seedModel(t, owner);

    await t
      .withIdentity(asSubject(voter))
      .mutation(api.tagVotes.cast, {
        entityType: "model",
        entityId: String(modelId),
        tag: "vision",
        value: 1,
      });

    const m = await t.run((ctx) => ctx.db.get(modelId));
    expect(m?.tags).toEqual(["vision"]);
  });

  it("rejects tags longer than 30 chars", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const voter = await seedUser(t, "v@t.internal", "V");
    const modelId = await seedModel(t, owner);

    await expect(
      t
        .withIdentity(asSubject(voter))
        .mutation(api.tagVotes.cast, {
          entityType: "model",
          entityId: String(modelId),
          tag: "x".repeat(31),
          value: 1,
        })
    ).rejects.toThrow(/tag too long/i);
  });

  it("rejects an empty tag (whitespace only)", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const voter = await seedUser(t, "v@t.internal", "V");
    const modelId = await seedModel(t, owner);

    await expect(
      t
        .withIdentity(asSubject(voter))
        .mutation(api.tagVotes.cast, {
          entityType: "model",
          entityId: String(modelId),
          tag: "   ",
          value: 1,
        })
    ).rejects.toThrow(/empty tag/i);
  });
});

// ════════════════════════════════════════════════════════════
// entityVotes.cast — fakes get hidden, established stays
// ════════════════════════════════════════════════════════════

describe("entityVotes.cast + auto-hide", () => {
  it("requires authentication", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const benchId = await seedBench(t, owner);
    await expect(
      t.mutation(api.entityVotes.cast, {
        entityType: "bench",
        entityId: String(benchId),
        value: -1,
      })
    ).rejects.toThrow(/not authenticated/i);
  });

  it("returns 'downsToHide' that matches MIN_DOWNS_FLOOR for a fresh entity", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const benchId = await seedBench(t, owner);

    const status = await t.query(api.entityVotes.getForEntity, {
      entityType: "bench",
      entityId: String(benchId),
    });
    expect(status.score).toBe(0);
    expect(status.minDownsFloor).toBe(5);
    // No votes yet → exactly MIN_DOWNS_FLOOR downvotes are needed.
    expect(status.downsToHide).toBe(5);
  });

  it("five sockpuppet downvotes hide a fresh bench (MIN_DOWNS_FLOOR rule)", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const benchId = await seedBench(t, owner);

    for (let i = 0; i < 5; i++) {
      const u = await seedUser(t, `down-${i}@t.internal`, `D${i}`);
      await t
        .withIdentity(asSubject(u))
        .mutation(api.entityVotes.cast, {
          entityType: "bench",
          entityId: String(benchId),
          value: -1,
        });
    }
    const b = await t.run((ctx) => ctx.db.get(benchId));
    expect(b?.hidden).toBe(true);
  });

  it("five downvotes do NOT hide an established bench (60% ratio rule)", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const benchId = await seedBench(t, owner);

    // 8 upvoters first → established.
    for (let i = 0; i < 8; i++) {
      const u = await seedUser(t, `up-${i}@t.internal`, `U${i}`);
      await t
        .withIdentity(asSubject(u))
        .mutation(api.entityVotes.cast, {
          entityType: "bench",
          entityId: String(benchId),
          value: 1,
        });
    }
    // Now 5 downvotes — enough to clear the floor, but ratio is
    // 5 / 13 ≈ 38 % which is below the 60 % ceiling. Must NOT hide.
    for (let i = 0; i < 5; i++) {
      const u = await seedUser(t, `bad-${i}@t.internal`, `B${i}`);
      await t
        .withIdentity(asSubject(u))
        .mutation(api.entityVotes.cast, {
          entityType: "bench",
          entityId: String(benchId),
          value: -1,
        });
    }

    const b = await t.run((ctx) => ctx.db.get(benchId));
    expect(b?.hidden ?? false).toBe(false);
  });

  it("toggling the same vote off restores the prior state", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const voter = await seedUser(t, "v@t.internal", "V");
    const benchId = await seedBench(t, owner);

    await t
      .withIdentity(asSubject(voter))
      .mutation(api.entityVotes.cast, {
        entityType: "bench",
        entityId: String(benchId),
        value: 1,
      });
    await t
      .withIdentity(asSubject(voter))
      .mutation(api.entityVotes.cast, {
        entityType: "bench",
        entityId: String(benchId),
        value: 1,
      });

    const status = await t
      .withIdentity(asSubject(voter))
      .query(api.entityVotes.getForEntity, {
        entityType: "bench",
        entityId: String(benchId),
      });
    expect(status.score).toBe(0);
    expect(status.myVote).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════
// benchQualityRatings.rate — five 1-5 dimensions, upsert
// ════════════════════════════════════════════════════════════

describe("benchQualityRatings.rate", () => {
  it("requires authentication", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const benchId = await seedBench(t, owner);
    await expect(
      t.mutation(api.benchQualityRatings.rate, {
        benchId,
        relevance: 5,
        contamination: 5,
        discriminability: 5,
        reproducibility: 5,
        difficulty: 3,
      })
    ).rejects.toThrow(/not authenticated/i);
  });

  it("accepts the documented integer 1-5 range", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const rater = await seedUser(t, "r@t.internal", "R");
    const benchId = await seedBench(t, owner);

    await t
      .withIdentity(asSubject(rater))
      .mutation(api.benchQualityRatings.rate, {
        benchId,
        relevance: 4,
        contamination: 5,
        discriminability: 3,
        reproducibility: 4,
        difficulty: 2,
      });

    const mine = await t
      .withIdentity(asSubject(rater))
      .query(api.benchQualityRatings.getMyRating, { benchId });
    expect(mine).toMatchObject({
      relevance: 4,
      contamination: 5,
      discriminability: 3,
      reproducibility: 4,
      difficulty: 2,
    });
  });

  it("rejects out-of-range or non-integer dimensions", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const rater = await seedUser(t, "r@t.internal", "R");
    const benchId = await seedBench(t, owner);

    await expect(
      t
        .withIdentity(asSubject(rater))
        .mutation(api.benchQualityRatings.rate, {
          benchId,
          relevance: 0,
          contamination: 5,
          discriminability: 3,
          reproducibility: 4,
          difficulty: 2,
        })
    ).rejects.toThrow(/integer between 1 and 5/i);

    await expect(
      t
        .withIdentity(asSubject(rater))
        .mutation(api.benchQualityRatings.rate, {
          benchId,
          relevance: 6,
          contamination: 5,
          discriminability: 3,
          reproducibility: 4,
          difficulty: 2,
        })
    ).rejects.toThrow(/integer between 1 and 5/i);

    await expect(
      t
        .withIdentity(asSubject(rater))
        .mutation(api.benchQualityRatings.rate, {
          benchId,
          relevance: 3.5,
          contamination: 5,
          discriminability: 3,
          reproducibility: 4,
          difficulty: 2,
        })
    ).rejects.toThrow(/integer between 1 and 5/i);
  });

  it("rate is upsert: re-rating overwrites, doesn't insert", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const rater = await seedUser(t, "r@t.internal", "R");
    const benchId = await seedBench(t, owner);

    for (const v of [3, 4]) {
      await t
        .withIdentity(asSubject(rater))
        .mutation(api.benchQualityRatings.rate, {
          benchId,
          relevance: v,
          contamination: v,
          discriminability: v,
          reproducibility: v,
          difficulty: v,
        });
    }

    const all = await t.run((ctx) =>
      ctx.db
        .query("benchQualityRatings")
        .withIndex("by_bench_user", (q) =>
          q.eq("benchId", benchId).eq("userId", rater)
        )
        .collect()
    );
    expect(all).toHaveLength(1);
    expect(all[0].relevance).toBe(4);
  });

  it("hidden benches reject new ratings", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const rater = await seedUser(t, "r@t.internal", "R");
    const benchId = await seedBench(t, owner);

    await t.run((ctx) => ctx.db.patch(benchId, { hidden: true }));

    await expect(
      t
        .withIdentity(asSubject(rater))
        .mutation(api.benchQualityRatings.rate, {
          benchId,
          relevance: 5,
          contamination: 5,
          discriminability: 5,
          reproducibility: 5,
          difficulty: 5,
        })
    ).rejects.toThrow(/removed by the community/i);
  });
});

// ════════════════════════════════════════════════════════════
// abuse.enforceDailyActionLimit — exercised through tagVotes
// ════════════════════════════════════════════════════════════
//
// We don't test the helper directly (it's not exposed) — we
// hammer one mutation that uses it and verify the documented
// error fires at the documented count. Different mutations use
// different limits; pick tag-votes (limit = 300) but lower it
// indirectly by writing the counter row directly.

describe("abuse.enforceDailyActionLimit (via tagVotes)", () => {
  it("blocks once the per-day limit is reached", async () => {
    const t = setupTestDb();
    const owner = await seedUser(t);
    const voter = await seedUser(t, "v@t.internal", "V");
    const modelId = await seedModel(t, owner);

    // Pre-seed the action counter at the limit so the next tag
    // vote should be rejected immediately without us having to
    // perform 300 real mutations.
    const today = new Date();
    const yyyymmdd = `${today.getUTCFullYear()}-${String(
      today.getUTCMonth() + 1
    ).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
    await t.run((ctx) =>
      ctx.db.insert("actionCounters", {
        userId: voter,
        action: "tag-vote",
        yyyymmdd,
        count: 300,
        updatedAt: Date.now(),
      } as any)
    );

    await expect(
      t
        .withIdentity(asSubject(voter))
        .mutation(api.tagVotes.cast, {
          entityType: "model",
          entityId: String(modelId),
          tag: "after-limit",
          value: 1,
        })
    ).rejects.toThrow(/rate limit/i);
  });
});

// ════════════════════════════════════════════════════════════
// admin.assertAdmin — gate on the admin board
// ════════════════════════════════════════════════════════════

describe("admin authorization (assertAdmin gate)", () => {
  it("rejects an anonymous caller", async () => {
    const t = setupTestDb();
    await expect(
      t.query(api.admin.searchUsers, { query: "anybody" })
    ).rejects.toThrow(/unauthorized|not signed in/i);
  });

  it("rejects a regular signed-in user", async () => {
    const t = setupTestDb();
    const u = await seedUser(t, "regular@t.internal", "Regular");
    await expect(
      t
        .withIdentity(asSubject(u))
        .query(api.admin.searchUsers, { query: "anybody" })
    ).rejects.toThrow(/forbidden|admin only/i);
  });

  it("primary admin (by email) passes the gate", async () => {
    const t = setupTestDb();
    const adm = await seedAdminUser(t, /*isPrimary=*/ true);
    const result = await t
      .withIdentity(asSubject(adm))
      .query(api.admin.searchUsers, { query: "primary" });
    expect(Array.isArray(result)).toBe(true);
  });

  it("promoted admin (userRoles row) passes the gate", async () => {
    const t = setupTestDb();
    const adm = await seedAdminUser(t, /*isPrimary=*/ false);
    const result = await t
      .withIdentity(asSubject(adm))
      .query(api.admin.searchUsers, { query: "promoted" });
    expect(Array.isArray(result)).toBe(true);
  });

  it("listElevatedAccounts returns the primary admin even with no userRoles row", async () => {
    const t = setupTestDb();
    const adm = await seedAdminUser(t, /*isPrimary=*/ true);
    const result = await t
      .withIdentity(asSubject(adm))
      .query(api.admin.listElevatedAccounts, {});
    expect(result.some((r: any) => r.isPrimaryAdmin)).toBe(true);
  });
});
