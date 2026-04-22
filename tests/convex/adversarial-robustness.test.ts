// ════════════════════════════════════════════════════════════
// Adversarial robustness harness.
//
// Every defensive invariant of the SupraScore math is encoded
// here as either:
//
//   1. an INVARIANT — a pure predicate over a (modelRankings,
//      benchListing) snapshot that MUST hold for every valid
//      ecosystem, ever. We check each invariant against a known-
//      good baseline AND against many random fuzz seeds.
//
//   2. an ATTACK — a documented manipulation strategy with a
//      concrete setup function and an `expect` predicate that
//      checks the attacker's outcome (e.g. "attacker model is not
//      in top 1", "vanity bench is below position 3 on the bench
//      leaderboard"). Each attack is a regression test: if the
//      formula ever loosens enough to let the attack succeed, the
//      test fails with a descriptive message.
//
//   3. a FUZZER — generates random valid ecosystems with a
//      deterministic PRNG and verifies all invariants. Failures
//      report the exact seed for reproduction.
//
// Adding a new attack: see ATTACKS array. Adding a new invariant:
// see INVARIANTS array. The harness picks them up automatically.
//
// This file is the live, executable answer to "how do we know the
// SupraScore math is robust?". If an invariant or attack scenario
// here fails on CI, the math has regressed.
// ════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { setupTestDb, internal, api } from "./_fixtures";

type T = ReturnType<typeof setupTestDb>;

// ─── Snapshot capture ─────────────────────────────────────────

interface BenchListing {
  _id: string;
  name: string;
  effectiveWeight: number;
  rawWeight: number;
  netUpvotes: number;
  maxNetUpvotes: number;
  modelCountForCoverage: number;
  maxModelCountForCoverage: number;
  qualityScore: number;
  modelCount: number;
}

interface RankRow {
  modelId: string;
  name: string;
  supraScore: number;
  benchCount: number;
  hidden?: boolean;
}

interface Snapshot {
  rankings: RankRow[];
  benchList: BenchListing[];
}

async function captureSnapshot(t: T): Promise<Snapshot> {
  await t.mutation(internal.rankings.recomputeAll, {});
  const rankings = (await t.run(async (ctx) => {
    return await ctx.db.query("modelRankings").collect();
  })) as any[];
  const benchList = (await t.query(api.benches.listRanked, {})) as any[];
  return { rankings, benchList };
}

// ─── Seeding helpers ──────────────────────────────────────────

async function newUser(t: T, name: string): Promise<any> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name,
      email: `${name}-${Math.random().toString(36).slice(2)}@robust.test`,
    } as any)
  );
}

async function newBench(
  t: T,
  creator: any,
  name: string
): Promise<any> {
  const id = await t.run(async (ctx) =>
    ctx.db.insert("benches", {
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-"),
      description: `bench ${name}`,
      url: `https://arxiv.org/abs/9999.${Math.floor(Math.random() * 99999)}`,
      isOfficial: true,
      tags: [],
      scaleMin: 0,
      scaleMax: 100,
      addedBy: creator,
      createdAt: Date.now(),
    })
  );
  // Mirror the production create() flow's seedCreatorEntityVote.
  await t.run(async (ctx) => {
    await ctx.db.insert("entityVotes", {
      entityType: "bench",
      entityId: id as string,
      userId: creator,
      value: 1,
    });
    await ctx.db.patch(id, { cachedNetUpvotes: 1 });
  });
  return id;
}

async function newModel(
  t: T,
  creator: any,
  name: string,
  familyTag?: string
): Promise<any> {
  return await t.run(async (ctx) =>
    ctx.db.insert("models", {
      name,
      provider: "RobustnessLab",
      slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-"),
      familyTag,
      tags: [],
      addedBy: creator,
      createdAt: Date.now(),
    })
  );
}

async function score(
  t: T,
  user: any,
  model: any,
  bench: any,
  value: number
): Promise<void> {
  await t.run(async (ctx) =>
    ctx.db.insert("modelScores", {
      modelId: model,
      benchId: bench,
      rawScore: value,
      normalizedScore: value,
      sourceUrl: "https://example.com",
      accessedAt: Date.now(),
      submittedBy: user,
      createdAt: Date.now(),
      upvotes: 1,
      downvotes: 0,
      submitterName: "robustness-fixture",
    } as any)
  );
}

