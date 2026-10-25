// Run: npm test (Node 22.18+ / 24 strips TypeScript types natively)
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CRITERIA,
  MAX_REWRITE_ROUNDS,
  MIN_CRITERION,
  MINOR_PENALTY,
  PASS_SCORE,
  QUALITY_BUDGET_MS,
  ROUND_COST_MS,
  WEIGHTS,
  detectLanguage,
  evaluate,
  hardChecks,
  holdDecision,
  keepRewrite,
  nextStep,
  normalizeJudgement,
  pickBest,
  qualityReport,
  shouldSkip,
  trimNotes,
  wordCount,
  type CriterionScores,
  type Judgement,
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
  const longHook = `${"A very long first line that just keeps going ".repeat(4)}\n\n${words(130)}\n\nWhat do you think?`;
  assert.ok(ids(longHook).includes("hook_length:minor"));
  assert.ok(ids(`${EN_POST} #bread #baking #family`).includes("hashtags:minor"));
  assert.ok(ids(EN_POST.replace("The lesson", "Let's delve into it. The lesson")).includes("stock_phrases:minor"));
  assert.ok(ids(EN_POST.replace("The lesson", "**The lesson**")).includes("markdown:minor"));
  assert.ok(ids(EN_POST.replace("What old tool has saved your day at work?", "Thanks for reading.")).includes("no_question:minor"));
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

test("shouldSkip: majority of drafts decline", () => {
  assert.equal(shouldSkip(2, 3), true);
  assert.equal(shouldSkip(1, 3), false);
  assert.equal(shouldSkip(1, 1), true);
  assert.equal(shouldSkip(0, 0), false);
});

test("holdDecision: below the bar -> needs_review with the notes; passed -> post as usual", () => {
  const held = holdDecision(qualityReport(evaluate(judgement(6, { notes: ["Hook is flat"] }), []), 2));
  assert.equal(held?.status, "needs_review");
  assert.match(held?.summary ?? "", /Held by the quality check: 60\/100 \(bar 75\) after 2 rewrites/);
  assert.ok(held?.issues.includes("Hook is flat"));
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

test("approve decision: quality holds get fact-checked on approve, guard holds don't", async () => {
  const { shouldRunGuard } = await import("../convex/lib/postFlow.ts");
  assert.equal(shouldRunGuard(false, undefined), true); // createPost always checks
  assert.equal(shouldRunGuard(false, "quality"), true);
  assert.equal(shouldRunGuard(true, "quality"), true); // never fact-checked yet
  assert.equal(shouldRunGuard(true, "guard"), false); // already checked; a person approved it
  assert.equal(shouldRunGuard(true, undefined), false); // older guard holds, as before
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
