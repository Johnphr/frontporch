// The post opens with the question a real person asked (lib/postQuality.ts, "the question behind the call").
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ASKED_TAG,
  MAX_ASKED_CHARS,
  askedQuestionForCall,
  askedQuestionJudgeRules,
  askedQuestionRules,
  cleanAskedQuestion,
  evaluate,
  hardChecks,
  quotesVerbatim,
  withAskedQuestion,
  writerContextParts,
  type AskedQuestion,
  type CriterionScores,
  CRITERIA,
} from "../convex/lib/postQuality.ts";

const words = (n: number, w = "bread") => Array.from({ length: n }, () => w).join(" ");

const EN_HOOK = "People often ask how a small bakery set its prices. Here's how we did it in 1974.";
const EN_POST = [
  EN_HOOK,
  "",
  `${words(60, "dough")} I sat down with Eddie, my foreman, and we wrote every cost on the back of a flour sack.`,
  "",
  `${words(60, "flour")} We added a dime a loaf and nobody left us.`,
  "",
  "The lesson I took from it: know your costs before you know your price.",
  "",
  "How did you set your first prices?",
].join("\n");

const ES_HOOK = "Me preguntan mucho cómo ponía precios una panadería chica. Así lo hacíamos en 1974.";
const ES_POST = [
  ES_HOOK,
  "",
  `Me senté con Eddie, mi encargado, y escribimos cada costo en un costal de harina. ${words(60, "masa")}`,
  "",
  `Le subimos diez centavos al pan y nadie se fue. ${words(60, "harina")}`,
  "",
  "Lo que aprendí: hay que saber lo que cuesta antes de poner el precio.",
  "",
  "¿Cómo puso usted sus primeros precios?",
].join("\n");

const AUDIENCE_Q: AskedQuestion = { text: "How did small bakeries decide what to charge for a loaf of bread back then?", source: "audience" };

const bank = (source: string, extra: Record<string, string> = {}) => ({ _id: "bank1", source, question: "How did you price your bread?", ...extra });

// ---------- which calls get a question (pipeline.getAskedQuestion) ----------

test("askedQuestionForCall: a reader question -> the bank row's question", () => {
  assert.deepEqual(askedQuestionForCall({ bankId: "bank1" }, bank("reader"), null), {
    text: "How did you price your bread?",
    source: "reader",
  });
});

test("askedQuestionForCall: an audience question -> the original title, not Pip's wording", () => {
  const row = bank("audience", { sourceRef: "aq1" });
  const got = askedQuestionForCall({ bankId: "bank1" }, row, { _id: "aq1", title: "How do small bakeries price bread?" });
  assert.deepEqual(got, { text: "How do small bakeries price bread?", source: "audience" });
});

test("askedQuestionForCall: other sources keep today's hooks", () => {
  for (const source of ["open_thread", "memory", "profile", "recent_topic"]) {
    assert.equal(askedQuestionForCall({ bankId: "bank1" }, bank(source, { sourceRef: "aq1" }), { _id: "aq1", title: "A real question here?" }), null, source);
  }
});

test("askedQuestionForCall: no plan, another bank row, or a missing audience row -> null", () => {
  assert.equal(askedQuestionForCall(undefined, bank("reader"), null), null);
  assert.equal(askedQuestionForCall({}, bank("reader"), null), null);
  assert.equal(askedQuestionForCall({ bankId: "other" }, bank("reader"), null), null);
  assert.equal(askedQuestionForCall({ bankId: "bank1" }, null, null), null);
  const row = bank("audience", { sourceRef: "aq1" });
  assert.equal(askedQuestionForCall({ bankId: "bank1" }, row, null), null);
  assert.equal(askedQuestionForCall({ bankId: "bank1" }, row, { _id: "aq2", title: "How do small bakeries price bread?" }), null);
  assert.equal(askedQuestionForCall({ bankId: "bank1" }, row, { _id: "aq1", title: "https://example.com/x" }), null, "nothing left after cleaning");
});

// ---------- cleaning ----------

