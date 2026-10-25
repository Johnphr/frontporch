// Run: npm test (Node 22.18+ / 24 strips TypeScript types natively)
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CRITERIA,
  MAX_REWRITE_ROUNDS,
  MIN_CRITERION,
  MINOR_PENALTY,
  PASS_SCORE,
  JUDGE_RETRY_DELAY_MS,
  JUDGE_TIMEOUT_MS,
  MAX_TOTAL_CHARS,
  MIN_POST_BUDGET_MS,
  QUALITY_BUDGET_MS,
  ROUND_COST_MS,
  WEIGHTS,
  detectLanguage,
  draftOutcome,
  evaluate,
  MESSAGE_WORDS,
  hardChecks,
  hasMarkdown,
  messagePost,
  holdDecision,
  keepRewrite,
  nextStep,
  normalizeJudgement,
  pickBest,
  postBudgetMs,
  qualityReport,
  runQualityLoop,
  trimNotes,
  wordCount,
  type CriterionScores,
  type DraftResult,
  type Judgement,
  type QualityDeps,
} from "../convex/lib/postQuality.ts";
import { renderPostsPage } from "../convex/lib/postsPage.ts";

const words = (n: number, w = "bread") => Array.from({ length: n }, () => w).join(" ");

const EN_POST = [
  "The night our oven died, we had 300 wedding loaves still to bake.",
  "",
  `${words(60, "dough")} I called Eddie, my foreman, at two in the morning and we fired up the old brick oven in the back that nobody had used since 1971.`,
  "",
  `${words(60, "flour")} We made every loaf by hand and the bride never knew.`,
  "",
  "The lesson I took from it: keep the old tools working, because one day they save you.",
  "",
  "What old tool has saved your day at work?",
].join("\n");

const ES_POST = [
  "La noche que se descompuso el horno teníamos 300 panes para una boda.",
  "",
  `Le llamé a Eddie, mi encargado, a las dos de la mañana y prendimos el horno de ladrillo que no se usaba desde 1971. ${words(60, "masa")}`,
  "",
  `Hicimos todos los panes a mano y la novia nunca se enteró. ${words(60, "harina")}`,
  "",
  "Lo que aprendí: hay que cuidar las herramientas viejas, porque un día te salvan.",
  "",
  "¿Qué herramienta vieja le ha salvado a usted el día en el trabajo?",
].join("\n");

function scores(all: number, over: Partial<CriterionScores> = {}): CriterionScores {
  return { ...(Object.fromEntries(CRITERIA.map((c) => [c, all])) as CriterionScores), ...over };
}

function judgement(all: number, extra: Partial<Judgement> = {}): Judgement {
  return { scores: scores(all), unsupportedFacts: [], notes: [], ...extra };
}

