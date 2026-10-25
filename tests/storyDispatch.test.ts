// publish.ts's Threads and X branches (lib/storyPublishing publishThreadsStory / publishXStory)
// with fake APIs: the split, continuing the row's records, recovery, refusals. No network.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { FetchFn } from "../convex/lib/blueskyClient.ts";
import { disclosureFor } from "../convex/lib/linkedinPost.ts";
import { publishThreadsStory, publishXStory } from "../convex/lib/storyPublishing.ts";
import { reportThreadsLoginError } from "../convex/lib/threadsLogin.ts";
import { splitThreadsThread } from "../convex/lib/threadsPublishing.ts";
import { xStoryTexts } from "../convex/lib/xPublishing.ts";

const STORY = [
  "My first job was on a bridge crew in 1971, and I almost quit on day one.",
  "The foreman, a quiet man named Earl, handed me a bucket of rivets and said: count them. I counted. He said: count them again. Two hundred and twelve, both times. He nodded and walked off. ".repeat(3),
  "Forty years later I still count twice. Measure twice, cut once is not a saying; it's a habit.",
  "What habit did someone teach you early that you still keep?",
].join("\n\n");

const noSleep = async () => {};

type Call = { url: string; method: string; form: URLSearchParams; json?: any };

/** A working Threads API: containers c1.., posts p1.., FINISHED, permalinks; `listed` for recovery. */
function threadsApi(listed: { threads?: unknown[]; replies?: unknown[] } = {}) {
  const calls: Call[] = [];
  const n = { create: 0, publish: 0 };
  const fetchFn: FetchFn = async (url, init) => {
    const method = init?.method ?? "GET";
    const form = new URLSearchParams(method === "POST" ? init?.body ?? "" : new URL(url).search);
    calls.push({ url, method, form });
    const path = new URL(url).pathname;
    const reply = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
    if (method === "POST" && path === "/v1.0/me/threads") return reply({ id: `c${++n.create}` });
    if (method === "POST" && path === "/v1.0/me/threads_publish") return reply({ id: `p${++n.publish}` });
    if (method === "GET" && path === "/v1.0/me/threads") return reply({ data: listed.threads ?? [] });
    if (method === "GET" && path === "/v1.0/me/replies") return reply({ data: listed.replies ?? [] });
    if (form.get("fields") === "status,error_message") return reply({ status: "FINISHED" });
    if (form.get("fields") === "permalink") return reply({ permalink: `https://www.threads.com/@walter/post/${path.slice(6)}` });
    return reply({}, 404);
  };
  return { fetchFn, calls, creates: () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/me/threads")) };
}

const THREADS_LOGIN = { accessToken: "TOKEN-t", userId: "42" };

test("Threads: splits the story and posts every part as a chain; url = post 1", async () => {
  const api = threadsApi();
  const split = splitThreadsThread(STORY, "en");
  assert.ok(split.ok);
  const out = await publishThreadsStory(api.fetchFn, THREADS_LOGIN, { text: STORY, lang: "en", sleep: noSleep });
  assert.equal(out.status, "posted");
  assert.equal(out.status === "posted" && out.records?.length, split.posts.length);
  assert.equal(out.url, "https://www.threads.com/@walter/post/p1");
  assert.deepEqual(api.creates().map((c) => c.form.get("text")), split.posts);
  assert.ok(api.creates().at(-1)!.form.get("text")!.endsWith(disclosureFor("en")));
});

test("Threads: continues after the row's records (a retry never reposts the start)", async () => {
  const api = threadsApi();
  const split = splitThreadsThread(STORY, "en");
  assert.ok(split.ok && split.posts.length >= 2);
  const out = await publishThreadsStory(api.fetchFn, THREADS_LOGIN, { text: STORY, lang: "en", done: [{ uri: "old1", cid: "" }], sleep: noSleep });
  assert.equal(out.status, "posted");
  assert.equal(api.creates().length, split.posts.length - 1);
  assert.equal(api.creates()[0].form.get("reply_to_id"), "old1");
  assert.equal(out.status === "posted" && out.records?.[0].uri, "old1");
});

test("Threads: recover finds the earlier attempt's posts in his profile first", async () => {
  const split = splitThreadsThread(STORY, "en");
  assert.ok(split.ok);
  const api = threadsApi({ threads: [{ id: "r1", text: split.posts[0], is_reply: false }] });
  const out = await publishThreadsStory(api.fetchFn, THREADS_LOGIN, { text: STORY, lang: "en", recover: true, sleep: noSleep });
  assert.equal(out.status, "posted");
  assert.equal(api.creates().length, split.posts.length - 1, "post 1 was already there");
  assert.equal(out.status === "posted" && out.records?.[0].uri, "r1");
});

test("Threads: no login or a story that can't be split -> failed, nothing sent", async () => {
  const api = threadsApi();
  assert.deepEqual(await publishThreadsStory(api.fetchFn, null, { text: STORY }), { status: "failed", error: "His Threads account isn't connected." });
  const empty = await publishThreadsStory(api.fetchFn, THREADS_LOGIN, { text: "" });
  assert.equal(empty.status, "failed");
  assert.match(empty.status === "failed" ? empty.error : "", /Doesn't fit a Threads thread/);
  assert.equal(api.calls.length, 0);
});

/** Fake X: POST /tweets -> ids 100, 101, ... */
function xApi(fail?: (n: number) => number | undefined) {
  const calls: { url: string; body: any }[] = [];
  let next = 100;
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const status = fail?.(calls.length) ?? 201;
    const body = status === 201 ? { data: { id: String(next++) } } : { title: "Forbidden" };
    return { ok: status < 300, status, json: async () => body };
  };
  return { fetchFn, calls };
}

const X_LOGIN = { accessToken: "AT", userId: "42", username: "grandpa_joe" };

test("X: thread mode posts the split as a self-thread; url from the root", async () => {
  const api = xApi();
  const split = xStoryTexts(STORY, "en", "thread");
  assert.ok(split.ok);
  const out = await publishXStory(api.fetchFn, X_LOGIN, { text: STORY, lang: "en", mode: "thread" });
  assert.equal(out.status, "posted");
  assert.equal(out.url, "https://x.com/grandpa_joe/status/100");
  assert.deepEqual(api.calls.map((c) => c.body.text), split.posts);
  assert.equal(api.calls[1].body.reply.in_reply_to_tweet_id, "100");
});

test("X: single mode posts one post", async () => {
  const api = xApi();
  const out = await publishXStory(api.fetchFn, X_LOGIN, { text: STORY, lang: "en", mode: "single" });
  assert.equal(out.status, "posted");
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].body.reply, undefined);
});

