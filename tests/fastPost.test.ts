// Run: npm test. FAST_POST: the switch, parallel pipeline steps, the fast post loop, timings.
import { test } from "node:test";
import assert from "node:assert/strict";

import { fastPostOn, initialTimings, runStepGroups, timingLine, timingSummary } from "../convex/lib/fastPost.ts";
import {
  CRITERIA,
  FAST_ANGLE,
  FAST_DRAFT_TIMEOUT_MS,
  FAST_GUARD_TIMEOUT_MS,
  FAST_NOTE,
  MAX_REWRITE_ROUNDS,
  hardChecks,
  holdDecision,
  runFastPost,
  runQualityLoop,
  type DraftResult,
  type WrittenPost,
} from "../convex/lib/postQuality.ts";
import { overallPostStatus, quickThenFullGuard, runPublish, type GuardResult, type Platform, type PublishDeps } from "../convex/lib/postFlow.ts";
import { renderPostsPage, type PagePost } from "../convex/lib/postsPage.ts";

const words = (n: number, w: string) => Array.from({ length: n }, () => w).join(" ");

const EN_POST = [
  "The night our oven died, we had 300 wedding loaves still to bake.",
  "",
  `${words(60, "dough")} I called Eddie, my foreman, at two in the morning and we fired up the old brick oven.`,
  "",
  `${words(60, "flour")} We made every loaf by hand and the bride never knew.`,
  "",
  "The lesson I took from it: keep the old tools working, because one day they save you.",
  "",
  "What old tool has saved your day at work?",
].join("\n");

const post = (text: string): DraftResult => ({ skip: false, text, hook: text.split("\n")[0] });
const checks = (text: string) => hardChecks(text, "en", "en");
const SLOW: WrittenPost = {
  skip: false,
  text: "slow loop post",
  hook: "slow",
  hold: false,
  quality: { score: 80, passed: true, rounds: 0, notes: [], scores: Object.fromEntries(CRITERIA.map((c) => [c, 8])) as never },
};

test("FAST_POST: on only for on / true / 1 / yes", () => {
  for (const v of ["on", "true", "1", "yes", " ON "]) assert.equal(fastPostOn({ FAST_POST: v }), true, v);
  for (const v of [undefined, "", "off", "0", "no", "fast"]) assert.equal(fastPostOn({ FAST_POST: v }), false, String(v));
});

test("MAX_REWRITE_ROUNDS is 1", () => {
  assert.equal(MAX_REWRITE_ROUNDS, 1);
});

test("fast budget: writer and fact-check timeouts leave room for a post under 30 s", () => {
  // poll 3 s + writer + guard + ~5 s for 3-5 Bluesky posts, plus ~2 s of hops and queries
  assert.ok(3_000 + FAST_DRAFT_TIMEOUT_MS + FAST_GUARD_TIMEOUT_MS + 5_000 + 2_000 <= 30_000);
});

// ---------- runStepGroups ----------

test("runStepGroups: steps in a group run at the same time; groups run in order", async () => {
  const order: string[] = [];
  let releaseMemories!: () => void;
  const memoriesGate = new Promise<void>((r) => (releaseMemories = r));
  const reports = await runStepGroups([
    [
      {
        step: "memories",
        run: async () => {
          order.push("memories start");
          await memoriesGate; // only finishes once the post step has started: they overlap
          order.push("memories end");
          return "saved";
        },
      },
      {
        step: "post",
        run: async () => {
          order.push("post start");
          releaseMemories();
          return "scheduled";
        },
      },
    ],
    [{ step: "reply", run: async () => void order.push("reply") }],
  ]);
  assert.deepEqual(order, ["memories start", "post start", "memories end", "reply"]);
  assert.deepEqual(reports.map((r) => `${r.step}:${r.status}`), ["memories:ok", "post:ok", "reply:ok"]);
});

test("runStepGroups: a failing step never stops the others; skips are reported", async () => {
  const reports = await runStepGroups([
    [
      { step: "memories", run: async () => { throw new Error("no key"); } },
      { step: "post", run: async () => "post p1 scheduled" },
    ],
    [{ step: "plan", skip: "off", run: async () => "never" }],
  ]);
  assert.deepEqual(reports, [
    { step: "memories", status: "failed", detail: "no key" },
    { step: "post", status: "ok", detail: "post p1 scheduled" },
    { step: "plan", status: "skipped", detail: "off" },
  ]);
});

// ---------- runFastPost ----------