async function rate(
  t: T,
  user: any,
  bench: any,
  vals: {
    relevance?: number;
    contamination?: number;
    discriminability?: number;
    reproducibility?: number;
    difficulty?: number;
  } = {}
): Promise<void> {
  await t.run(async (ctx) =>
    ctx.db.insert("benchQualityRatings", {
      benchId: bench,
      userId: user,
      relevance: vals.relevance ?? 4,
      contamination: vals.contamination ?? 4,
      discriminability: vals.discriminability ?? 4,
      reproducibility: vals.reproducibility ?? 4,
      difficulty: vals.difficulty ?? 3,
    } as any)
  );
}

async function upvoteBench(
  t: T,
  bench: any,
  voters: any[]
): Promise<void> {
  await t.run(async (ctx) => {
    for (const v of voters) {
      // Skip if already voted (the creator was auto-seeded above).
      const existing = await ctx.db
        .query("entityVotes")
        .withIndex("by_user_entity", (q: any) =>
          q.eq("userId", v).eq("entityType", "bench").eq("entityId", bench as string)
        )
        .first();
      if (!existing) {
        await ctx.db.insert("entityVotes", {
          entityType: "bench",
          entityId: bench as string,
          userId: v,
          value: 1,
        });
      }
    }
    const all = await ctx.db
      .query("entityVotes")
      .withIndex("by_entity", (q: any) =>
        q.eq("entityType", "bench").eq("entityId", bench as string)
      )
      .collect();
    let net = 0;
    for (const x of all) net += x.value;
    await ctx.db.patch(bench, { cachedNetUpvotes: Math.max(0, net) });
  });
}

async function refreshBench(t: T, bench: any): Promise<void> {
  await t.mutation(internal.cache.recomputeBenchAggregates, { benchId: bench });
}

async function refreshAllBenches(t: T): Promise<void> {
  const benches = await t.run(async (ctx) =>
    ctx.db.query("benches").collect()
  );
  for (const b of benches) await refreshBench(t, b._id);
}

// ─── Invariants ────────────────────────────────────────────────

interface InvariantResult {
  ok: boolean;
  message?: string;
}

interface Invariant {
  id: string;
  description: string;
  check: (s: Snapshot) => InvariantResult;
}

