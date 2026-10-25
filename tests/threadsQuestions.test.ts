// Run: npm test
// Threads keyword search (gated, needs app review) + quote-post answers. Fakes only.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { FetchFn } from "../convex/lib/blueskyClient.ts";
import { REPLY_DISCLOSURE } from "../convex/lib/threadReplies.ts";
import { THREADS_MAX_CHARS, threadsTextLength } from "../convex/lib/threadsPublishing.ts";
import {
  keywordSearchParams,
  parseKeywordSearch,
  postThreadsQuote,
  quoteAnswerText,
  searchThreadsQuestions,
  threadsKeywordSearchOn,
} from "../convex/lib/threadsQuestions.ts";
import { NOW } from "./helpers.ts";

const LOGIN = { accessToken: "TOKEN-q", userId: "42", username: "walter" };
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "+0000");

test("gate: off unless THREADS_KEYWORD_SEARCH=on", () => {
  assert.equal(threadsKeywordSearchOn({}), false);
  assert.equal(threadsKeywordSearchOn({ THREADS_KEYWORD_SEARCH: "off" }), false);
  assert.equal(threadsKeywordSearchOn({ THREADS_KEYWORD_SEARCH: "on" }), true);
});

test("search params: recent text posts, last 14 days", () => {
  const p = keywordSearchParams("bridge building", NOW);
  assert.equal(p.q, "bridge building");
  assert.equal(p.search_type, "RECENT");
  assert.equal(p.media_type, "TEXT");
  assert.equal(Number(p.since), Math.floor((NOW - 14 * 86_400_000) / 1000));
});

test("parse: keeps strangers' questions; drops replies, quotes, his own, non-questions", () => {
  const json = {
    data: [
      { id: "q1", text: "How do you learn to read structural drawings as a new engineer?", permalink: "https://www.threads.com/@ana/post/A", timestamp: iso(NOW - 86_400_000), username: "ana", has_replies: false },
      { id: "q2", text: "Any advice for a first job on a bridge crew?", permalink: "https://www.threads.com/@ben/post/B", is_reply: true, username: "ben" },
      { id: "q3", text: "What do you think about steel prices?", permalink: "https://www.threads.com/@c/post/C", is_quote_post: true, username: "c" },
      { id: "q4", text: "How did I get my first welding job? Here's the story", permalink: "https://www.threads.com/@walter/post/D", username: "Walter" },
      { id: "q5", text: "Just poured the foundation today, feeling good", permalink: "https://www.threads.com/@d/post/E", username: "d" },
      { id: "q6", text: "How do engineers check rivets?", permalink: "", username: "e" },
      { id: "q7", text: "How did you handle your first big mistake at work?", permalink: "https://www.threads.com/@f/post/F", timestamp: iso(NOW - 30 * 86_400_000), username: "f" },
    ],
  };
  const qs = parseKeywordSearch(json, ["engineer"], NOW, "walter");
  assert.deepEqual(qs.map((q) => q.threadsId), ["q1"]);
  assert.equal(qs[0].source, "threads");
  assert.equal(qs[0].url, "https://www.threads.com/@ana/post/A");
  assert.equal(qs[0].answerCount, 0);
  assert.ok(qs[0].priority > 0 && qs[0].fingerprint);
});

test("search: one failed keyword doesn't stop the rest; token never in errors", async () => {
  const fetchFn: FetchFn = async (url) => {
    const q = new URL(url).searchParams.get("q");
    if (q === "bad") return { ok: false, status: 500, json: async () => ({ error: { message: "TOKEN-q" } }) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "q1", text: "How do you learn to read structural drawings?", permalink: "https://www.threads.com/@a/post/A", username: "a" }] }),
    };
  };
  const out = await searchThreadsQuestions(fetchFn, LOGIN, ["bad", "drawings", "drawings again"], NOW);
  assert.equal(out.questions.length, 1); // deduped by fingerprint
  assert.equal(out.errors.length, 1);
  assert.ok(!out.errors[0].includes("TOKEN-q"));
});

test("quote text: disclosure once at the end, within 500", () => {
  const long = `${"I learned this the hard way on a job site in 1974. ".repeat(20)}\n\nWritten up with AI from a phone interview with me.`;
  for (const lang of ["en", "es"] as const) {
    const text = quoteAnswerText(long, lang);
    assert.ok(threadsTextLength(text) <= THREADS_MAX_CHARS);
    assert.ok(text.endsWith(REPLY_DISCLOSURE[lang]));
    assert.equal(text.split(REPLY_DISCLOSURE.en).length - 1, lang === "en" ? 1 : 0);
  }
});

test("quote post: quote_post_id on the container, then publish; permalink back", async () => {
  const calls: { url: string; method: string; form: URLSearchParams }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const method = init?.method ?? "GET";
    const form = new URLSearchParams(method === "POST" ? init?.body : new URL(url).search);
    calls.push({ url, method, form });
    const path = new URL(url).pathname;
    const body =
      path === "/v1.0/me/threads" ? { id: "c1" } : path === "/v1.0/me/threads_publish" ? { id: "m1" } : form.get("fields") === "permalink" ? { permalink: "https://www.threads.com/@walter/post/M" } : { status: "FINISHED" };
    return { ok: true, status: 200, json: async () => body };
  };
  const out = await postThreadsQuote(fetchFn, LOGIN, { quotePostId: "q1", text: "My answer", sleep: async () => {} });
  assert.deepEqual(out, { status: "posted", id: "m1", url: "https://www.threads.com/@walter/post/M" });
  const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/me/threads"))!;
  assert.equal(create.form.get("quote_post_id"), "q1");
  assert.equal(create.form.get("reply_to_id"), null);
  assert.equal((await postThreadsQuote(fetchFn, null, { quotePostId: "q1", text: "x" })).status, "failed");
});
