import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MERGE_THRESHOLD,
  cosineSimilarity,
  dedupeBatch,
  differentNames,
  embeddingText,
  formatMemoriesForPrompt,
  isRetryableStatus,
  mergeText,
  retryDelayMs,
  shouldMerge,
  similarityKey,
} from "../convex/lib/memoryText.ts";

test("similarityKey: people/places by name, everything else by normalized text", () => {
  assert.equal(
    similarityKey("person", "his wife of 50 years", "Maria"),
    similarityKey("person", "they married in 1970", "  maría "),
  );
  assert.equal(similarityKey("fact", "Ran a bakery, on 5th St!"), similarityKey("fact", "ran a bakery on 5th st"));
  assert.notEqual(similarityKey("fact", "ran a bakery"), similarityKey("story_seed", "ran a bakery"));
  // a person without a name falls back to the text
  assert.equal(similarityKey("person", "His first boss"), "person|his first boss");
});

test("shouldMerge: same kind only; same-named people always merge; others need a high score", () => {
  const maria = { kind: "person", name: "Maria", text: "his wife" };
  assert.equal(shouldMerge(maria, { kind: "person", name: "maria", text: "married 1970" }, 0.2), true);
  assert.equal(shouldMerge(maria, { kind: "person", name: "Rosa", text: "his sister" }, 0.5), false);
  assert.equal(shouldMerge(maria, { kind: "fact", text: "his wife" }, 0.99), false);
  const fact = { kind: "fact", text: "Worked at Boeing for 30 years" };
  assert.equal(shouldMerge(fact, { kind: "fact", text: "30 years at Boeing" }, MERGE_THRESHOLD + 0.01), true);
  assert.equal(shouldMerge(fact, { kind: "fact", text: "Loves fishing" }, 0.8), false);
});

test("mergeText keeps the more specific (longer) wording", () => {
  assert.equal(mergeText("Ran a bakery", "Ran a bakery on 5th street in the 60s"), "Ran a bakery on 5th street in the 60s");
  assert.equal(mergeText("Ran a bakery on 5th street", "a bakery"), "Ran a bakery on 5th street");
  assert.equal(mergeText("same", "    "), "same");
  assert.equal(mergeText("", "new"), "new");
});

test("dedupeBatch drops empty/unknown items and merges repeats in one batch", () => {
  const out = dedupeBatch([
    { kind: "fact", text: "  Ran a bakery  " },
    { kind: "fact", text: "ran a bakery!" },
    { kind: "fact", text: "   " },
    { kind: "nonsense", text: "x" },
    { kind: "person", text: "his wife", name: " Maria " },
    { kind: "person", text: "his wife of 52 years, met at a dance", name: "maria" },
    { kind: "place", text: "Everett plant", name: "   " },
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { kind: "fact", text: "Ran a bakery" });
  assert.deepEqual(out[1], { kind: "person", text: "his wife of 52 years, met at a dance", name: "Maria" });
  assert.deepEqual(out[2], { kind: "place", text: "Everett plant" });
});

test("cosineSimilarity basics", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]).toFixed(6), "1.000000");
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

test("embeddingText prefixes the name only when the text doesn't already say it", () => {
  assert.equal(embeddingText({ kind: "person", name: "Mr. Kim", text: "his first boss" }), "Mr. Kim: his first boss");
  assert.equal(embeddingText({ kind: "person", name: "Maria", text: "Maria, his wife" }), "Maria, his wife");
  assert.equal(embeddingText({ kind: "fact", text: " Ran a bakery " }), "Ran a bakery");
});

