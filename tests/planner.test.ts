// Run: node --test "tests/**/*.test.ts"   (Node 22.18+ / 24 strips TypeScript types natively)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FALLBACK_MAIN_QUESTION,
  PROMPT_VARIABLES,
  SOURCE_WEIGHTS,
  buildCallPlan,
  fallbackCandidates,
  filterTopicsByUrls,
  formatMemoriesBrief,
  formatProfile,
  isNearSilentCall,
  isNoConversation,
  languageName,
  normalizePlannedCandidates,
  normalizePostDraft,
  normalizeTopicKey,
  overlapsAvoid,
  overlapsTopic,
  rankCandidates,
  runSteps,
  startsWithHook,
  toPromptVariables,
  type Candidate,
} from "../convex/lib/planner.ts";
import { asElderV2, isOnboarding } from "../convex/lib/v2Fields.ts";
import { fixture, NOW } from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;

function cand(source: Candidate["source"], question: string, extra: Partial<Candidate> = {}): Candidate {
  return { question, why: "", source, topicKey: normalizeTopicKey(question), ...extra };
}

test("source weights put open threads first and profile last", () => {
  const order = Object.entries(SOURCE_WEIGHTS)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
  assert.deepEqual(order[0], "open_thread");
  assert.equal(order[1], "reader");
  assert.equal(order.at(-1), "profile");
});

test("rankCandidates orders by source and drops avoid topics", () => {
  const ranked = rankCandidates(
    [
      cand("memory", "What was your first bakery like?"),
      cand("reader", "How did you price bread in the seventies?"),
      cand("open_thread", "Tell me how you hired Eddie."),
      cand("audience", "How do you handle a strike at the plant?"),
    ],
    { avoid: ["the strike"], now: NOW },
  );
  assert.deepEqual(
    ranked.map((r) => r.source),
    ["open_thread", "reader", "memory"],
  );
});

test("covered topics are skipped unless an open thread or a reader asked", () => {
  const ranked = rankCandidates(
    [
      cand("memory", "Tell me about the oven breakdown in 1978.", { topicKey: "oven breakdown" }),
      cand("reader", "A reader asked: how did you fix the oven breakdown?", { topicKey: "oven breakdown fix" }),
    ],
    { covered: ["oven breakdown"], now: NOW },
  );
  assert.deepEqual(ranked.map((r) => r.source), ["reader"]);
});

test("dedupes by topic key, keeping the higher priority and the oldest firstSeenAt", () => {
  const ranked = rankCandidates(
    [
      cand("memory", "Tell me about hiring Eddie.", { topicKey: "hiring eddie", firstSeenAt: NOW - 3 * DAY }),
      cand("open_thread", "How did you hire Eddie?", { topicKey: "eddie hiring" }),
    ],
    { now: NOW },
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].source, "open_thread");
  assert.equal(ranked[0].firstSeenAt, NOW - 3 * DAY);
});

test("age decay halves weight every 14 days and very old items drop out", () => {
  const ranked = rankCandidates(
    [
      cand("reader", "Old reader question about flour prices?", { firstSeenAt: NOW - 14 * DAY }),
      cand("memory", "Fresh story seed about the station wagon?"),
      cand("open_thread", "Ancient thread about the move to Fresno?", { firstSeenAt: NOW - 90 * DAY }),
    ],
    { now: NOW },
  );
  // A 2-week-old reader question (80 -> 40) now sits close to a fresh story seed (40);
  // the 90-day-old thread is past maxAgeDays and gone.
  assert.deepEqual(ranked.map((r) => r.source).sort(), ["memory", "reader"]);
  const reader = ranked.find((r) => r.source === "reader")!;
  const memory = ranked.find((r) => r.source === "memory")!;
  assert.ok(reader.priority > 40 && reader.priority < 46, `reader priority ${reader.priority}`);
  assert.ok(Math.abs(reader.priority - memory.priority) < 5);
});

test("overlapsTopic: short topics need all words, long ones two", () => {
  const c = { question: "What happened during the 1994 strike?", topicKey: "strike 1994" };
  assert.equal(overlapsTopic(c, ["strike"]), true);
  assert.equal(overlapsTopic(c, ["the strike in '94 at the plant"]), false);
  assert.equal(overlapsTopic({ question: "Tell me about the plant strike", topicKey: "plant strike" }, ["the strike at the plant"]), true);
  assert.equal(overlapsTopic(c, []), false);
});