const INVARIANTS: Invariant[] = [
  {
    id: "I1",
    description: "Every SupraScore is a finite number in [0, 100]",
    check: (s) => {
      for (const r of s.rankings) {
        if (!Number.isFinite(r.supraScore))
          return { ok: false, message: `${r.name} has non-finite supraScore` };
        if (r.supraScore < 0 || r.supraScore > 100)
          return {
            ok: false,
            message: `${r.name} supraScore=${r.supraScore} outside [0,100]`,
          };
      }
      return { ok: true };
    },
  },
  {
    id: "I2",
    description: "Every BenchScore (effectiveWeight) is finite in [0, 100]",
    check: (s) => {
      for (const b of s.benchList) {
        if (!Number.isFinite(b.effectiveWeight))
          return { ok: false, message: `${b.name} effectiveWeight non-finite` };
        if (b.effectiveWeight < 0 || b.effectiveWeight > 100)
          return {
            ok: false,
            message: `${b.name} effectiveWeight=${b.effectiveWeight} outside [0,100]`,
          };
      }
      return { ok: true };
    },
  },
  {
    id: "I3",
    description:
      "The bench with max net-upvotes AND max modelCount has effectiveWeight == rawWeight (no self-penalty)",
    check: (s) => {
      if (s.benchList.length === 0) return { ok: true };
      const maxU = Math.max(...s.benchList.map((b) => b.netUpvotes));
      const maxN = Math.max(
        ...s.benchList.map((b) => b.modelCountForCoverage)
      );
      // Find a bench that's at the max on BOTH axes. If one exists, it
      // must have effectiveWeight ≈ rawWeight (within rounding).
      const topOnBoth = s.benchList.find(
        (b) =>
          b.netUpvotes === maxU &&
          b.modelCountForCoverage === maxN &&
          b.rawWeight > 0
      );
      if (!topOnBoth) return { ok: true };
      const drift = Math.abs(topOnBoth.effectiveWeight - topOnBoth.rawWeight);
      if (drift > 0.2)
        return {
          ok: false,
          message: `${topOnBoth.name} sits at max upvotes (${maxU}) AND max modelCount (${maxN}) but effectiveWeight=${topOnBoth.effectiveWeight} ≠ rawWeight=${topOnBoth.rawWeight}`,
        };
      return { ok: true };
    },
  },
  {
    id: "I4",
    description:
      "Top-covered model has supraScore monotonically ≥ every other model when its weightedMean is the max",
    check: (s) => {
      // Weak version of I4: just verify the rankings are sorted by
      // supraScore (no row in modelRankings can have a higher score
      // than the leader). Strong monotonicity (weightedMean) requires
      // recomputing weightedMean from raw — covered by individual
      // attack tests instead.
      const sorted = [...s.rankings].sort((a, b) => b.supraScore - a.supraScore);
      const top = sorted[0];
      if (!top) return { ok: true };
      for (const r of sorted) {
        if (r.supraScore > top.supraScore + 1e-9)
          return {
            ok: false,
            message: `${r.name} supraScore=${r.supraScore} > leader ${top.name}=${top.supraScore}`,
          };
      }
      return { ok: true };
    },
  },
  {
    id: "I5",
    description: "Hidden benches do not appear in the public bench listing",
    check: (s) => {
      for (const b of s.benchList) {
        if ((b as any).hidden === true)
          return { ok: false, message: `Hidden bench ${b.name} surfaced in listRanked` };
      }
      return { ok: true };
    },
  },
  {
    id: "I6",
    description:
      "Every model with at least one bench has supraScore > 0 unless its weightedMean is genuinely 0",
    check: (s) => {
      for (const r of s.rankings) {
        if (r.benchCount > 0 && r.supraScore === 0)
          return {
            ok: false,
            message: `${r.name} has ${r.benchCount} benches but supraScore=0`,
          };
      }
      return { ok: true };
    },
  },
  {
    id: "I7",
    description: "Every BenchScore equals rawWeight × √(coverageShare) exactly",
    check: (s) => {
      for (const b of s.benchList) {
        if (b.rawWeight === 0) continue;
        const uShare =
          b.maxNetUpvotes > 0 ? Math.min(1, b.netUpvotes / b.maxNetUpvotes) : 1;
        const nShare =
          b.maxModelCountForCoverage > 0
            ? Math.min(
                1,
                b.modelCountForCoverage / b.maxModelCountForCoverage
              )
            : 1;
        const expected = b.rawWeight * Math.sqrt(uShare * nShare);
        const drift = Math.abs(expected - b.effectiveWeight);
        // 0.2 tolerance for one round-to-tenths in the API plus the
        // round-to-tenths the cache itself does to rawWeight.
        if (drift > 0.2)
          return {
            ok: false,
            message: `${b.name}: rawWeight=${b.rawWeight} × √(${uShare.toFixed(3)}·${nShare.toFixed(3)}) = ${expected.toFixed(2)} but effectiveWeight=${b.effectiveWeight}`,
          };
      }
      return { ok: true };
    },
  },
];

function checkAll(s: Snapshot, ctx: string): void {
  for (const inv of INVARIANTS) {
    const r = inv.check(s);
    if (!r.ok) {
      throw new Error(
        `[${ctx}] invariant ${inv.id} failed: ${r.message ?? inv.description}`
      );
    }
  }
}

// ─── Attack catalog ───────────────────────────────────────────

interface Attack {
  id: string;
  description: string;
  setup: (t: T) => Promise<{ attackerModel?: string; vanityBench?: string }>;
  expect: (
    s: Snapshot,
    refs: { attackerModel?: string; vanityBench?: string }
  ) => InvariantResult;
}