test("cleanAskedQuestion: no links, handles, u/ or r/ names; hashtags become words", () => {
  const got = cleanAskedQuestion("[Question] @baker_joe asked in r/Baking: how do you #price bread? see https://reddit.com/r/Baking/x and www.example.com u/someone");
  assert.equal(got, "asked in: how do you price bread? see and");
  assert.doesNotMatch(got, /@|http|www|r\/|u\//);
  assert.equal(cleanAskedQuestion("Check bsky.app/profile/x.bsky.social please"), "Check please");
  assert.equal(cleanAskedQuestion("   "), "");
});

test("cleanAskedQuestion: clipped to MAX_ASKED_CHARS", () => {
  const got = cleanAskedQuestion(`${"how did you run the bakery when ".repeat(20)}?`);
  assert.ok(Array.from(got).length <= MAX_ASKED_CHARS);
  assert.match(got, /…$/);
});

// ---------- prompt and context ----------

test("writerContextParts: without a question, the usual sections only", () => {
  const parts = writerContextParts({ transcript: "ELDER: hi", background: "Baker", feedback: "the oven story" });
  assert.deepEqual(parts.map((p) => p.tag), ["transcript", "background", "readers"]);
  assert.deepEqual(writerContextParts({ transcript: "ELDER: hi", background: "" }).map((p) => p.tag), ["transcript"]);
});

test("writerContextParts: with a question, it's the last section (text only)", () => {
  const parts = writerContextParts({ transcript: "ELDER: hi", askedQuestion: AUDIENCE_Q });
  assert.deepEqual(parts.map((p) => p.tag), ["transcript", ASKED_TAG]);
  assert.match(parts[1].body, /asked this online: How did small bakeries decide/);
  const reader = writerContextParts({ transcript: "ELDER: hi", askedQuestion: { text: "How did you price bread?", source: "reader" } });
  assert.match(reader[1].body, /^A reader of his posts asked this: How did you price bread\?$/);
});

test("askedQuestionRules: nothing without a question; the system prompt is unchanged", () => {
  assert.equal(askedQuestionRules(null, "en"), "");
  assert.equal(askedQuestionRules(undefined, "es"), "");
  assert.equal(withAskedQuestion("SYSTEM", askedQuestionRules(null, "en")), "SYSTEM");
  assert.equal(askedQuestionJudgeRules(null), "");
});

test("askedQuestionRules: English opens with the question in his voice, never quoted, tagged or linked", () => {
  const rules = askedQuestionRules(AUDIENCE_Q, "en");
  assert.match(rules, /People often ask how a small bakery set its prices/);
  assert.doesNotMatch(rules, /Me preguntan/);
  assert.match(rules, /Never quote the question word for word/);
  assert.match(rules, /tag \(@\) or link/);
  assert.match(rules, /ends with a question to readers/);
  assert.match(withAskedQuestion("SYSTEM", rules), /^SYSTEM\n\nThis call answered a question/);
});

test("askedQuestionRules: Spanish gets Spanish examples", () => {
  const rules = askedQuestionRules(AUDIENCE_Q, "es");
  assert.match(rules, /Me preguntan mucho cómo/);
  assert.doesNotMatch(rules, /People often ask/);
});

test("askedQuestionJudgeRules: the hook must frame the question; quotes, names and links score low", () => {
  const rules = askedQuestionJudgeRules(AUDIENCE_Q);
  assert.match(rules, /For hook/);
  assert.match(rules, /word for word/);
  assert.match(rules, /link/);
  assert.match(rules, /not an unsupported fact/);
});

// ---------- hard checks ----------

test("hardChecks: a post that frames the question cleanly has no issues (EN and ES)", () => {
  assert.deepEqual(hardChecks(EN_POST, "en", "en", AUDIENCE_Q), []);
  assert.deepEqual(hardChecks(ES_POST, "es", "es", { text: "¿Cómo decidían las panaderías chicas cuánto cobrar por el pan?", source: "audience" }), []);
});

test("hardChecks: an @handle is a blocker, with or without a question", () => {
  const tagged = EN_POST.replace(EN_HOOK, "@baker_joe asked how a small bakery set its prices. Here's how we did it.");
  assert.ok(hardChecks(tagged, "en").some((i) => i.id === "mention" && i.severity === "major"));
  assert.ok(hardChecks(tagged, "en", "en", AUDIENCE_Q).some((i) => i.id === "mention"));
  const es = ES_POST.replace("nadie se fue", "nadie se fue, como dijo @maria.bsky.social");
  assert.ok(hardChecks(es, "es").some((i) => i.id === "mention" && i.severity === "major"));
  assert.ok(!hardChecks(EN_POST.replace("a dime", "a dime @ the counter"), "en").some((i) => i.id === "mention"), "a lone @ isn't a handle");
});

test("hardChecks: a link is a blocker (EN and ES)", () => {
  for (const link of ["https://reddit.com/r/Baking/comments/abc", "www.example.com", "bsky.app/profile/joe"]) {
    const post = EN_POST.replace("nobody left us.", `nobody left us. ${link}`);
    assert.ok(hardChecks(post, "en").some((i) => i.id === "link" && i.severity === "major"), link);
  }
  const es = ES_POST.replace("nadie se fue.", "nadie se fue. https://example.org/hilo");
  assert.ok(hardChecks(es, "es").some((i) => i.id === "link" && i.severity === "major"));
  assert.ok(!hardChecks(EN_POST, "en").some((i) => i.id === "link"));
});

test("hardChecks: quoting the asked question word for word is a blocker; a paraphrase isn't", () => {
  const quoted = EN_POST.replace(EN_HOOK, `Someone asked: "${AUDIENCE_Q.text}"`);
  assert.ok(hardChecks(quoted, "en", "en", AUDIENCE_Q).some((i) => i.id === "quoted_question" && i.severity === "major"));
  assert.ok(!hardChecks(quoted, "en", "en").some((i) => i.id === "quoted_question"), "only checked when there's a question");
  assert.ok(!hardChecks(EN_POST, "en", "en", AUDIENCE_Q).some((i) => i.id === "quoted_question"));
});

test("quotesVerbatim: 8 words in a row, all of a 6-7 word question, never a shorter one", () => {
  assert.equal(quotesVerbatim("They ask how did you price your bread back then, and I tell them.", "How did you price your bread back then?"), true);
  assert.equal(quotesVerbatim("People ask how I priced my bread back then.", "How did you price your bread back then?"), false);
  assert.equal(quotesVerbatim("How do you price bread? Here's how.", "How do you price bread?"), false, "under 6 words: too generic to count");
  assert.equal(quotesVerbatim("¿Cómo decidían las panaderías chicas cuánto cobrar? Así lo hacíamos.", "¿Cómo decidían las panaderías chicas cuánto cobrar por el pan?"), false);
  assert.equal(quotesVerbatim("Alguien preguntó cómo decidían las panaderías chicas cuánto cobrar por el pan.", "¿Cómo decidían las panaderías chicas cuánto cobrar por el pan?"), true);
});

test("evaluate: a mention or link blocks a pass even with top judge scores", () => {
  const scores = Object.fromEntries(CRITERIA.map((c) => [c, 10])) as CriterionScores;
  const issues = hardChecks(EN_POST.replace("nobody left us.", "nobody left us. https://example.com"), "en");
  const e = evaluate({ scores, unsupportedFacts: [], notes: [] }, issues);
  assert.equal(e.passed, false);
  assert.match(e.notes[0], /link/);
});
