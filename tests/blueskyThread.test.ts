// Story post -> Bluesky thread split (convex/lib/blueskyThread.ts). Pure, no network.
import { test } from "node:test";
import assert from "node:assert/strict";

import { graphemeCount } from "../convex/lib/bluesky.ts";
import {
  MAX_THREAD_POSTS,
  MIN_THREAD_POSTS,
  hashtagFacets,
  recoverThreadRecords,
  splitBlueskyThread,
  threadFitProblem,
  utf8Length,
} from "../convex/lib/blueskyThread.ts";
import { DEFAULT_DISCLOSURE, SPANISH_DISCLOSURE } from "../convex/lib/linkedinPost.ts";

const STORY = [
  "The night our oven died, we had 300 wedding loaves still to bake.",
  "",
  "I called Eddie, my foreman, at two in the morning. He didn't ask a single question. He just said he'd be there in ten minutes, and he was, still in his slippers.",
  "",
  "We fired up the old brick oven in the back that nobody had used since 1971. It took an hour to get hot. We made every loaf by hand, two at a time, and the bride never knew.",
  "",
  "The lesson I took from it: keep the old tools working, because one day they save you. And keep the people who show up in slippers.",
  "",
  "What old tool has saved your day at work?",
].join("\n");

function assertThread(posts: string[]) {
  assert.ok(posts.length >= MIN_THREAD_POSTS && posts.length <= MAX_THREAD_POSTS, `${posts.length} posts`);
  for (const p of posts) {
    assert.ok(graphemeCount(p) <= 300, `post over 300: ${graphemeCount(p)}`);
    assert.equal(p, p.trim());
  }
}

/** Every word of the story is in the thread, in order (nothing cut or dropped). */
function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

test("split: hook alone in post 1, story in order, disclosure at the end of the last post", () => {
  const split = splitBlueskyThread(STORY, "en");
  assert.ok(split.ok);
  if (!split.ok) return;
  assertThread(split.posts);
  assert.equal(split.posts[0], "The night our oven died, we had 300 wedding loaves still to bake.");
  assert.equal(split.hook, split.posts[0]);
  assert.ok(split.posts.at(-1)!.endsWith(DEFAULT_DISCLOSURE));
  assert.equal(split.posts.filter((p) => p.includes(DEFAULT_DISCLOSURE)).length, 1);
  assert.deepEqual(words(split.posts.join(" ")), words(`${STORY} ${DEFAULT_DISCLOSURE}`));
  assert.deepEqual(split.langs, ["en"]);
  assert.ok(!split.body.includes(DEFAULT_DISCLOSURE));
});

test("split: paragraphs stay whole when they fit (a post never ends mid-paragraph needlessly)", () => {
  const split = splitBlueskyThread(STORY, "en");
  assert.ok(split.ok);
  if (!split.ok) return;
  for (const p of split.posts) {
    for (const para of p.split("\n\n")) assert.ok(STORY.includes(para) || para === DEFAULT_DISCLOSURE, para);
  }
});

test("split: Spanish gets the Spanish disclosure and langs es", () => {
  const es = [
    "La noche que se descompuso el horno teníamos 300 panes para una boda.",
    "",
    "Le llamé a Eddie, mi encargado, a las dos de la mañana. No preguntó nada. Llegó en diez minutos, todavía en pantuflas, y prendimos el horno de ladrillo que no se usaba desde 1971.",
    "",
    "Hicimos todos los panes a mano, de dos en dos, y la novia nunca se enteró.",
    "",
    "Lo que aprendí: hay que cuidar las herramientas viejas, porque un día te salvan.",
    "",
    "¿Qué herramienta vieja le ha salvado a usted el día en el trabajo?",
  ].join("\n");
  const split = splitBlueskyThread(es, "es");
  assert.ok(split.ok);
  if (!split.ok) return;
  assertThread(split.posts);
  assert.ok(split.posts.at(-1)!.endsWith(SPANISH_DISCLOSURE));
  assert.deepEqual(split.langs, ["es"]);
});

test("split: the writer's own AI line is replaced by ours (once)", () => {
  const split = splitBlueskyThread(`${STORY}\n\nWritten with the help of AI.`, "en");
  assert.ok(split.ok);
  if (!split.ok) return;
  assert.ok(!split.posts.join("\n").includes("Written with the help of AI"));
  assert.equal(split.posts.join("\n").split(DEFAULT_DISCLOSURE).length, 2);
});

test("split: 300-grapheme edges (exactly 300 fits, 301 moves on)", () => {
  const para = (n: number) => `${"a".repeat(n - 1)}.`;
  const hook = "Hook line.";
  // A paragraph of exactly 300 graphemes is one post on its own.
  const exact = splitBlueskyThread([hook, para(300), "Short end?"].join("\n\n"), "en");
  assert.ok(exact.ok);
  if (exact.ok) {
    assert.equal(graphemeCount(exact.posts[1]), 300);
    assertThread(exact.posts);
  }
  // A single 301-grapheme word can't be split without cutting it.
  const tooLong = splitBlueskyThread([hook, `${"a".repeat(301)}`, "End?"].join("\n\n"), "en");
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.match(tooLong.reason, /word is longer/);
});