test("normalizePlannedCandidates cleans Claude output", () => {
  const out = normalizePlannedCandidates({
    candidates: [
      { question: "  Tell me about Rosa.  ", why: "w", source: "memory", sourceRef: "", topicKey: "Rosa Wife!" },
      { question: "", why: "", source: "memory", sourceRef: "", topicKey: "" },
      { question: "Bad source?", why: "", source: "gossip", sourceRef: "", topicKey: "x" },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].question, "Tell me about Rosa.");
  assert.equal(out[0].topicKey, "rosa-wife");
  assert.equal("sourceRef" in out[0], false);
  assert.deepEqual(normalizePlannedCandidates(null), []);
});

test("fallbackCandidates only uses the inputs", () => {
  const out = fallbackCandidates({
    openThreads: [{ id: "m1", text: "How he hired Eddie Morales." }],
    readerQuestions: ["How did you price bread?"],
    audienceQuestions: [{ id: "a1", title: "How do I keep staff motivated on night shifts?" }],
    recentTopics: [{ title: "Flour prices up 20%", question: "When flour prices jumped, what did you do?", url: "https://x.test/a" }],
  });
  assert.deepEqual(out.map((c) => c.source), ["open_thread", "reader", "recent_topic", "audience"]);
  assert.match(out[0].question, /how he hired eddie morales/i);
  assert.equal(out[0].sourceRef, "m1");
});

test("formatMemoriesBrief: uses the shared prompt format, people and places first, capped", () => {
  const text = formatMemoriesBrief(
    [
      { kind: "fact", text: "Ran a bakery on 5th Street" },
      { kind: "person", name: "Eddie Morales", text: "His foreman" },
      { kind: "avoid", text: "The 1994 strike" },
      { kind: "topic_covered", text: "oven breakdown" },
      { kind: "place", name: "Fresno", text: "Golden Crust plant in Fresno" },
    ],
    { max: 3 },
  );
  assert.equal(
    text,
    "People in his life: Eddie Morales (His foreman).\n" +
      "Places that matter to him: Fresno (Golden Crust plant in Fresno).\n" +
      "Ran a bakery on 5th Street.",
  );
});

test("buildCallPlan: story uses top bank item, distinct threads, bankId", () => {
  const plan = buildCallPlan({
    kind: "story",
    bank: [
      { _id: "b1", question: "Tell me how you hired Eddie.", topicKey: "eddie" },
      { _id: "b2", question: "How did you hire Eddie again?", topicKey: "eddie" },
      { _id: "b3", question: "What was Golden Crust like?", topicKey: "golden-crust" },
      { _id: "b4", question: "Tell me about Rosa.", topicKey: "rosa" },
      { _id: "b5", question: "First day at the plant?", topicKey: "plant" },
      { _id: "b6", question: "One too many?", topicKey: "extra" },
    ],
    memories: [{ kind: "person", name: "Eddie", text: "His foreman" }],
    feedbackLine: "  Readers loved the oven story.  ",
  });
  assert.equal(plan.mainQuestion, "Tell me how you hired Eddie.");
  assert.deepEqual(plan.threads, ["What was Golden Crust like?", "Tell me about Rosa.", "First day at the plant?"]);
  assert.deepEqual(plan.memories, ["People in his life: Eddie (His foreman)."]);
  assert.equal(plan.feedback, "Readers loved the oven story.");
  assert.equal(plan.bankId, "b1");
});

test("buildCallPlan: empty bank falls back; onboarding carries background only", () => {
  const story = buildCallPlan({ kind: "story", bank: [] });
  assert.equal(story.mainQuestion, FALLBACK_MAIN_QUESTION);
  assert.equal(story.bankId, undefined);
  const onboarding = buildCallPlan({ kind: "onboarding", knownBackground: " 30 years at Golden Crust " });
  assert.deepEqual(onboarding, { kind: "onboarding", threads: [], memories: [], knownBackground: "30 years at Golden Crust" });
});

test("toPromptVariables covers exactly the {{variables}} in the Vapi prompts", () => {
  const used = new Set<string>();
  for (const file of ["onboarding.md", "story-call.md"]) {
    const text = readFileSync(new URL(`../vapi/prompts/${file}`, import.meta.url), "utf8");
    for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) used.add(m[1]);
  }
  assert.deepEqual([...used].sort(), [...PROMPT_VARIABLES].sort());

  const plan = buildCallPlan({
    kind: "story",
    bank: [
      { _id: "b1", question: "Q1?", topicKey: "q1" },
      { _id: "b2", question: "Q2?", topicKey: "q2" },
    ],
    memories: [{ kind: "fact", text: "Ran a bakery" }],
  });
  const vars = toPromptVariables(plan, {
    name: "Walter Brandt",
    language: "es-MX",
    profile: { industry: "Baking", specialty: "Production", careerSummary: "Ran a bakery.", topicsToAvoid: ["the strike"] },
  });
  assert.deepEqual(Object.keys(vars).sort(), [...PROMPT_VARIABLES].sort());
  assert.equal(vars.firstName, "Walter");
  assert.equal(vars.language, "Spanish");
  assert.equal(vars.mainQuestion, "Q1?");
  assert.equal(vars.threads, "- Q2?");
  assert.equal(vars.memories, "- Ran a bakery.");
  assert.match(vars.profile, /Industry: Baking\./);
  assert.match(vars.profile, /Topics to avoid: the strike\./);
  assert.equal(vars.feedback, "");
  assert.equal(vars.knownBackground, "");
});