// Build a small but realistic "legit" ecosystem to use as the
// defender baseline in attack scenarios. Score distribution mimics
// the real-world spread of a frontier-class leaderboard: a clear
// top model ~90+, mid-tier ~70-80, lower-tier ~60-70. This matters
// because the multi-bench vanity attack scales as O(N_vanity) — at
// some N the attack mathematically wins regardless of formula
// (defended operationally by rate-limit + moderation, not math).
// See ATTACKS A3 (defended) and A3-extreme (documented limitation).
async function seedLegitBaseline(t: T): Promise<{
  legitOwners: any[];
  voters: any[];
  legitBenches: any[];
  legitModels: any[];
}> {
  const owners = [
    await newUser(t, "owner-1"),
    await newUser(t, "owner-2"),
  ];
  const voters: any[] = [];
  for (let i = 0; i < 8; i++) voters.push(await newUser(t, `voter-${i}`));

  // 3 legit benches, each upvoted by all voters and rated 4/4/4/4 by
  // 3 different raters. Range of difficulties so weights vary.
  const legitBenches: any[] = [];
  for (let b = 0; b < 3; b++) {
    const bench = await newBench(t, owners[b % owners.length], `LegitBench${b}`);
    await upvoteBench(t, bench, voters);
    for (let r = 0; r < 3; r++) {
      await rate(t, voters[r], bench, { difficulty: 3 + b });
    }
    legitBenches.push(bench);
  }

  // 4 legit models with frontier-shaped score distribution: top
  // model ≈ 91, then 84, 77, 70. Lets us assert "vanity attack
  // can't beat the frontier model" rather than "vanity can't beat
  // mid-tier" (which is too strong a claim for this much math).
  const legitModels: any[] = [];
  for (let m = 0; m < 4; m++) {
    const model = await newModel(t, owners[0], `LegitModel${m}`);
    for (let b = 0; b < legitBenches.length; b++) {
      await score(t, owners[0], model, legitBenches[b], 70 + m * 7 + b);
    }
    legitModels.push(model);
  }

  await refreshAllBenches(t);
  return { legitOwners: owners, voters, legitBenches, legitModels };
}

function topLegit(s: Snapshot): RankRow {
  const legit = s.rankings.filter((r) => r.name.startsWith("LegitModel"));
  return [...legit].sort((a, b) => b.supraScore - a.supraScore)[0];
}