test("formatMemoriesForPrompt groups memories, most useful first, no bullets", () => {
  const text = formatMemoriesForPrompt([
    { kind: "fact", text: "Worked at Boeing for 30 years" },
    { kind: "avoid", text: "his divorce" },
    { kind: "person", text: "his wife of 52 years", name: "Maria" },
    { kind: "open_thread", text: "the flood of '78 at the plant." },
    { kind: "open_thread", text: "the night shift strike", status: "resolved" },
    { kind: "place", text: "Everett plant" },
    { kind: "story_seed", text: "fixing a 747 engine in a snowstorm" },
    { kind: "topic_covered", text: "his first job" },
    { kind: "person", text: "Mr. Kim, his first boss", name: "Mr. Kim" },
  ]);
  const lines = text.split("\n");
  assert.equal(
    lines[0],
    "He started telling you about the flood of '78 at the plant but didn't finish. Ask him to finish that story.",
  );
  assert.equal(lines[1], "People in his life: Maria (his wife of 52 years); Mr. Kim, his first boss.");
  assert.equal(lines[2], "Places that matter to him: Everett plant.");
  assert.equal(lines[3], "Stories he has mentioned: fixing a 747 engine in a snowstorm.");
  assert.equal(lines[4], "Worked at Boeing for 30 years.");
  assert.match(lines[5], /^Already talked about .*his first job\.$/);
  assert.equal(lines[6], "He doesn't want to talk about: his divorce.");
  assert.ok(!text.includes("strike"), "resolved open threads are left out");
  assert.ok(!/^[-*•]/m.test(text), "no bullets");
});

test("formatMemoriesForPrompt respects max (by priority) and handles empty input", () => {
  const many = [
    { kind: "fact", text: "fact one" },
    { kind: "fact", text: "fact two" },
    { kind: "open_thread", text: "the flood" },
    { kind: "person", text: "his wife", name: "Maria" },
  ];
  const text = formatMemoriesForPrompt(many, { max: 2 });
  assert.ok(text.includes("the flood"));
  assert.ok(text.includes("Maria"));
  assert.ok(!text.includes("fact one"));
  assert.equal(formatMemoriesForPrompt([]), "");
  assert.equal(formatMemoriesForPrompt([{ kind: "fact", text: "   " }]), "");
});

test("MERGE_THRESHOLD is 0.85: close rewordings merge, looser matches don't", () => {
  assert.equal(MERGE_THRESHOLD, 0.85);
  const fact = { kind: "fact", text: "Worked 30 years at Boeing" };
  assert.equal(shouldMerge(fact, { kind: "fact", text: "Spent three decades at Boeing" }, 0.86), true);
  assert.equal(shouldMerge(fact, { kind: "fact", text: "Worked at a plane factory" }, 0.84), false);
});

test("shouldMerge: two different names never merge, whatever the score", () => {
  const tom = { kind: "person", name: "Tom", text: "his brother, a machinist" };
  const bill = { kind: "person", name: "Bill", text: "his brother, a machinist" };
  assert.equal(shouldMerge(tom, bill, 0.99), false);
  // same name merges even with a low score (different detail about the same person)
  assert.equal(shouldMerge(tom, { kind: "person", name: " tom ", text: "taught him to weld" }, 0.3), true);
  // the rule applies to any kind that carries a name
  assert.equal(shouldMerge({ kind: "place", name: "Fresno", text: "plant" }, { kind: "place", name: "Everett", text: "plant" }, 0.97), false);
  // one side without a name falls back to the score
  assert.equal(shouldMerge(tom, { kind: "person", text: "his brother, a machinist" }, 0.9), true);
});

test("differentNames only when both names exist and differ", () => {
  assert.equal(differentNames({ kind: "person", text: "", name: "Tom" }, { kind: "person", text: "", name: "Bill" }), true);
  assert.equal(differentNames({ kind: "person", text: "", name: "María" }, { kind: "person", text: "", name: "maria" }), false);
  assert.equal(differentNames({ kind: "person", text: "", name: "Tom" }, { kind: "person", text: "" }), false);
});

test("OpenAI retry: retryable statuses and Retry-After handling", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(retryDelayMs("2"), 2000);
  assert.equal(retryDelayMs("0.5"), 500);
  assert.equal(retryDelayMs(null), 1500);
  assert.equal(retryDelayMs("not a date"), 1500);
  assert.equal(retryDelayMs("120"), 20_000); // capped
  const now = Date.parse("2026-10-25T10:00:00Z");
  assert.equal(retryDelayMs("Sun, 25 Oct 2026 10:00:03 GMT", now), 3000);
  assert.equal(retryDelayMs("Sun, 25 Oct 2026 09:59:00 GMT", now), 0); // date in the past
});