test("split: a sentence over 300 is split between words, never inside one", () => {
  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" "); // ~550 chars, no period
  const split = splitBlueskyThread(["Hook line.", long, "End?"].join("\n\n"), "en");
  assert.ok(split.ok);
  if (!split.ok) return;
  assertThread(split.posts);
  assert.deepEqual(words(split.posts.join(" ")), words(`Hook line. ${long} End? ${DEFAULT_DISCLOSURE}`));
});

test("split: emoji and accents count as one grapheme each", () => {
  const emoji = "👍🏽".repeat(150); // 150 graphemes, 600 UTF-8 bytes
  const split = splitBlueskyThread(["Héllo, señor.", `${emoji} ¿Qué tal?`, "Más café, por favor. Él dijo que sí.", "¿Y usted?"].join("\n\n"), "es");
  assert.ok(split.ok);
  if (!split.ok) return;
  assertThread(split.posts);
  assert.ok(split.posts.some((p) => p.includes(emoji)));
  assert.equal(utf8Length("👍🏽"), 8);
  assert.equal(utf8Length("é"), 2);
});

test("split: hook too long for post 1 -> reason, nothing cut", () => {
  const hook = Array.from({ length: 70 }, () => "longword").join(" "); // one 629-char sentence
  const split = splitBlueskyThread([hook, "Story.", "End?"].join("\n\n"), "en");
  assert.equal(split.ok, false);
  if (!split.ok) assert.match(split.reason, /opening line is \d+ characters/);
});

test("split: a long first paragraph -> post 1 is its first sentence(s)", () => {
  const first = `This is the hook sentence. ${"More of the first paragraph goes here and keeps going. ".repeat(6).trim()}`;
  const split = splitBlueskyThread([first, "Middle part of the story.", "What would you do?"].join("\n\n"), "en");
  assert.ok(split.ok);
  if (!split.ok) return;
  assert.ok(split.posts[0].startsWith("This is the hook sentence."));
  assert.ok(graphemeCount(split.posts[0]) <= 300);
  assertThread(split.posts);
});

test("split: too long for 5 posts -> reason with the count", () => {
  const para = "This is a sentence about the bakery and the oven. ".repeat(5).trim();
  const long = ["Hook.", ...Array.from({ length: 7 }, () => para), "End?"].join("\n\n");
  const split = splitBlueskyThread(long, "en");
  assert.equal(split.ok, false);
  if (!split.ok) assert.match(split.reason, /needs \d+ posts; a thread holds at most 5/);
  assert.match(threadFitProblem(long, "en") ?? "", /at most 5/);
  assert.equal(threadFitProblem(STORY, "en"), null);
});

test("split: a short post is still split into 3 posts; too short -> reason", () => {
  const short = splitBlueskyThread("Hook.\n\nOne story sentence. Another one.\n\nWhat about you?", "en");
  assert.ok(short.ok);
  if (short.ok) assert.equal(short.posts.length, 3);
  const tiny = splitBlueskyThread("Hook.", "en", { minPosts: 3 });
  assert.equal(tiny.ok, false);
  assert.equal(splitBlueskyThread("   ", "en").ok, false);
});

test("hashtagFacets: byte offsets after accents and emoji", () => {
  const text = "Café 👍 #baking and #pan_dulce, not #1";
  const facets = hashtagFacets(text);
  assert.equal(facets.length, 2);
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  const slice = (f: (typeof facets)[number]) => new TextDecoder().decode(bytes.slice(f.index.byteStart, f.index.byteEnd));
  assert.equal(slice(facets[0]), "#baking");
  assert.equal(slice(facets[1]), "#pan_dulce");
  assert.equal(facets[0].features[0].tag, "baking");
});

test("recoverThreadRecords: finds the earlier run's posts in order, stops at a gap", () => {
  const texts = ["one", "two", "three"];
  const listed = [
    { uri: "at://me/app.bsky.feed.post/3", cid: "c3", text: "three", parentUri: "at://me/app.bsky.feed.post/2" },
    { uri: "at://me/app.bsky.feed.post/1", cid: "c1", text: "one" },
    { uri: "at://me/app.bsky.feed.post/x", cid: "cx", text: "two", parentUri: "at://other/post" },
  ];
  assert.deepEqual(recoverThreadRecords(listed, texts, []), [{ uri: "at://me/app.bsky.feed.post/1", cid: "c1" }]);
  const withTwo = [...listed, { uri: "at://me/app.bsky.feed.post/2", cid: "c2", text: "two", parentUri: "at://me/app.bsky.feed.post/1" }];
  assert.equal(recoverThreadRecords(withTwo, texts, []).length, 3);
  // A reply with the root's text isn't the root.
  assert.deepEqual(recoverThreadRecords([{ uri: "u", cid: "c", text: "one", parentUri: "p" }], texts, []), []);
});