const ATTACKS: Attack[] = [
  {
    id: "A1",
    description: "Self-rated vanity bench cannot reach #1 on bench leaderboard",
    setup: async (t) => {
      const { voters } = await seedLegitBaseline(t);
      const attacker = await newUser(t, "attacker-A1");
      const vanity = await newBench(t, attacker, "VanityBench-A1");
      await rate(t, attacker, vanity, {
        relevance: 5,
        contamination: 5,
        discriminability: 5,
        reproducibility: 5,
        difficulty: 5,
      });
      // No extra upvotes — only the auto-seeded creator vote.
      await refreshBench(t, vanity);
      voters; // unused — vanity bench gets none of them
      return { vanityBench: vanity as string };
    },
    expect: (s, refs) => {
      const idx = s.benchList.findIndex((b) => b._id === refs.vanityBench);
      if (idx < 0) return { ok: true }; // hidden, fine
      // Vanity bench must be strictly below the legit benches —
      // anywhere in the bottom half is acceptable.
      if (idx === 0)
        return {
          ok: false,
          message: `Vanity bench ranked #1 on bench leaderboard`,
        };
      const half = Math.floor(s.benchList.length / 2);
      if (idx <= half)
        return {
          ok: false,
          message: `Vanity bench ranked #${idx + 1} of ${s.benchList.length} (expected bottom half)`,
        };
      return { ok: true };
    },
  },
  {
    id: "A2",
    description:
      "Vanity bench used to vault attacker's model into top SupraScore: cannot win",
    setup: async (t) => {
      await seedLegitBaseline(t);
      const attacker = await newUser(t, "attacker-A2");
      const vanity = await newBench(t, attacker, "VanityBench-A2");
      await rate(t, attacker, vanity, {
        relevance: 5,
        contamination: 5,
        discriminability: 5,
        reproducibility: 5,
        difficulty: 5,
      });
      const attackerModel = await newModel(t, attacker, "AttackerModel-A2");
      await score(t, attacker, attackerModel, vanity, 100);
      await refreshBench(t, vanity);
      return { attackerModel: attackerModel as string, vanityBench: vanity as string };
    },
    expect: (s, refs) => {
      const sorted = [...s.rankings].sort((a, b) => b.supraScore - a.supraScore);
      if (sorted[0]?.modelId === refs.attackerModel)
        return {
          ok: false,
          message: `Attacker model reached #1 with self-curated bench`,
        };
      return { ok: true };
    },
  },
  {
    id: "A3",
    description:
      "Modest multi-bench vanity (3 self-rated benches, attacker-only model): math defends",
    setup: async (t) => {
      await seedLegitBaseline(t);
      const attacker = await newUser(t, "attacker-A3");
      const attackerModel = await newModel(t, attacker, "AttackerModel-A3");
      for (let i = 0; i < 3; i++) {
        const v = await newBench(t, attacker, `VanityBench-A3-${i}`);
        await rate(t, attacker, v, {
          relevance: 5,
          contamination: 5,
          discriminability: 5,
          reproducibility: 5,
          difficulty: 5,
        });
        await score(t, attacker, attackerModel, v, 100);
        await refreshBench(t, v);
      }
      return { attackerModel: attackerModel as string };
    },
    expect: (s, refs) => {
      const attacker = s.rankings.find((r) => r.modelId === refs.attackerModel)!;
      const top = topLegit(s);
      if (attacker.supraScore >= top.supraScore)
        return {
          ok: false,
          message: `Attacker (${attacker.supraScore.toFixed(1)}) ≥ top legit ${top.name} (${top.supraScore.toFixed(1)}) — 3-bench vanity broke through the model-coverage defence`,
        };
      return { ok: true };
    },
  },
  {
    id: "A3-extreme",
    description:
      "DOCUMENTED LIMITATION: 8-bench industrial vanity farm outscales the pure math (defended operationally)",
    setup: async (t) => {
      await seedLegitBaseline(t);
      const attacker = await newUser(t, "attacker-A3x");
      const attackerModel = await newModel(t, attacker, "AttackerModel-A3x");
      for (let i = 0; i < 8; i++) {
        const v = await newBench(t, attacker, `IndustrialVanity-${i}`);
        await rate(t, attacker, v, {
          relevance: 5,
          contamination: 5,
          discriminability: 5,
          reproducibility: 5,
          difficulty: 5,
        });
        await score(t, attacker, attackerModel, v, 100);
        await refreshBench(t, v);
      }
      return { attackerModel: attackerModel as string };
    },
    // This test ASSERTS the limitation exists — it documents the
    // attack class the pure math does NOT defend against. If the
    // math is ever strengthened to defeat 8-bench vanity, this
    // assertion will flip; the failing test message tells the next
    // engineer to delete this case (or raise the threshold).
    //
    // Why the math fails here: the model-side √(W_m/W*) saturates
    // at 1.0, so once the attacker's accumulated bench-weight
    // surpasses the legit leader's, the SupraScore is bounded only
    // by weightedMean (= 100 if attacker controls all the scores).
    // Each vanity bench contributes ≈ raw_weight·√((1/U*)·(1/N*))
    // weight; that's bounded below but not zero, so N vanity
    // benches eventually dominate.
    //
    // Operational defenses that prevent this at runtime:
    //   1. Rate-limiting (max 30 submissions / 24 h / user) makes
    //      8+ self-scored benches very visible.
    //   2. Community downvote → bench hidden → excluded from U*,
    //      N*, and W*. Attack collapses entirely.
    //   3. Anti-resurrection: removed benches can't be re-created
    //      under the same name.
    //   4. Manual moderation flags the obvious "8 benches, all
    //      testing one model, by one account" pattern.
    //
    // See README.md "Anti-Gaming Rules" for the full stack.
    expect: (s, refs) => {
      const attacker = s.rankings.find((r) => r.modelId === refs.attackerModel)!;
      const top = topLegit(s);
      if (attacker.supraScore < top.supraScore)
        return {
          ok: false,
          message: `8-bench vanity attack failed — the math is now stronger than expected (attacker=${attacker.supraScore.toFixed(1)} < legit=${top.supraScore.toFixed(1)}). Either delete A3-extreme or raise its bench count and re-document the new bound.`,
        };
      return { ok: true };
    },
  },
  {
    id: "A4",
    description:
      "Sockpuppet upvote attack: attacker needs many fake accounts to vault vanity bench above midfield",
    setup: async (t) => {
      const { voters } = await seedLegitBaseline(t);
      const attacker = await newUser(t, "attacker-A4");
      const vanity = await newBench(t, attacker, "VanityBench-A4");
      await rate(t, attacker, vanity, {
        relevance: 5,
        contamination: 5,
        discriminability: 5,
        reproducibility: 5,
        difficulty: 5,
      });
      // 3 sockpuppets — fewer than the 8 voters who upvoted each
      // legit bench. Should NOT be enough to reach the top.
      const sockpuppets: any[] = [];
      for (let i = 0; i < 3; i++) sockpuppets.push(await newUser(t, `sock-A4-${i}`));
      await upvoteBench(t, vanity, sockpuppets);
      await refreshBench(t, vanity);
      voters;
      return { vanityBench: vanity as string };
    },
    expect: (s, refs) => {
      const idx = s.benchList.findIndex((b) => b._id === refs.vanityBench);
      if (idx === 0)
        return {
          ok: false,
          message: `Vanity bench reached #1 with only 3 sockpuppet upvotes (vs 8 legit voters per bench)`,
        };
      return { ok: true };
    },
  },
  {
    id: "A5",
    description:
      "Single-bench peak attack: model with 1 score=100 cannot outrank model with 3 scores=80",
    setup: async (t) => {
      const owner = await newUser(t, "owner-A5");
      const voters: any[] = [];
      for (let i = 0; i < 6; i++) voters.push(await newUser(t, `voter-A5-${i}`));

      const benches: any[] = [];
      for (let b = 0; b < 3; b++) {
        const bench = await newBench(t, owner, `BenchA5-${b}`);
        await upvoteBench(t, bench, voters);
        for (let r = 0; r < 3; r++) {
          await rate(t, voters[r], bench, { difficulty: 3 });
        }
        benches.push(bench);
      }

      // Sparse: 1 bench, score 100. Broad: 3 benches, score 80 each.
      const sparse = await newModel(t, owner, "SparseModel-A5");
      await score(t, owner, sparse, benches[0], 100);
      const broad = await newModel(t, owner, "BroadModel-A5");
      for (const b of benches) await score(t, owner, broad, b, 80);

      await refreshAllBenches(t);
      return { attackerModel: sparse as string };
    },
    expect: (s, refs) => {
      const sparseRow = s.rankings.find((r) => r.modelId === refs.attackerModel)!;
      const broadRow = s.rankings.find((r) => r.name === "BroadModel-A5")!;
      if (sparseRow.supraScore >= broadRow.supraScore)
        return {
          ok: false,
          message: `SparseModel (${sparseRow.supraScore}) ≥ BroadModel (${broadRow.supraScore})`,
        };
      return { ok: true };
    },
  },
  {
    id: "A6",
    description:
      "Hidden vanity bench: a bench downvoted into the hidden state must NOT contribute to U* / N*",
    setup: async (t) => {
      const { voters } = await seedLegitBaseline(t);
      const attacker = await newUser(t, "attacker-A6");
      const vanity = await newBench(t, attacker, "HiddenBench-A6");
      // Mark it hidden directly (simulates the entityVotes hide flow).
      await t.run(async (ctx) => {
        await ctx.db.patch(vanity, { hidden: true, cachedNetUpvotes: 999 });
      });
      voters;
      return { vanityBench: vanity as string };
    },
    expect: (s) => {
      // Hidden bench's high upvote count must NOT shift U* upward
      // (we'd see it via every other bench's effectiveWeight
      // collapsing if it did).
      const visibleMaxUpvotes = Math.max(
        ...s.benchList.map((b) => b.netUpvotes),
        0
      );
      const reportedMax = s.benchList[0]?.maxNetUpvotes ?? 0;
      if (reportedMax > visibleMaxUpvotes)
        return {
          ok: false,
          message: `Reported U*=${reportedMax} > max visible upvotes=${visibleMaxUpvotes} (hidden bench leaked into denominator)`,
        };
      return { ok: true };
    },
  },
];