test("languageName maps codes and keeps unknown ones", () => {
  assert.equal(languageName("en-US"), "English");
  assert.equal(languageName("pt_BR"), "Portuguese");
  assert.equal(languageName("tl-PH"), "tl-PH");
  assert.equal(languageName(undefined), "English");
});

test("isNearSilentCall counts only his words", () => {
  const story = fixture<{ turns: { role: string; text: string }[] }>("story_call.json");
  assert.equal(isNearSilentCall(story.turns), false);
  assert.equal(
    isNearSilentCall([
      { role: "pip", text: "Hello? ".repeat(40) },
      { role: "elder", text: "Who is this?" },
    ]),
    true,
  );
  assert.equal(isNearSilentCall([]), true);
});

test("isNoConversation matches voicemail-like endings", () => {
  assert.equal(isNoConversation("voicemail"), true);
  assert.equal(isNoConversation("customer-did-not-answer"), true);
  assert.equal(isNoConversation("no_answer"), true);
  assert.equal(isNoConversation("customer-ended-call"), false);
  assert.equal(isNoConversation(undefined), false);
});

test("a call that ended on silence still counts when he talked", () => {
  const story = fixture<{ turns: { role: string; text: string }[] }>("story_call.json");
  assert.equal(isNoConversation("silence-timed-out"), false);
  assert.equal(isNoConversation("silence_timeout"), false);
  assert.equal(isNearSilentCall(story.turns), false);
});

test("recently used topics are never repeated, even by readers or open threads", () => {
  const ranked = rankCandidates(
    [
      cand("reader", "How did you price bread in the seventies?", { topicKey: "price bread" }),
      cand("open_thread", "Finish the story about pricing bread for the co-op?", { topicKey: "price bread coop" }),
      cand("memory", "Tell me about your first delivery van.", { topicKey: "delivery van" }),
    ],
    { recentlyUsed: ["price bread"], now: NOW },
  );
  assert.deepEqual(ranked.map((r) => r.source), ["memory"]);
});

test("readers may revisit covered topics but not recently used ones", () => {
  const ranked = rankCandidates(
    [cand("reader", "How did you fix the oven breakdown?", { topicKey: "oven breakdown fix" })],
    { covered: ["oven breakdown"], recentlyUsed: ["delivery van"], now: NOW },
  );
  assert.equal(ranked.length, 1);
});

test("dedupe keeps the oldest firstSeenAt in either order, and the age lowers priority", () => {
  const old = cand("memory", "Tell me about hiring Eddie.", { topicKey: "hiring eddie", firstSeenAt: NOW - 14 * DAY });
  const fresh = cand("memory", "How did you hire Eddie?", { topicKey: "eddie hiring" });
  for (const list of [
    [fresh, old],
    [old, fresh],
  ]) {
    const ranked = rankCandidates(list, { now: NOW });
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].firstSeenAt, NOW - 14 * DAY);
    // 14 days old: weight 40 halves to 20 (+ order bonus <= 5)
    assert.ok(ranked[0].priority <= 25, `priority ${ranked[0].priority}`);
  }
});

