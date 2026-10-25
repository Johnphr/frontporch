// X story posting (lib/xPublishing.ts) with a fake X: self-thread chaining, a refused
// self-reply (partial), single-post mode, timeouts, retries that continue, delete, gates.
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_DISCLOSURE } from "../convex/lib/linkedinPost.ts";
import { deleteXPosts, isReplyRestricted, postXStory, xMode, xPostUrl, xPostingOn, xStoryTexts } from "../convex/lib/xPublishing.ts";
import type { FetchFn } from "../convex/lib/xOAuth.ts";
import { weightedLength } from "../convex/lib/xText.ts";

const login = { accessToken: "AT", userId: "42", username: "grandpa_joe" };

type Reply = { status: number; body?: unknown } | "throw";
function fakeX(replies: Reply[]) {
  const calls: { url: string; method?: string; body?: any; auth?: string }[] = [];
  let next = 100;
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, method: init?.method, auth: init?.headers?.Authorization, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    const r = replies.shift() ?? { status: 201 };
    if (r === "throw") throw new Error("aborted");
    const body = r.body ?? (r.status === 201 ? { data: { id: String(next++), text: "..." } } : {});
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => body };
  };
  return { fetchFn, calls };
}

test("gates: X_POSTING off by default, X_THREAD=off means one post", () => {
  assert.equal(xPostingOn({}), false);
  assert.equal(xPostingOn({ X_POSTING: "on" }), true);
  assert.equal(xMode({}), "thread");
  assert.equal(xMode({ X_THREAD: "on" }), "thread");
  assert.equal(xMode({ X_THREAD: "off" }), "single");
});

test("thread: root then self-replies chained by id; url from the root", async () => {
  const { fetchFn, calls } = fakeX([]);
  const out = await postXStory(fetchFn, login, { texts: ["one", "two", "three"] });
  assert.deepEqual(out, {
    status: "posted",
    records: [{ uri: "100", cid: "" }, { uri: "101", cid: "" }, { uri: "102", cid: "" }],
    externalId: "100",
    url: "https://x.com/grandpa_joe/status/100",
  });
  assert.equal(calls[0].url, "https://api.x.com/2/tweets");
  assert.equal(calls[0].auth, "Bearer AT");
  assert.deepEqual(calls[0].body, { text: "one" });
  assert.deepEqual(calls[1].body, { text: "two", reply: { in_reply_to_tweet_id: "100" } });
  assert.deepEqual(calls[2].body, { text: "three", reply: { in_reply_to_tweet_id: "101" } });
  for (const c of calls) assert.ok(!JSON.stringify(c.body).includes("@"), "never mentions anyone");
});

test("self-reply refused (403 reply restriction): stop, keep the root, say so", async () => {
  const { fetchFn, calls } = fakeX([
    { status: 201 },
    { status: 403, body: { title: "Forbidden", detail: "Reply to this conversation is not allowed because you have not been mentioned or otherwise engaged by the author of the post you are replying to.", type: "about:blank", status: 403 } },
  ]);
  const out = await postXStory(fetchFn, login, { texts: ["one", "two", "three"] });
  assert.equal(out.status, "failed");
  assert.equal(calls.length, 2, "stops at the refused reply");
  if (out.status !== "failed") return;
  assert.deepEqual(out.records, [{ uri: "100", cid: "" }]);
  assert.equal(out.url, "https://x.com/grandpa_joe/status/100");
  assert.match(out.error, /refused the self-reply/);
  assert.match(out.error, /Posted 1 of 3/);
  assert.match(out.error, /X_THREAD=off/);
  assert.ok(!out.error.includes("mentioned or otherwise"), "X's free text isn't copied");
});

test("reply restriction detection: only 403s that talk about replies", () => {
  assert.ok(isReplyRestricted(403, { detail: "You attempted to reply to a post that is not available." }));
  assert.ok(isReplyRestricted(403, { errors: [{ code: 433 }] }));
  assert.ok(!isReplyRestricted(403, { detail: "You are not permitted to perform this action." }));
  assert.ok(!isReplyRestricted(429, { detail: "reply" }));
});

test("a timeout -> maybe_posted with what's known; a retry continues after `done`", async () => {
  const first = fakeX([{ status: 201 }, "throw"]);
  const out = await postXStory(first.fetchFn, login, { texts: ["one", "two", "three"] });
  assert.equal(out.status, "maybe_posted");
  if (out.status !== "maybe_posted") return;
  assert.deepEqual(out.records, [{ uri: "100", cid: "" }]);

  const retry = fakeX([]);
  const done = await postXStory(retry.fetchFn, login, { texts: ["one", "two", "three"], done: out.records });
  assert.equal(done.status, "posted");
  assert.equal(retry.calls.length, 2);
  assert.deepEqual(retry.calls[0].body, { text: "two", reply: { in_reply_to_tweet_id: "100" } });
});