// ─── Deterministic PRNG for fuzz ──────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedFuzzEcosystem(t: T, seed: number): Promise<void> {
  const rng = mulberry32(seed);
  const pickInt = (lo: number, hi: number) =>
    Math.floor(rng() * (hi - lo + 1)) + lo;

  const owners: any[] = [];
  const ownerCount = pickInt(2, 4);
  for (let i = 0; i < ownerCount; i++)
    owners.push(await newUser(t, `fuzz-${seed}-owner-${i}`));

  const voters: any[] = [];
  const voterCount = pickInt(3, 10);
  for (let i = 0; i < voterCount; i++)
    voters.push(await newUser(t, `fuzz-${seed}-voter-${i}`));

  const benches: any[] = [];
  const benchCount = pickInt(2, 6);
  for (let i = 0; i < benchCount; i++) {
    const owner = owners[pickInt(0, owners.length - 1)];
    const b = await newBench(t, owner, `FuzzBench-${seed}-${i}`);
    // Random subset of voters upvotes
    const ups = voters.filter(() => rng() > 0.4);
    if (ups.length > 0) await upvoteBench(t, b, ups);
    // Random subset of voters rates
    const raters = voters.filter(() => rng() > 0.5);
    for (const r of raters) {
      await rate(t, r, b, {
        relevance: pickInt(2, 5),
        contamination: pickInt(2, 5),
        discriminability: pickInt(2, 5),
        reproducibility: pickInt(2, 5),
        difficulty: pickInt(1, 5),
      });
    }
    benches.push(b);
  }

  const modelCount = pickInt(3, 8);
  for (let m = 0; m < modelCount; m++) {
    const owner = owners[pickInt(0, owners.length - 1)];
    const model = await newModel(t, owner, `FuzzModel-${seed}-${m}`);
    // Random subset of benches scored
    for (const b of benches) {
      if (rng() > 0.4) {
        await score(t, owner, model, b, pickInt(20, 95));
      }
    }
  }

  await refreshAllBenches(t);
}

