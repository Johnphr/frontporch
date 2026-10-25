// X text (lib/xText.ts): the weighted counter, the thread split and single-post mode.
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_DISCLOSURE, SPANISH_DISCLOSURE } from "../convex/lib/linkedinPost.ts";
import { X_MAX_WEIGHTED, hasUrl, singleXPost, splitXThread, weightedLength } from "../convex/lib/xText.ts";

test("weighted counter: Latin and accents 1, CJK 2, emoji 2, URLs 23", () => {
  assert.equal(weightedLength("hello"), 5);
  assert.equal(weightedLength("café señor über"), 15);
  assert.equal(weightedLength("café"), 4, "decomposed accent counts once after NFC");
  assert.equal(weightedLength("—“quotes”"), 9, "dashes and curly quotes count 1");
  assert.equal(weightedLength("…"), 2, "the ellipsis (U+2026) is outside the light ranges");
  assert.equal(weightedLength("日本語"), 6);
  assert.equal(weightedLength("한국어"), 6);
  assert.equal(weightedLength("😀"), 2);
  assert.equal(weightedLength("👨‍👩‍👧‍👦"), 2, "a ZWJ family is one emoji");
  assert.equal(weightedLength("🇺🇸"), 2, "a flag is one emoji");
  assert.equal(weightedLength("❤️"), 2);
  assert.equal(weightedLength("© 2026"), 6, "plain © is Latin-1");
  assert.equal(weightedLength("see https://example.com/a/very/long/path?with=query"), 4 + 23);
  assert.equal(weightedLength("go to frontporch.io."), 6 + 23 + 1, "bare domain, trailing dot not in the link");
  assert.equal(weightedLength("x".repeat(280)), 280);
});

test("hasUrl spots links (they cost more on X)", () => {
  assert.ok(hasUrl("read https://x.com/a"));
  assert.ok(hasUrl("visit example.org"));
  assert.ok(!hasUrl("I worked at 3M. Then I retired."));
});

const STORY = [
  "In 1974 I walked into the plant manager's office and told him the line was unsafe.",
  "He didn't want to hear it. Production was everything that year, and I was the new engineer with a clipboard and no friends on the floor. I spent three weeks measuring the gap between the press and the guard, and writing down every near miss the night shift told me about over coffee.",
  "When I finally put the numbers on his desk, he read them twice. Then he shut the line down for a weekend and we rebuilt the guards ourselves. Nobody lost a hand on that press for the next twenty years.",
  "What I learned: bring the numbers, but also bring the people who live with the problem. The numbers open the door; the people keep it open.",
  "Have you ever had to stop the line to do the right thing?",
].join("\n\n");

test("thread split: hook first, AI note at the end of the last post, all within 280 weighted", () => {
  const split = splitXThread(STORY, "en");
  assert.ok(split.ok);
  if (!split.ok) return;
  assert.ok(split.posts.length >= 2 && split.posts.length <= 5);
  assert.equal(split.posts[0], "In 1974 I walked into the plant manager's office and told him the line was unsafe.");
  assert.ok(split.posts.at(-1)!.endsWith(DEFAULT_DISCLOSURE));
  for (const p of split.posts) assert.ok(weightedLength(p) <= X_MAX_WEIGHTED);
  assert.equal(split.posts.filter((p) => p.includes(DEFAULT_DISCLOSURE)).length, 1);
});

test("thread split: CJK text (2 per char) is re-split until every post fits", () => {
  const para = "私は工場で四十年働きました。毎日、安全のことを考えていました。".repeat(3);
  const split = splitXThread(["最初の日のことを覚えています。", para, para].join("\n\n"), "en");
  assert.ok(split.ok, split.ok ? "" : split.reason);
  if (!split.ok) return;
  for (const p of split.posts) assert.ok(weightedLength(p) <= X_MAX_WEIGHTED, `${weightedLength(p)} > 280`);
});

test("thread split: too long for 5 posts says so", () => {
  const long = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} goes on about the plant and the guards and the long nights on the floor, and it keeps going for a while.`).join("\n\n");
  const split = splitXThread(long, "en");
  assert.equal(split.ok, false);
});

test("single post: hook + next sentences + AI note, at most 280 weighted", () => {
  const one = singleXPost(STORY, "en");
  assert.ok(one.ok);
  if (!one.ok) return;
  assert.equal(one.posts.length, 1);
  const post = one.posts[0];
  assert.ok(post.startsWith("In 1974 I walked into the plant manager's office"));
  assert.ok(post.endsWith(`\n\n${DEFAULT_DISCLOSURE}`));
  assert.ok(weightedLength(post) <= X_MAX_WEIGHTED, String(weightedLength(post)));
  assert.ok(post.includes("He didn't want to hear it."), "fills with the next sentences");
});

test("single post: Spanish note; an overlong opening sentence is cut at a word", () => {
  const long = `${"Trabajé en la fábrica durante muchos años y aprendí ".repeat(8)}mucho.`;
  const one = singleXPost(long, "es");
  assert.ok(one.ok);
  if (!one.ok) return;
  assert.ok(one.posts[0].endsWith(SPANISH_DISCLOSURE));
  assert.ok(one.hook.endsWith("…"));
  assert.ok(weightedLength(one.posts[0]) <= X_MAX_WEIGHTED);
  assert.equal(singleXPost("   ", "en").ok, false);
});