test("errors: 5xx maybe_posted, 429 failed, 401 asks to reconnect, missing id maybe_posted, no login", async () => {
  assert.equal((await postXStory(fakeX([{ status: 503 }]).fetchFn, login, { texts: ["a"] })).status, "maybe_posted");
  const limited = await postXStory(fakeX([{ status: 429, body: { title: "Too Many Requests" } }]).fetchFn, login, { texts: ["a"] });
  assert.deepEqual(limited, { status: "failed", error: "X HTTP 429 (Too Many Requests)." });
  const unauth = await postXStory(fakeX([{ status: 401 }]).fetchFn, login, { texts: ["a"] });
  assert.match(unauth.status === "failed" ? unauth.error : "", /connect X again/);
  assert.equal((await postXStory(fakeX([{ status: 201, body: { data: {} } }]).fetchFn, login, { texts: ["a"] })).status, "maybe_posted");
  const dup = await postXStory(fakeX([{ status: 403, body: { detail: "You are not allowed to create a Tweet with duplicate content." } }]).fetchFn, login, { texts: ["a"] });
  assert.equal(dup.status, "maybe_posted");
  assert.deepEqual(await postXStory(fakeX([]).fetchFn, null, { texts: ["a"] }), { status: "failed", error: "His X account isn't connected." });
});

const STORY = [
  "In 1974 I told the plant manager the line was unsafe.",
  "He didn't want to hear it. I spent three weeks measuring the gap between the press and the guard, and writing down every near miss the night shift told me about.",
  "When I put the numbers on his desk, he shut the line down for a weekend and we rebuilt the guards ourselves.",
  "Bring the numbers, and bring the people who live with the problem. Have you ever had to stop the line?",
].join("\n\n");

test("single-post mode: one post, no reply field, AI note included", async () => {
  const split = xStoryTexts(STORY, "en", xMode({ X_THREAD: "off" }));
  assert.ok(split.ok);
  if (!split.ok) return;
  assert.equal(split.posts.length, 1);
  assert.ok(split.posts[0].includes(DEFAULT_DISCLOSURE));
  assert.ok(weightedLength(split.posts[0]) <= 280);
  const { fetchFn, calls } = fakeX([]);
  const out = await postXStory(fetchFn, login, { texts: split.posts });
  assert.equal(out.status, "posted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.reply, undefined);
});

test("thread mode texts: AI note only in the last post", () => {
  const split = xStoryTexts(STORY, "en", "thread");
  assert.ok(split.ok);
  if (!split.ok) return;
  assert.ok(split.posts.length >= 2);
  assert.ok(split.posts.at(-1)!.endsWith(DEFAULT_DISCLOSURE));
  assert.ok(!split.posts.slice(0, -1).some((p) => p.includes(DEFAULT_DISCLOSURE)));
});

test("xPostUrl only for a real username + numeric id", () => {
  assert.equal(xPostUrl("joe_1", "123"), "https://x.com/joe_1/status/123");
  assert.equal(xPostUrl("bad/name", "123"), undefined);
  assert.equal(xPostUrl("joe", "abc"), undefined);
});

test("delete: replies first, root last; 404 counts as gone; stops on an error", async () => {
  const ok = fakeX([{ status: 200, body: { data: { deleted: true } } }, { status: 404 }, { status: 200, body: { data: { deleted: true } } }]);
  assert.deepEqual(await deleteXPosts(ok.fetchFn, login, ["100", "101", "102"]), { ok: true, deleted: 2, alreadyGone: 1 });
  assert.deepEqual(ok.calls.map((c) => [c.method, c.url]), [
    ["DELETE", "https://api.x.com/2/tweets/102"],
    ["DELETE", "https://api.x.com/2/tweets/101"],
    ["DELETE", "https://api.x.com/2/tweets/100"],
  ]);
  const bad = fakeX([{ status: 403, body: { title: "Forbidden" } }]);
  assert.deepEqual(await deleteXPosts(bad.fetchFn, login, ["100", "101"]), { ok: false, error: "X delete HTTP 403 (Forbidden) (0 of 2 done)." });
  assert.equal(bad.calls.length, 1);
  assert.deepEqual(await deleteXPosts(fakeX([]).fetchFn, login, ["at://not-x"]), { ok: false, error: "Not an X post id." });
  assert.equal((await deleteXPosts(fakeX([]).fetchFn, null, ["1"])).ok, false);
});