test("weights sum to 1 and every criterion has one", () => {
  const sum = CRITERIA.reduce((s, c) => s + WEIGHTS[c], 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.equal(Object.keys(WEIGHTS).length, CRITERIA.length);
});

test("wordCount and detectLanguage", () => {
  assert.equal(wordCount("I baked bread at 3 in the morning for Eddie's wedding"), 11);
  assert.equal(detectLanguage(EN_POST), "en");
  assert.equal(detectLanguage(ES_POST), "es");
  assert.equal(detectLanguage("ok"), "unknown");
});

test("hardChecks: a good English post has no issues", () => {
  assert.deepEqual(hardChecks(EN_POST, "en"), []);
});

test("hardChecks: a Spanish post isn't penalized by English-only rules", () => {
  assert.deepEqual(hardChecks(ES_POST, "es"), []);
});

test("hardChecks: length, hook, hashtags, stock phrases, markdown, question", () => {
  const ids = (t: string, lang: "en" | "es" | "unknown" = "en") => hardChecks(t, lang).map((i) => `${i.id}:${i.severity}`);
  assert.deepEqual(ids(`Short hook.\n\n${words(50)}?`), ["length:major"]);
  assert.deepEqual(ids(`Short hook.\n\n${words(110)}?`), ["length:minor"]);
  const longHook = `${"A very long first line that just keeps going ".repeat(5)}\n\n${words(130)}\n\nWhat do you think?`;
  assert.ok(ids(longHook).includes("hook_length:minor"));
  assert.ok(ids(`${EN_POST} #bread #baking #family`).includes("hashtags:minor"));
  assert.ok(ids(EN_POST.replace("The lesson", "Let's delve into it. The lesson")).includes("stock_phrases:minor"));
  assert.ok(ids(EN_POST.replace("The lesson", "**The lesson**")).includes("markdown:minor"));
  assert.ok(ids(EN_POST.replace("What old tool has saved your day at work?", "Thanks for reading.")).includes("no_question:minor"));
});

test("hardChecks: the whole text must fit a short thread (MAX_TOTAL_CHARS is a blocker)", () => {
  assert.ok(Array.from(EN_POST).length <= MAX_TOTAL_CHARS);
  const long = `Short hook.\n\n${words(150, "extraordinarily")}\n\nWhat do you think?`; // 150+ words, far over 1,250 chars
  assert.ok(hardChecks(long, "en").some((i) => i.id === "total_length" && i.severity === "major"));
  assert.ok(!hardChecks(EN_POST, "en").some((i) => i.id === "total_length"));
});

test("hasMarkdown: real lists and markers only; a line that starts with a year is fine", () => {
  assert.equal(hasMarkdown("1987. That was the year we opened the bakery.\n\nWe had two ovens."), false);
  assert.equal(hasMarkdown("In 1971. Or was it 1972?\n1975. We moved."), false);
  assert.equal(hasMarkdown("3. That was how many ovens we had."), false); // one line isn't a list
  assert.equal(hasMarkdown("1. Knead\n2. Rest\n3. Bake"), true);
  assert.equal(hasMarkdown("1) Knead\n\n2) Rest"), true);
  assert.equal(hasMarkdown("We needed:\n- flour\n- water"), true);
  assert.equal(hasMarkdown("The **best** loaf"), true);
  assert.equal(hasMarkdown("# Title\nText"), true);
  assert.ok(!hardChecks(EN_POST.replace("The lesson", "1987. The lesson"), "en").some((i) => i.id === "markdown"));
});

test("hardChecks: wrong language is a blocker, unknown language is not", () => {
  assert.ok(hardChecks(EN_POST, "es").some((i) => i.id === "language" && i.severity === "major"));
  assert.ok(!hardChecks(EN_POST, "unknown").some((i) => i.id === "language"));
});

test("evaluate: weighted score, minor penalty, pass bar", () => {
  const good = evaluate(judgement(9), []);
  assert.equal(good.score, 90);
  assert.equal(good.passed, true);

  const minor = evaluate(judgement(8), [{ id: "x", severity: "minor", message: "m" }]);
  assert.equal(minor.score, 80 - MINOR_PENALTY);
  assert.equal(minor.passed, minor.score >= PASS_SCORE);

  const justBelow = evaluate(judgement(7), []);
  assert.equal(justBelow.score, 70);
  assert.equal(justBelow.passed, false);
});

test("evaluate: one weak criterion blocks a pass even with a high total", () => {
  const e = evaluate({ scores: scores(10, { hook: MIN_CRITERION - 1 }), unsupportedFacts: [], notes: [] }, []);
  assert.ok(e.score >= PASS_SCORE);
  assert.equal(e.passed, false);
  assert.match(e.notes[0], /Weak hook/);
});

test("evaluate: a major code issue blocks a pass", () => {
  const e = evaluate(judgement(10), [{ id: "language", severity: "major", message: "wrong language" }]);
  assert.equal(e.passed, false);
});

test("evaluate: unsupported facts are a hard zero", () => {
  const e = evaluate(judgement(10, { unsupportedFacts: ["He never said 1971"] }), []);
  assert.equal(e.score, 0);
  assert.equal(e.passed, false);
  assert.match(e.notes[0], /Not something he said: He never said 1971/);
});

test("evaluate: no judgement (judge failed) never passes", () => {
  const e = evaluate(null, []);
  assert.equal(e.passed, false);
  assert.equal(e.score, 0);
});

test("normalizeJudgement clamps scores and fills gaps", () => {
  const j = normalizeJudgement({ scores: { hook: 14, story: -2, voice: "8" }, unsupported_facts: ["x", ""], notes: [" fix it ", 3] });
  assert.equal(j.scores.hook, 10);
  assert.equal(j.scores.story, 0);
  assert.equal(j.scores.voice, 0);
  assert.equal(j.scores.clarity, 0);
  assert.deepEqual(j.unsupportedFacts, ["x"]);
  assert.deepEqual(j.notes, ["fix it"]);
});

test("pickBest: passed first, then score, ties keep the earlier draft", () => {
  const e = (score: number, passed: boolean) => ({ score, passed, scores: scores(0), notes: [] });
  const best = pickBest([
    { index: 0, text: "a", hook: "a", evaluation: e(90, false) },
    { index: 1, text: "b", hook: "b", evaluation: e(80, true) },
    { index: 2, text: "c", hook: "c", evaluation: e(80, true) },
  ]);
  assert.equal(best?.index, 1);
  assert.equal(pickBest([]), null);
});

test("nextStep: passes early, rewrites while rounds and time remain, then holds", () => {
  assert.equal(nextStep({ passed: true, round: 0, timeLeftMs: QUALITY_BUDGET_MS, roundCostMs: ROUND_COST_MS }), "done");
  assert.equal(nextStep({ passed: false, round: 0, timeLeftMs: QUALITY_BUDGET_MS, roundCostMs: ROUND_COST_MS }), "rewrite");
  assert.equal(nextStep({ passed: false, round: MAX_REWRITE_ROUNDS, timeLeftMs: QUALITY_BUDGET_MS, roundCostMs: ROUND_COST_MS }), "hold");
  assert.equal(nextStep({ passed: false, round: 0, timeLeftMs: ROUND_COST_MS - 1, roundCostMs: ROUND_COST_MS }), "hold");
});

test("keepRewrite: only a better rewrite replaces the best", () => {
  const e = (score: number, passed: boolean) => ({ score, passed, scores: scores(0), notes: [] });
  assert.equal(keepRewrite(e(70, false), e(78, true)), true);
  assert.equal(keepRewrite(e(80, true), e(90, false)), false);
  assert.equal(keepRewrite(e(70, false), e(70, false)), false);
  assert.equal(keepRewrite(e(70, false), e(72, false)), true);
});

test("draftOutcome: counts against the 3 intended drafts, so failures never become a skip", () => {
  assert.equal(draftOutcome(2, 1, 3), "skip");
  assert.equal(draftOutcome(2, 0, 3), "skip"); // 2 skips + 1 failed: still a majority
  assert.equal(draftOutcome(1, 0, 3), "fail"); // 1 skip + 2 failed: can't tell -> retry
  assert.equal(draftOutcome(1, 1, 3), "fail"); // 1 skip, 1 post, 1 failed: the failed one decides
  assert.equal(draftOutcome(1, 2, 3), "write");
  assert.equal(draftOutcome(0, 2, 3), "write"); // 1 failed
  assert.equal(draftOutcome(0, 1, 3), "fail"); // 2 failed
  assert.equal(draftOutcome(0, 0, 3), "fail");
});

test("postBudgetMs: what's left of the 10-minute action, capped at QUALITY_BUDGET_MS", () => {
  assert.equal(postBudgetMs(0, 30_000), QUALITY_BUDGET_MS);
  assert.equal(postBudgetMs(0, 400_000), 140_000); // 600 - 400 - 60
  assert.ok(postBudgetMs(0, 450_000) < MIN_POST_BUDGET_MS); // the pipeline won't start the step
  assert.equal(postBudgetMs(0, 700_000), 0);
});

test("holdDecision: below the bar -> needs_review with a summary; passed -> post as usual", () => {
  const held = holdDecision(qualityReport(evaluate(judgement(6, { notes: ["Hook is flat"] }), []), 2));
  assert.equal(held?.status, "needs_review");
  assert.match(held?.summary ?? "", /Held by the quality check: 60\/100 \(bar 75\) after 2 rewrites/);
  assert.equal("issues" in (held ?? {}), false); // the notes live on posts.quality only
  assert.equal(holdDecision(qualityReport(evaluate(judgement(9), []), 0)), null);
  assert.equal(holdDecision(undefined), null);
});

test("trimNotes dedupes, trims and caps", () => {
  assert.deepEqual(trimNotes(["a", "A", " b ", "", "c"], 2), ["a", "b"]);
});

test("posts page shows the quality score and notes", () => {
  const html = renderPostsPage(
    [
      {
        id: "p1",
        createdAt: 0,
        status: "needs_review",
        elderFirstName: "Walter",
        text: "Hello",
        quality: { score: 62, passed: false, rounds: 2, notes: ["Hook is flat"] },
      },
    ],
    { key: "k" },
  );
  assert.match(html, /Quality: 62\/100 \(below the bar\)/);
  assert.match(html, /2 rewrites/);
  assert.match(html, /Hook is flat/);
});

test("posts page shows a quality hold's notes once (older rows copied them into guardIssues)", () => {
  const html = renderPostsPage(
    [
      {
        id: "p3",
        createdAt: 0,
        status: "needs_review",
        heldFor: "quality",
        elderFirstName: "Walter",
        text: "Hello",
        guardSummary: "Held by the quality check: 62/100 (bar 75) after 2 rewrites.",
        guardIssues: ["Hook is flat"],
        quality: { score: 62, passed: false, rounds: 2, notes: ["Hook is flat"] },
      },
    ],
    { key: "k" },
  );
  assert.equal(html.split("Hook is flat").length - 1, 1);
  assert.match(html, /Held by the quality check/);
});

test("approve decision: only an approved fact-check hold skips the fact-check", async () => {
  const { shouldRunGuard } = await import("../convex/lib/postFlow.ts");
  const held = (heldFor?: "quality" | "thread_fit" | "guard") => ({ status: "needs_review", ...(heldFor ? { heldFor } : {}) });
  assert.equal(shouldRunGuard({ status: "pending" }, false), true); // a new post always checks
  assert.equal(shouldRunGuard(held("quality"), false), true);
  assert.equal(shouldRunGuard(held("quality"), true), true); // never fact-checked yet
  assert.equal(shouldRunGuard(held("thread_fit"), true), true); // never fact-checked yet
  assert.equal(shouldRunGuard(held("guard"), true), false); // already checked; a person approved it
  assert.equal(shouldRunGuard(held(), true), false); // older guard holds, as before
  // Never held: AUTO_POST=off leaves it pending, no heldFor; approving it still checks it.
  assert.equal(shouldRunGuard({ status: "pending" }, true), true);
  assert.equal(shouldRunGuard({ status: "failed" }, true), true, "a failed post whose guard never ran");
  assert.equal(shouldRunGuard({ status: "failed", heldFor: "guard" }, true), true, "heldFor alone isn't a hold");
});

test("posts page labels quality holds apart from fact-check holds", async () => {
  const { statusLabel } = await import("../convex/lib/postsPage.ts");
  assert.equal(statusLabel({ status: "needs_review", heldFor: "quality" }), "Held: below the quality bar");
  assert.equal(statusLabel({ status: "needs_review", heldFor: "guard" }), "Held by fact-check");
  assert.equal(statusLabel({ status: "needs_review" }), "Held by fact-check");
  const html = renderPostsPage(
    [{ id: "p2", createdAt: 0, status: "needs_review", heldFor: "quality", elderFirstName: "Walter", text: "Hi" }],
    { key: "k" },
  );
  assert.match(html, /Held: below the quality bar/);
});

// ---------- runQualityLoop (the orchestration, with fake model calls and a fake clock) ----------

const post = (text: string): DraftResult => ({ skip: false, text, hook: text.split("\n")[0] });
const skip = (reason = "small talk"): DraftResult => ({ skip: true, reason });

/** Fake deps: each model call takes `costMs` of fake time; override any call. */
function loop(over: Partial<QualityDeps> = {}, costMs = 1_000) {
  const clock = { t: 0 };
  const calls = { draft: 0, judge: 0, rewrite: 0, sleeps: [] as number[], timeouts: [] as number[] };
  const tick = (timeoutMs: number) => {
    calls.timeouts.push(timeoutMs);
    clock.t += costMs;
  };
  const deps: QualityDeps = {
    budgetMs: QUALITY_BUDGET_MS,
    now: () => clock.t,
    sleep: async (ms) => {
      calls.sleeps.push(ms);
      clock.t += ms;
    },
    draft: async (angle, timeoutMs) => {
      calls.draft++;
      tick(timeoutMs);
      return post(`${angle}\n\n${EN_POST}`);
    },
    judge: async (_text, timeoutMs) => {
      calls.judge++;
      tick(timeoutMs);
      return judgement(9);
    },
    rewrite: async (text, _notes, timeoutMs) => {
      calls.rewrite++;
      tick(timeoutMs);
      return post(`REWRITE ${text}`);
    },
    checks: () => [],
    ...over,
  };
  return { deps, calls, clock };
}

test("runQualityLoop: a good draft passes with no rewrite", async () => {
  const { deps, calls } = loop();
  const out = await runQualityLoop(deps);
  assert.equal(out.skip, false);
  if (out.skip) return;
  assert.equal(out.hold, false);
  assert.equal(out.quality.passed, true);
  assert.equal(out.quality.rounds, 0);
  assert.equal(calls.draft, 3);
  assert.equal(calls.judge, 3);
  assert.equal(calls.rewrite, 0);
});

test("runQualityLoop: skips only when most of the 3 drafts decline", async () => {
  let n = 0;
  const { deps, calls } = loop({ draft: async () => (n++ < 2 ? skip("only scheduling") : post(EN_POST)) });
  assert.deepEqual(await runQualityLoop(deps), { skip: true, reason: "only scheduling" });
  assert.equal(calls.judge, 0);
});

test("runQualityLoop: failed drafts never turn into a skip", async () => {
  // 1 skip + 2 failed: throws (retry later) instead of skipping the call
  let a = 0;
  const failing = loop({ draft: async () => (a++ === 0 ? skip() : Promise.reject(new Error("timeout"))) });
  await assert.rejects(runQualityLoop(failing.deps), /too many drafts failed \(2 of 3\)/);
  // 1 skip + 1 failed + 1 post: the failed one could have decided it -> throws too
  let b = 0;
  const mixed = loop({ draft: async () => [skip(), post(EN_POST)][b++] ?? Promise.reject(new Error("timeout")) });
  await assert.rejects(runQualityLoop(mixed.deps), /too many drafts failed \(1 of 3\)/);
  // 2 posts + 1 failed: writes from the 2
  let c = 0;
  const ok = loop({ draft: async () => (c++ === 0 ? Promise.reject(new Error("timeout")) : post(EN_POST)) });
  const out = await runQualityLoop(ok.deps);
  assert.equal(out.skip, false);
  assert.equal(ok.calls.judge, 2);
});

test("runQualityLoop: a judge call that fails is retried once after a short pause", async () => {
  let judged = 0;
  const { deps, calls } = loop({
    judge: async () => {
      if (judged++ === 0) throw new Error("rate limited");
      return judgement(9);
    },
  });
  const out = await runQualityLoop(deps);
  assert.equal(out.skip, false);
  if (out.skip) return;
  assert.equal(out.quality.passed, true);
  assert.equal(judged, 4); // 3 drafts + 1 retry
  assert.deepEqual(calls.sleeps, [JUDGE_RETRY_DELAY_MS]);
});

test("runQualityLoop: a judge that never answers fails closed (held, never posted on its own)", async () => {
  let judged = 0;
  const { deps } = loop({
    judge: async () => {
      judged++;
      throw new Error("down");
    },
  });
  const out = await runQualityLoop(deps);
  assert.equal(out.skip, false);
  if (out.skip) return;
  assert.equal(out.hold, true);
  assert.equal(out.quality.passed, false);
  assert.equal(out.quality.score, 0);
  assert.ok(out.quality.notes.some((n) => /couldn't run/.test(n)));
  assert.equal(judged, (3 + MAX_REWRITE_ROUNDS) * 2); // every judgement tried twice
});

test("runQualityLoop: picks the best draft, and keeps a rewrite only when it's better", async () => {
  // The second angle's draft scores best (6, below the bar); the first rewrite scores 9 and passes.
  const SECOND = "Angle: the hard lesson";
  const score = (text: string) => (text.startsWith("REWRITE") ? 9 : text.startsWith(SECOND) ? 6 : 4);
  const better = loop({ judge: async (text) => judgement(score(text)) });
  const out = await runQualityLoop(better.deps);
  assert.equal(out.skip, false);
  if (out.skip) return;
  assert.ok(out.text.startsWith(`REWRITE ${SECOND}`));
  assert.equal(out.quality.rounds, 1);
  assert.equal(out.hold, false);

  // Every rewrite is worse: the best draft stays, held after MAX_REWRITE_ROUNDS.
  const worse = loop({ judge: async (text) => judgement(text.startsWith("REWRITE") ? 3 : score(text)) });
  const held = await runQualityLoop(worse.deps);
  assert.equal(held.skip, false);
  if (held.skip) return;
  assert.ok(held.text.startsWith(SECOND));
  assert.equal(held.quality.rounds, MAX_REWRITE_ROUNDS);
  assert.equal(held.hold, true);
  assert.equal(worse.calls.rewrite, MAX_REWRITE_ROUNDS);
});

test("runQualityLoop: a failed or declined rewrite keeps the best so far", async () => {
  let r = 0;
  const { deps } = loop({
    judge: async () => judgement(6),
    rewrite: async () => (r++ === 0 ? Promise.reject(new Error("timeout")) : skip()),
  });
  const out = await runQualityLoop(deps);
  assert.equal(out.skip, false);
  if (out.skip) return;
  assert.equal(out.hold, true);
  assert.equal(out.quality.rounds, MAX_REWRITE_ROUNDS);
  assert.ok(!out.text.startsWith("REWRITE"));
});

test("runQualityLoop: stays inside the time budget", async () => {
  // Not enough time for drafts + a judge pass: throws before any model call.
  const tooLate = loop({ budgetMs: MIN_POST_BUDGET_MS - 1 });
  await assert.rejects(runQualityLoop(tooLate.deps), /not enough time/);
  assert.equal(tooLate.calls.draft, 0);

  // Drafts take 60 s of a 150 s budget: the judges run, but a rewrite round (120 s) doesn't fit.
  const budget = MIN_POST_BUDGET_MS + 30_000;
  const tight = loop({ budgetMs: budget, judge: async () => judgement(6) }, 0);
  let first = true;
  const timeouts: number[] = [];
  tight.deps.draft = async (_angle, ms) => {
    timeouts.push(ms);
    if (first) tight.clock.t += 60_000; // the three run in parallel: count the time once
    first = false;
    return post(EN_POST);
  };
  const out = await runQualityLoop(tight.deps);
  assert.equal(out.skip, false);
  if (out.skip) return;
  assert.equal(tight.calls.rewrite, 0);
  assert.equal(out.quality.rounds, 0);
  assert.equal(out.hold, true);
  // Draft timeouts leave room for one judge pass inside the budget.
  assert.ok(timeouts.every((ms) => ms > 0 && ms + JUDGE_TIMEOUT_MS <= budget));
  assert.ok(ROUND_COST_MS > budget - 60_000);

  // No time left for a judge retry: it isn't attempted, and the post fails closed.
  let judged = 0;
  const noRetry = loop({
    budgetMs: MIN_POST_BUDGET_MS,
    judge: async () => {
      judged++;
      throw new Error("down");
    },
  }, 0);
  let once = true;
  noRetry.deps.draft = async () => {
    if (once) noRetry.clock.t += MIN_POST_BUDGET_MS - 11_000; // 11 s left: one judge call, no retry
    once = false;
    return post(EN_POST);
  };
  const closed = await runQualityLoop(noRetry.deps);
  assert.equal(closed.skip, false);
  if (closed.skip) return;
  assert.equal(closed.hold, true);
  assert.equal(judged, 3); // one try per draft
  assert.deepEqual(noRetry.calls.sleeps, []);
});

// ---------- Bluesky thread fit ----------

test("hardChecks: a post that can't be a 5-post Bluesky thread is a blocker (hook too long too)", () => {
  const para = "This is a sentence about the bakery and the oven we ran. ".repeat(4).trim();
  const long = ["The night the oven died.", para, para, para, para, para, "What would you do?"].join("\n\n");
  assert.ok(hardChecks(long, "en").some((i) => i.id === "thread_fit" && i.severity === "major"));
  const hook = `${words(70, "longword")} and more.`;
  const badHook = [hook, "Short story.", "What about you?"].join("\n\n");
  const fit = hardChecks(badHook, "en").find((i) => i.id === "thread_fit");
  assert.match(fit?.message ?? "", /opening sentence is \d+ characters/);
  assert.ok(!hardChecks(EN_POST, "en").some((i) => i.id === "thread_fit"));
});

test("evaluate + keepRewrite: a rewrite that fits a thread beats one that doesn't (neither passing)", () => {
  const fitIssue = { id: "thread_fit", severity: "major" as const, message: "Doesn't fit a Bluesky thread: too long" };
  const noFit = evaluate(judgement(9), [fitIssue]);
  assert.equal(noFit.passed, false);
  assert.equal(noFit.fits, false);
  assert.equal(noFit.notes[0], fitIssue.message, "blockers come first in the notes");
  const fitsButWeak = evaluate(judgement(6), []);
  assert.equal(keepRewrite(noFit, fitsButWeak), true);
  assert.equal(keepRewrite(fitsButWeak, noFit), false);
});

test("holdDecision: a post that doesn't fit a thread is held with a clear summary, even if it passed", () => {
  const passed = qualityReport(evaluate(judgement(9), []), 1);
  const held = holdDecision(passed, "It needs 6 posts; a thread holds at most 5.");
  assert.equal(held?.status, "needs_review");
  assert.match(held?.summary ?? "", /doesn't fit a Bluesky thread of at most 5 posts \(It needs 6 posts/);
  assert.match(held?.summary ?? "", /publish:approvePost/);
  assert.equal(holdDecision(passed, null), null);
});

test("holdDecision: says what kind of hold it is (thread fit vs quality)", () => {
  const passed = qualityReport(evaluate(judgement(9), []), 1);
  assert.equal(holdDecision(passed, "It needs 6 posts; a thread holds at most 5.")?.heldFor, "thread_fit");
  assert.equal(holdDecision(qualityReport(evaluate(judgement(6), []), 2))?.heldFor, "quality");
});

test("hardChecks: the thread fit uses the language it goes out in", () => {
  // An English post that goes out with the (longer) Spanish disclosure is checked with that one.
  const issues = hardChecks(EN_POST, "en", "es");
  assert.ok(!issues.some((i) => i.id === "language"), "the spoken-language check is unchanged");
  assert.deepEqual(hardChecks(EN_POST, "en", "en"), hardChecks(EN_POST, "en"));
});

// ---------- message posts (he asked to post something specific) ----------

const MESSAGE = `I came to Cal Hacks with no idea at all.

I met a team there, we built something together, and we won. Tomorrow we go for more tracks.

Wish us luck, friends!`;

test("message posts: short is fine with MESSAGE_WORDS, a blocker for a story", () => {
  const story = hardChecks(MESSAGE, "en", "en");
  assert.ok(story.some((i) => i.id === "length" && i.severity === "major"));
  const message = hardChecks(MESSAGE, "en", "en", null, MESSAGE_WORDS);
  assert.equal(message.some((i) => i.severity === "major"), false);
  const tiny = hardChecks("We won.\n\nThanks all.", "en", "en", null, MESSAGE_WORDS);
  assert.ok(tiny.some((i) => i.id === "length" && i.severity === "major"));
});

test("messagePost: a written message wins; a skip, an empty text or a blocker leaves it to the story", () => {
  const checks = (t: string) => hardChecks(t, "en", "en", null, MESSAGE_WORDS);
  const post = messagePost({ skip: false, text: MESSAGE, hook: "I came to Cal Hacks with no idea at all." }, checks);
  assert.ok(post && !post.skip);
  assert.equal(post.hold, false);
  assert.equal(post.quality.mode, "message");
  assert.equal(post.quality.passed, true);
  assert.equal(messagePost(null, checks), null);
  assert.equal(messagePost({ skip: true, reason: "no message requested" }, checks), null);
  assert.equal(messagePost({ skip: false, text: "  ", hook: "" }, checks), null);
  assert.equal(messagePost({ skip: false, text: `${MESSAGE}\n\nhttps://example.com`, hook: "x" }, checks), null);
});
