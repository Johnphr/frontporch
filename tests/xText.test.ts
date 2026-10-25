// X text (lib/xText.ts): the weighted counter, the thread split and single-post mode.
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_DISCLOSURE, SPANISH_DISCLOSURE } from "../convex/lib/linkedinPost.ts";
import {
  X_MAX_WEIGHTED,
  X_SHORT_DISCLOSURE,
  X_SHORT_DISCLOSURE_ES,
  hasUrl,
  singleXPost,
  splitXThread,
  weightedLength,
} from "../convex/lib/xText.ts";

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

test("thread split: post 1 = hook + the full AI note; the rest has no note; all within 280 weighted", () => {
  const split = splitXThread(STORY, "en");
  assert.ok(split.ok);
  if (!split.ok) return;
  assert.ok(split.posts.length >= 2 && split.posts.length <= 5);
  assert.equal(split.posts[0], `In 1974 I walked into the plant manager's office and told him the line was unsafe.\n\n${DEFAULT_DISCLOSURE}`);
  assert.equal(split.disclosure, DEFAULT_DISCLOSURE);
  assert.ok(!split.posts.slice(1).some((p) => p.includes(DEFAULT_DISCLOSURE) || p.includes(X_SHORT_DISCLOSURE)));
  assert.ok(split.posts.at(-1)!.endsWith("Have you ever had to stop the line to do the right thing?"));
  for (const p of split.posts) assert.ok(weightedLength(p) <= X_MAX_WEIGHTED);
  // Nothing of the story is lost: the posts minus the note are the story.
  const text = [split.hook, ...split.posts.slice(1)].join(" ").replace(/\s+/g, " ");
  assert.equal(text, STORY.replace(/\s+/g, " "));
});

test("thread split: a long hook gets the short note (EN / ES), still in post 1", () => {
  const hook = "In the winter of 1974 I walked into the plant manager's office with a clipboard full of numbers and told him, as plainly as I could, that the main press line was unsafe and that somebody was going to lose a hand on it before spring.";
  const story = [hook, ...STORY.split("\n\n").slice(1)].join("\n\n");
  const en = splitXThread(story, "en");
  assert.ok(en.ok, en.ok ? "" : en.reason);
  if (!en.ok) return;
  assert.equal(en.disclosure, X_SHORT_DISCLOSURE);
  assert.ok(en.posts[0].startsWith("In the winter of 1974"));
  assert.ok(en.posts[0].endsWith(`\n\n${X_SHORT_DISCLOSURE}`));
  for (const p of en.posts) assert.ok(weightedLength(p) <= X_MAX_WEIGHTED, String(weightedLength(p)));
  const es = splitXThread(story, "es");
  assert.ok(es.ok);
  if (es.ok) assert.ok(es.posts[0].endsWith(X_SHORT_DISCLOSURE_ES));
});

test("thread split: a first paragraph too long for the note is re-split until post 1 fits with it", () => {
  const hook = "I worked on the line for forty years and saw everything change. ".repeat(4).trim();
  assert.ok(weightedLength(hook) <= X_MAX_WEIGHTED && weightedLength(`${hook}\n\n${X_SHORT_DISCLOSURE}`) > X_MAX_WEIGHTED);
  const split = splitXThread([hook, ...STORY.split("\n\n").slice(1)].join("\n\n"), "en");
  assert.ok(split.ok, split.ok ? "" : split.reason);
  if (!split.ok) return;
  assert.ok(split.posts[0].startsWith("I worked on the line"));
  assert.ok(split.posts[0].endsWith(X_SHORT_DISCLOSURE) || split.posts[0].endsWith(DEFAULT_DISCLOSURE));
  for (const p of split.posts) assert.ok(weightedLength(p) <= X_MAX_WEIGHTED, String(weightedLength(p)));
});

test("thread split: one opening sentence too long to share post 1 with the note fails clearly", () => {
  const hook = `${"I worked on the line for forty years and saw everything change, ".repeat(4)}and then I retired.`;
  const split = splitXThread([hook, ...STORY.split("\n\n").slice(1)].join("\n\n"), "en");
  assert.equal(split.ok, false);
  if (!split.ok) assert.match(split.reason, /too long to share the first X post with the AI note/);
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

test("single post: the short note when only it leaves room for the whole first sentence", () => {
  const first = `${"We ran three shifts and I knew every operator by name, ".repeat(3)}and every one of them by their coffee order too.`;
  assert.ok(weightedLength(first) + 2 + weightedLength(DEFAULT_DISCLOSURE) > X_MAX_WEIGHTED);
  assert.ok(weightedLength(first) + 2 + weightedLength(X_SHORT_DISCLOSURE) <= X_MAX_WEIGHTED);
  const one = singleXPost(`${first}\n\nThat was the job.`, "en");
  assert.ok(one.ok);
  if (!one.ok) return;
  assert.equal(one.posts[0], `${first}\n\nThat was the job.\n\n${X_SHORT_DISCLOSURE}`);
  assert.equal(one.disclosure, X_SHORT_DISCLOSURE);
});