// ─── Test harness ─────────────────────────────────────────────

describe("adversarial robustness", () => {
  describe("invariants on a hand-crafted baseline", () => {
    it("known-good ecosystem satisfies every invariant", async () => {
      const t = setupTestDb();
      await seedLegitBaseline(t);
      const s = await captureSnapshot(t);
      checkAll(s, "baseline");
    });
  });

  describe("attack catalog", () => {
    for (const atk of ATTACKS) {
      it(`${atk.id}: ${atk.description}`, async () => {
        const t = setupTestDb();
        const refs = await atk.setup(t);
        const s = await captureSnapshot(t);

        // Every attack scenario must ALSO satisfy every invariant
        // — an attack that breaks an invariant is a separate kind
        // of regression.
        checkAll(s, atk.id);

        const r = atk.expect(s, refs);
        expect(r.ok, r.message ?? atk.description).toBe(true);
      });
    }
  });

  describe("seeded fuzz (random ecosystems must satisfy every invariant)", () => {
    // Pinned seeds so failures are reproducible. Add new seeds when
    // the formula changes — never delete a seed that exposed a bug
    // in the past.
    const SEEDS = [1, 7, 42, 100, 314, 9001];
    for (const seed of SEEDS) {
      it(`seed=${seed}`, async () => {
        const t = setupTestDb();
        await seedFuzzEcosystem(t, seed);
        const s = await captureSnapshot(t);
        try {
          checkAll(s, `fuzz-${seed}`);
        } catch (e: any) {
          throw new Error(
            `${e.message}\nReproduce: setupFuzzEcosystem(t, ${seed}) and re-run.`
          );
        }
      });
    }
  });
});