test("avoid entries written as sentences block any question on that subject", () => {
  const avoid = ["Doesn't want to talk about his brother's death."];
  assert.equal(
    overlapsAvoid({ question: "What was your brother like growing up?", topicKey: "brother growing" }, avoid),
    true,
  );
  assert.equal(overlapsAvoid({ question: "Tell me about your brothers.", topicKey: "brothers" }, avoid), true);
  assert.equal(
    overlapsAvoid({ question: "What did you want to be as a kid?", topicKey: "childhood dream" }, avoid),
    false,
  );
  const ranked = rankCandidates(
    [
      cand("open_thread", "Finish the story about your brother at the plant?", { topicKey: "brother plant" }),
      cand("memory", "Tell me about the first oven you bought.", { topicKey: "first oven" }),
    ],
    { avoid, now: NOW },
  );
  assert.deepEqual(ranked.map((r) => r.source), ["memory"]);
});

test("avoid topics from later calls always reach the profile variable", () => {
  const text = formatProfile(
    { industry: "Baking", specialty: "", careerSummary: "", topicsToAvoid: ["the strike"] },
    ["His brother's death.", "The strike"],
  );
  assert.match(text, /Topics to avoid: the strike; His brother's death\./);
  assert.equal(formatProfile(null, ["Health"]), "Topics to avoid: Health.");
  const vars = toPromptVariables(buildCallPlan({ kind: "story" }), { name: "Walter", profile: null }, { avoid: ["Health"] });
  assert.match(vars.profile, /Topics to avoid: Health\./);
});

test("normalizePostDraft: skip, and the hook appears once despite spacing/punctuation", () => {
  assert.deepEqual(normalizePostDraft({ skip: true, reason: "only small talk", hook: "", text: "" }), {
    skip: true,
    reason: "only small talk",
  });
  assert.deepEqual(normalizePostDraft({ skip: false, reason: "", hook: "", text: "  " }), {
    skip: true,
    reason: "nothing worth posting",
  });
  const draft = normalizePostDraft({
    skip: false,
    reason: "",
    hook: "The night the oven caught fire.",
    text: "The night  the oven caught fire!\n\nIt was 1978...",
  });
  assert.equal(draft.skip, false);
  if (!draft.skip) {
    assert.equal(draft.text.startsWith("The night  the oven caught fire!"), true);
    assert.equal(draft.text.match(/oven caught fire/g)?.length, 1);
  }
  const added = normalizePostDraft({ skip: false, reason: "", hook: "Bread taught me patience.", text: "It was 1962." });
  assert.equal(!added.skip && added.text, "Bread taught me patience.\n\nIt was 1962.");
  assert.equal(startsWithHook("Hello, world", "hello world"), true);
});

test("runSteps isolates failures and reports skips", async () => {
  const ran: string[] = [];
  const reports = await runSteps([
    { step: "save", run: async () => { ran.push("save"); return "ok"; } },
    { step: "memories", run: async () => { throw new Error("boom"); } },
    { step: "post", skip: "voicemail", run: async () => { ran.push("post"); } },
    { step: "plan", run: async () => { ran.push("plan"); } },
  ]);
  assert.deepEqual(ran, ["save", "plan"]);
  assert.deepEqual(reports, [
    { step: "save", status: "ok", detail: "ok" },
    { step: "memories", status: "failed", detail: "boom" },
    { step: "post", status: "skipped", detail: "voicemail" },
    { step: "plan", status: "ok" },
  ]);
});

test("filterTopicsByUrls drops topics with invented links", () => {
  const kept = filterTopicsByUrls(
    [
      { url: "https://news.test/flour?utm=1", title: "a" },
      { url: "https://made.up/story", title: "b" },
    ],
    ["https://news.test/flour/"],
  );
  assert.deepEqual(kept.map((t) => t.title), ["a"]);
});

test("asElderV2 reads v1 and v2 rows; onboarding until a profile exists", () => {
  const v1 = asElderV2({ _id: "e1", name: "Walter", phone: "+1", expertise: [], language: "en-US" })!;
  assert.equal(v1.profile, undefined);
  assert.equal(isOnboarding(v1), true);
  const v2 = asElderV2({
    _id: "e2",
    name: "Walter",
    stage: "active",
    profile: { industry: "Baking", specialty: "", careerSummary: "", topicsToAvoid: ["x", 3] },
    knownBackground: "Golden Crust",
  })!;
  assert.deepEqual(v2.profile, { industry: "Baking", specialty: "", careerSummary: "", topicsToAvoid: ["x"] });
  assert.equal(isOnboarding(v2), false);
  assert.equal(isOnboarding({ ...v2, stage: "onboarding" }), true);
  assert.equal(asElderV2(null), null);
});