test("X: continues after the row's records; a refused self-reply keeps what's out", async () => {
  const split = xStoryTexts(STORY, "en", "thread");
  assert.ok(split.ok && split.posts.length >= 2);
  const api = xApi();
  const out = await publishXStory(api.fetchFn, X_LOGIN, { text: STORY, lang: "en", mode: "thread", done: [{ uri: "7", cid: "" }] });
  assert.equal(out.status, "posted");
  assert.equal(api.calls.length, split.posts.length - 1);
  assert.equal(api.calls[0].body.reply.in_reply_to_tweet_id, "7");

  const refused = xApi((n) => (n === 2 ? 403 : undefined));
  const partial = await publishXStory(refused.fetchFn, X_LOGIN, { text: STORY, lang: "en", mode: "thread" });
  assert.equal(partial.status, "failed");
  assert.deepEqual(partial.status === "failed" && partial.records, [{ uri: "100", cid: "" }]);
});

test("X: no login -> failed, nothing sent", async () => {
  const api = xApi();
  assert.deepEqual(await publishXStory(api.fetchFn, null, { text: STORY, mode: "thread" }), { status: "failed", error: "His X account isn't connected." });
  assert.equal(api.calls.length, 0);
});

test("Threads: a refused token (Meta code 190) is reported so his account is marked invalid", async () => {
  const refusing: FetchFn = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { message: "Invalid OAuth access token", code: 190 } }),
  });
  const marked: unknown[] = [];
  const ctx = { runMutation: async (_ref: unknown, args: unknown) => void marked.push(args) };
  const out = await publishThreadsStory(refusing, THREADS_LOGIN, {
    text: STORY,
    lang: "en",
    sleep: noSleep,
    onLoginError: (e) => reportThreadsLoginError(ctx as never, "elder1", e),
  });
  assert.equal(out.status, "failed");
  assert.equal(marked.length, 1);
  assert.deepEqual(marked[0], { elderId: "elder1", platform: "threads", error: "Threads refused the token (HTTP 400)" });
  assert.ok(!JSON.stringify(marked).includes("TOKEN-t"), "never the token");
});

test("Threads: other failures (a 500, a bad parameter) don't touch his account", async () => {
  for (const [status, body] of [
    [500, {}],
    [400, { error: { code: 100 } }],
  ] as const) {
    const failing: FetchFn = async () => ({ ok: false, status, json: async () => body });
    let reported = 0;
    const out = await publishThreadsStory(failing, THREADS_LOGIN, { text: STORY, lang: "en", sleep: noSleep, onLoginError: () => void reported++ });
    assert.equal(out.status, "failed");
    assert.equal(reported, 0, String(status));
  }
});