test("runFastPost: one draft, no judge, passes with a fast-mode quality marker", async () => {
  let drafts = 0;
  let fallbacks = 0;
  let seen: { angle: string; timeoutMs: number } | null = null;
  const out = await runFastPost({
    draft: async (angle, timeoutMs) => {
      drafts++;
      seen = { angle, timeoutMs };
      return post(EN_POST);
    },
    checks,
    fallback: async () => (fallbacks++, SLOW),
  });
  assert.equal(drafts, 1);
  assert.equal(fallbacks, 0);
  assert.deepEqual(seen, { angle: FAST_ANGLE, timeoutMs: FAST_DRAFT_TIMEOUT_MS });
  assert.equal(out.skip, false);
  if (out.skip) return;
  assert.equal(out.text, EN_POST);
  assert.equal(out.hold, false);
  assert.equal(out.fallback, undefined);
  assert.equal(out.quality.mode, "fast");
  assert.equal(out.quality.passed, true);
  assert.equal(out.quality.rounds, 0);
  assert.equal(out.quality.notes[0], FAST_NOTE);
  // insertPost: not held for quality (only a thread that doesn't fit would be)
  assert.equal(holdDecision(out.quality, null), null);
});

test("runFastPost: a blocker (link, @, thread fit) never goes out fast: the normal loop runs", async () => {
  for (const bad of [`${EN_POST}\n\nMore at https://example.com`, EN_POST.replace("Eddie", "@eddie"), `${EN_POST}\n\n${words(250, "long")}`]) {
    let fallbacks = 0;
    const out = await runFastPost({ draft: async () => post(bad), checks, fallback: async () => (fallbacks++, SLOW) });
    assert.equal(fallbacks, 1);
    assert.equal(out.skip, false);
    if (out.skip) continue;
    assert.equal(out.text, SLOW.text);
    assert.match(out.fallback ?? "", /^fast draft blocked \(/);
  }
});

test("runFastPost: a timeout, error, empty draft or decline falls back to the normal loop", async () => {
  const cases: [() => Promise<DraftResult>, RegExp][] = [
    [() => Promise.reject(new Error("OpenAI did not answer (timeout or network)")), /failed or timed out/],
    [async () => ({ skip: true, reason: "small talk" }), /declined/],
    [async () => post("   "), /empty/],
  ];
  for (const [draft, why] of cases) {
    const out = await runFastPost({ draft, checks, fallback: async () => SLOW });
    assert.equal(out.skip, false);
    if (out.skip) continue;
    assert.equal(out.text, SLOW.text);
    assert.match(out.fallback ?? "", why);
  }
});

test("runFastPost: the fallback is the real quality loop (3 drafts + judge), held below the bar", async () => {
  let loopDrafts = 0;
  let judged = 0;
  const out = await runFastPost({
    draft: () => Promise.reject(new Error("timeout")),
    checks,
    fallback: () =>
      runQualityLoop({
        budgetMs: 240_000,
        draft: async () => (loopDrafts++, post(EN_POST)),
        judge: async () => (judged++, { scores: Object.fromEntries(CRITERIA.map((c) => [c, 3])) as never, unsupportedFacts: [], notes: [] }),
        rewrite: async () => post(EN_POST),
        checks,
        sleep: async () => {},
      }),
  });
  assert.equal(loopDrafts, 3);
  assert.ok(judged >= 3);
  assert.equal(out.skip, false);
  if (out.skip) return;
  assert.equal(out.hold, true); // the slow path still holds a weak post
  assert.equal(out.quality.mode, undefined);
  assert.equal(out.quality.rounds, 1);
});

// ---------- timings ----------

test("initialTimings: hang-up from Cartesia's end time, else when we saw it", () => {
  assert.deepEqual(initialTimings({ hungUpAt: 1_000, endedAt: 3_000 }, 9_000), { endedAt: 1_000, detectedAt: 3_000, writtenAt: 9_000 });
  assert.deepEqual(initialTimings({ endedAt: 3_000 }, 9_000), { endedAt: 3_000, detectedAt: 3_000, writtenAt: 9_000 });
  assert.deepEqual(initialTimings(null, 9_000), { writtenAt: 9_000 });
});

test("timingSummary / timingLine: seconds per stage and the total after hang-up", () => {
  const t = { endedAt: 0, detectedAt: 2_100, writtenAt: 11_900, checkedAt: 17_100, postedAt: 21_100 };
  assert.deepEqual(timingSummary(t), {
    stages: [
      { stage: "detect", seconds: 2.1 },
      { stage: "write", seconds: 9.8 },
      { stage: "check", seconds: 5.2 },
      { stage: "post", seconds: 4 },
    ],
    totalSeconds: 21.1,
  });
  assert.equal(timingLine(t), "detect 2.1s, write 9.8s, check 5.2s, post 4s; 21.1s after hang-up");
  // held: no postedAt, no total
  assert.equal(timingLine({ endedAt: 0, detectedAt: 2_000, writtenAt: 9_000 }), "detect 2s, write 7s");
  assert.equal(timingLine(undefined), "no timings");
});

test("/posts shows 'posted N s after hang-up' and the fast-mode marker", () => {
  const p: PagePost = {
    id: "p1",
    createdAt: 0,
    status: "published",
    elderFirstName: "Walter",
    text: EN_POST,
    quality: { score: 0, passed: true, rounds: 0, notes: [FAST_NOTE], mode: "fast" },
    timings: { endedAt: 0, detectedAt: 2_000, writtenAt: 11_000, checkedAt: 16_000, postedAt: 20_500 },
  };
  const html = renderPostsPage([p], { key: "k" });
  assert.match(html, /Posted 20\.5 s after hang-up/);
  assert.match(html, /detect 2s, write 9s, check 5s, post 4\.5s/);
  assert.match(html, /Fast mode: one draft, no judge/);
  assert.doesNotMatch(html, /0\/100/);
});

// ---------- publishing in fast mode ----------

function publishDeps(o: { guard: GuardResult; guardEarly?: boolean }) {
  const log: string[] = [];
  let status = "pending";
  const rows = new Map<string, { platform: Platform; status: string }>();
  const deps: PublishDeps = {
    load: async () => ({ status }),
    platforms: async () => {
      log.push("platforms");
      return { bluesky: true, threads: false, x: false, reddit: false, linkedin: false };
    },
    claimPost: async () => ((status = "posting"), { ok: true }),
    guard: async () => (log.push("guard"), o.guard),
    saveGuard: async (_g, hold) => void log.push(`saveGuard:${hold}`),
    ensureRow: async (platform, enabled) => {
      const id = `row-${platform}`;
      if (!rows.has(id)) rows.set(id, { platform, status: enabled ? "pending" : "skipped" });
      return { id };
    },
    claimRow: async (id) => ((rows.get(id)!.status = "posting"), { ok: true }),
    post: async (platform) => (log.push(`post:${platform}`), { status: "posted", url: "https://bsky.example/p" }),
    finishRow: async (id, outcome) => void (rows.get(id)!.status = outcome.status),
    isRemoved: async () => false,
    scheduleUndo: async () => {},
    settle: async () => overallPostStatus([...rows.values()]),
    ...(o.guardEarly ? { guardEarly: true } : {}),
  };
  return { deps, log };
}

const PASS: GuardResult = { pass: true, issues: [], summary: "ok", mode: "enforce" };
const FAIL: GuardResult = { pass: false, issues: ["He never said 1971"], summary: "no", mode: "enforce" };

test("runPublish with guardEarly: the fact-check starts before the logins are read, and still holds", async () => {
  const fast = publishDeps({ guard: PASS, guardEarly: true });
  assert.equal((await runPublish(fast.deps, false)).status, "published");
  assert.deepEqual(fast.log, ["guard", "platforms", "saveGuard:false", "post:bluesky"]);
  const held = publishDeps({ guard: FAIL, guardEarly: true });
  assert.equal((await runPublish(held.deps, false)).status, "needs_review");
  assert.ok(!held.log.includes("post:bluesky"));
  const normal = publishDeps({ guard: PASS });
  await runPublish(normal.deps, false);
  assert.deepEqual(normal.log, ["platforms", "guard", "saveGuard:false", "post:bluesky"]);
});

test("quickThenFullGuard: a quick timeout runs the normal check; a quick fail stands", async () => {
  let fulls = 0;
  const full = async () => (fulls++, PASS);
  const crashed: GuardResult = { pass: false, issues: ["Fact-check failed to run: OpenAI did not answer (timeout or network)"], summary: "Fact-check error.", mode: "enforce", crashed: true };
  assert.deepEqual(await quickThenFullGuard(async () => PASS, full), PASS);
  assert.deepEqual(await quickThenFullGuard(async () => FAIL, full), FAIL);
  assert.equal(fulls, 0);
  assert.deepEqual(await quickThenFullGuard(async () => crashed, full), { ...PASS, slow: true });
  assert.equal(fulls, 1);
  // the normal check failing to run too: still a fail (held), never posted unchecked
  const out = await quickThenFullGuard(async () => crashed, async () => crashed);
  assert.equal(out.pass, false);
});
