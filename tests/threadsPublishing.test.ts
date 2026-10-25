// Run: npm test
// Threads: the login getter (decrypt + refresh), the split, posting a chained thread (partial
// failure, timeouts), recovery, and deleting (undo). Fakes only.
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadAccountKey } from "../convex/lib/accountCrypto.ts";
import type { FetchFn } from "../convex/lib/blueskyClient.ts";
import { disclosureFor } from "../convex/lib/linkedinPost.ts";
import { openTokens, sealTokens } from "../convex/lib/oauthFlow.ts";
import { threadsLoginForElder, type ThreadsLoginCtx } from "../convex/lib/threadsLogin.ts";
import {
  THREADS_MAX_CHARS,
  deleteThreadsPosts,
  matchThreadsRecords,
  parseListedPosts,
  postThreadsStory,
  splitThreadsThread,
  threadsTextLength,
} from "../convex/lib/threadsPublishing.ts";
import { NOW } from "./helpers.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
const DAY = 86_400_000;
const LOGIN = { accessToken: "TOKEN-zzz", userId: "42" };
const noSleep = async () => {};

type Reply = { status?: number; body: unknown } | "throw";
function fake(route: (url: string, method: string, form: URLSearchParams) => Reply) {
  const calls: { url: string; method: string; form: URLSearchParams }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const method = init?.method ?? "GET";
    const form = new URLSearchParams(method === "POST" ? init?.body ?? "" : new URL(url).search);
    calls.push({ url, method, form });
    const r = route(url, method, form);
    if (r === "throw") throw new TypeError("network");
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.body };
  };
  return { fetchFn, calls };
}

/** A working Threads: containers c1.., posts p1.., status FINISHED, permalinks. */
function threadsApi(over: (n: { create: number; publish: number }, url: string, method: string, form: URLSearchParams) => Reply | undefined = () => undefined) {
  const n = { create: 0, publish: 0 };
  return fake((url, method, form) => {
    const custom = over(n, url, method, form);
    if (custom) return custom;
    const path = new URL(url).pathname;
    if (method === "POST" && path === "/v1.0/me/threads") return { body: { id: `c${++n.create}` } };
    if (method === "POST" && path === "/v1.0/me/threads_publish") return { body: { id: `p${++n.publish}` } };
    if (method === "GET" && form.get("fields") === "status,error_message") return { body: { status: "FINISHED", id: path.slice(6) } };
    if (method === "GET" && form.get("fields") === "permalink") return { body: { permalink: `https://www.threads.com/@walter/post/${path.slice(6)}` } };
    return { status: 404, body: {} };
  });
}

const STORY = [
  "My first job was on a bridge crew in 1971, and I almost quit on day one.",
  "The foreman, a quiet man named Earl, handed me a bucket of rivets and said: count them. I counted. He said: count them again. Two hundred and twelve, both times. He nodded and walked off. I thought it was a joke at my expense. It wasn't. Every rivet on that bridge was counted twice, by two people, before it went up. ".repeat(2),
  "Forty years later I still count twice. Measure twice, cut once is not a saying; it's a habit you build when nobody is watching.",
  "What habit did someone teach you early that you still keep?",
].join("\n\n");

// ---------- split ----------

test("split: 500-character posts, hook first, disclosure at the end of the last post", () => {
  const split = splitThreadsThread(STORY, "en");
  assert.ok(split.ok, !split.ok ? split.reason : "");
  assert.ok(split.posts.length >= 2 && split.posts.length <= 5);
  for (const p of split.posts) assert.ok(threadsTextLength(p) <= THREADS_MAX_CHARS, `${threadsTextLength(p)} chars`);
  assert.ok(split.posts[0].startsWith("My first job was on a bridge crew"));
  assert.ok(split.posts.at(-1)!.endsWith(disclosureFor("en")));
  assert.equal(split.posts.filter((p) => p.includes(disclosureFor("en"))).length, 1);
  assert.ok(splitThreadsThread(STORY, "es").ok && splitThreadsThread(STORY, "es").posts.at(-1)!.endsWith(disclosureFor("es")));
});

test("split: uses more of each post than Bluesky (fewer posts)", () => {
  const split = splitThreadsThread(STORY, "en");
  assert.ok(split.ok && split.posts.some((p) => p.length > 300));
});

test("split: emoji count as UTF-8 bytes, so emoji-heavy text gets smaller posts", () => {
  assert.equal(threadsTextLength("abc"), 3);
  assert.equal(threadsTextLength("año"), 3);
  assert.equal(threadsTextLength("👍"), 4);
  const emoji = `Hook line here.\n\n${"Bridges 🌉 and rivets 🔩 every day. ".repeat(30)}`;
  const split = splitThreadsThread(emoji, "en");
  assert.ok(split.ok, !split.ok ? split.reason : "");
  for (const p of split.posts) assert.ok(threadsTextLength(p) <= THREADS_MAX_CHARS);
});

test("split: empty text fails with a reason", () => {
  const split = splitThreadsThread("", "en");
  assert.equal(split.ok, false);
});

// ---------- posting ----------

test("post: each post replies to the previous one; url = post 1's permalink", async () => {
  const api = threadsApi();
  const out = await postThreadsStory(api.fetchFn, LOGIN, { texts: ["one", "two", "three"], sleep: noSleep });
  assert.deepEqual(out, {
    status: "posted",
    records: [{ uri: "p1", cid: "" }, { uri: "p2", cid: "" }, { uri: "p3", cid: "" }],
    url: "https://www.threads.com/@walter/post/p1",
  });
  const creates = api.calls.filter((c) => c.method === "POST" && c.url.endsWith("/me/threads"));
  assert.deepEqual(creates.map((c) => [c.form.get("text"), c.form.get("reply_to_id"), c.form.get("media_type")]), [
    ["one", null, "TEXT"],
    ["two", "p1", "TEXT"],
    ["three", "p2", "TEXT"],
  ]);
  const publishes = api.calls.filter((c) => c.url.endsWith("/me/threads_publish"));
  assert.deepEqual(publishes.map((c) => c.form.get("creation_id")), ["c1", "c2", "c3"]);
  // token only in the body / query, never in an error
  assert.ok(creates.every((c) => c.form.get("access_token") === "TOKEN-zzz" && !c.url.includes("TOKEN")));
});

test("post: waits while the container is IN_PROGRESS, then publishes", async () => {
  let polls = 0;
  const slept: number[] = [];
  const api = threadsApi((_n, _url, method, form) =>
    method === "GET" && form.get("fields") === "status,error_message" ? { body: { status: ++polls < 3 ? "IN_PROGRESS" : "FINISHED" } } : undefined,
  );
  const out = await postThreadsStory(api.fetchFn, LOGIN, { texts: ["one"], sleep: async (ms) => void slept.push(ms), pollMs: 1000 });
  assert.equal(out.status, "posted");
  assert.deepEqual(slept, [1000, 1000]);
});

test("post: container ERROR -> failed, nothing published", async () => {
  const api = threadsApi((_n, _url, method, form) =>
    method === "GET" && form.get("fields") === "status,error_message" ? { body: { status: "ERROR", error_message: "UNKNOWN" } } : undefined,
  );
  const out = await postThreadsStory(api.fetchFn, LOGIN, { texts: ["one"], sleep: noSleep });
  assert.equal(out.status, "failed");
  assert.equal(api.calls.filter((c) => c.url.endsWith("/threads_publish")).length, 0);
});

test("post: partial failure keeps the records so far (and post 1's link); a retry continues", async () => {
  const api = threadsApi((n, url, method) => (method === "POST" && url.endsWith("/me/threads") && n.create === 2 ? { status: 400, body: { error: { code: 100 } } } : undefined));
  const out = await postThreadsStory(api.fetchFn, LOGIN, { texts: ["one", "two", "three", "four"], sleep: noSleep });
  assert.equal(out.status, "failed");
  assert.ok(out.status === "failed" && /Posted 2 of 4/.test(out.error));
  assert.deepEqual(out.records, [{ uri: "p1", cid: "" }, { uri: "p2", cid: "" }]);
  assert.equal(out.url, "https://www.threads.com/@walter/post/p1");

  const retry = threadsApi();
  const again = await postThreadsStory(retry.fetchFn, LOGIN, { texts: ["one", "two", "three", "four"], done: out.records, sleep: noSleep });
  assert.equal(again.status, "posted");
  assert.deepEqual(again.records?.map((r) => r.uri), ["p1", "p2", "p1", "p2"]); // the fake numbers each run from p1
  const firstCreate = retry.calls.find((c) => c.method === "POST" && c.url.endsWith("/me/threads"))!;
  assert.equal(firstCreate.form.get("text"), "three");
  assert.equal(firstCreate.form.get("reply_to_id"), "p2");
});

test("post: publish timeout or 5xx -> maybe_posted; 4xx -> failed", async () => {
  const timeout = threadsApi((_n, url) => (url.endsWith("/threads_publish") ? "throw" : undefined));
  const a = await postThreadsStory(timeout.fetchFn, LOGIN, { texts: ["one", "two"], sleep: noSleep });
  assert.equal(a.status, "maybe_posted");
  assert.ok(a.status === "maybe_posted" && /check his Threads profile/.test(a.error));

  const busy = threadsApi((n, url) => (url.endsWith("/threads_publish") && n.publish >= 1 ? { status: 503, body: {} } : undefined));
  const b = await postThreadsStory(busy.fetchFn, LOGIN, { texts: ["one", "two"], sleep: noSleep });
  assert.equal(b.status, "maybe_posted");
  assert.deepEqual(b.records, [{ uri: "p1", cid: "" }]);

  const refused = threadsApi((_n, url) => (url.endsWith("/threads_publish") ? { status: 400, body: { error: { code: 24, message: "TOKEN-zzz" } } } : undefined));
  const c = await postThreadsStory(refused.fetchFn, LOGIN, { texts: ["one"], sleep: noSleep });
  assert.equal(c.status, "failed");
  assert.ok(c.status === "failed" && !c.error.includes("TOKEN-zzz"));
});

test("post: create timeout -> failed (nothing was published)", async () => {
  const api = threadsApi((_n, url, method) => (method === "POST" && url.endsWith("/me/threads") ? "throw" : undefined));
  const out = await postThreadsStory(api.fetchFn, LOGIN, { texts: ["one"], sleep: noSleep });
  assert.equal(out.status, "failed");
});

test("post: no login -> failed", async () => {
  const out = await postThreadsStory(threadsApi().fetchFn, null, { texts: ["one"] });
  assert.deepEqual(out, { status: "failed", error: "His Threads account isn't connected." });
});

// ---------- recovery ----------

test("recover: finds what an earlier attempt posted, then continues", async () => {
  const listed = [
    { id: "r1", text: "one", is_reply: false },
    { id: "x9", text: "two", is_reply: true, replied_to: { id: "someone-else" } },
    { id: "r2", text: "two ", is_reply: true, replied_to: { id: "r1" } },
  ];
  const api = threadsApi((_n, url, method) => {
    const path = new URL(url).pathname;
    if (method === "GET" && path === "/v1.0/me/threads") return { body: { data: listed.filter((p) => !p.is_reply) } };
    if (method === "GET" && path === "/v1.0/me/replies") return { body: { data: listed.filter((p) => p.is_reply) } };
    return undefined;
  });
  const out = await postThreadsStory(api.fetchFn, LOGIN, { texts: ["one", "two", "three"], recover: true, sleep: noSleep });
  assert.equal(out.status, "posted");
  assert.deepEqual(out.records?.map((r) => r.uri), ["r1", "r2", "p1"]);
});

test("recover: can't list his posts -> stays maybe_posted", async () => {
  const api = threadsApi((_n, url, method) => (method === "GET" && /\/me\/(threads|replies)/.test(url) ? { status: 500, body: {} } : undefined));
  const out = await postThreadsStory(api.fetchFn, LOGIN, { texts: ["one", "two"], recover: true, sleep: noSleep });
  assert.equal(out.status, "maybe_posted");
});

test("matchThreadsRecords stops at the first gap", () => {
  const listed = parseListedPosts([{ id: "a", text: "one" }, { id: "c", text: "three", replied_to: { id: "b" } }]);
  assert.deepEqual(matchThreadsRecords(listed, ["one", "two", "three"], []), [{ uri: "a", cid: "" }]);
});

// ---------- delete ----------

test("delete: replies first, root last; already gone counts as deleted", async () => {
  const api = fake((url) => (url.includes("/p2?") ? { status: 400, body: { error: { code: 100, error_subcode: 33 } } } : { body: { success: true, deleted_id: "x" } }));
  const out = await deleteThreadsPosts(api.fetchFn, LOGIN, ["p1", "p2", "p3", "p3"]);
  assert.deepEqual(out, { ok: true, deleted: 2, alreadyGone: 1 });
  assert.deepEqual(api.calls.map((c) => [c.method, new URL(c.url).pathname]), [
    ["DELETE", "/v1.0/p3"],
    ["DELETE", "/v1.0/p2"],
    ["DELETE", "/v1.0/p1"],
  ]);
});

test("delete: a refusal stops with a short error; no login -> error", async () => {
  const api = fake(() => ({ status: 403, body: { error: { code: 10 } } }));
  const out = await deleteThreadsPosts(api.fetchFn, LOGIN, ["p1"]);
  assert.equal(out.ok, false);
  assert.ok(!out.ok && /HTTP 403/.test(out.error) && !out.error.includes("TOKEN"));
  assert.equal((await deleteThreadsPosts(api.fetchFn, null, ["p1"])).ok, false);
});

// ---------- login getter ----------

async function loginCtx(row: Record<string, unknown> | null) {
  const mutations: { name: string; args: any }[] = [];
  const ctx: ThreadsLoginCtx = {
    runQuery: async () => row,
    runMutation: async (ref: any, args: any) => {
      mutations.push({ name: String(ref?._name ?? ref), args });
      return true;
    },
  };
  return { ctx, mutations };
}

async function sealedRow(tokens: { issuedAt: number; expiresAt: number }) {
  const key = await loadAccountKey(KEY);
  const secret = await sealTokens(key, { accessToken: "OLD-TOKEN", userId: "42", ...tokens }, "elder1", "threads");
  return { status: "connected", handle: "walter", externalUserId: "42", secret, tokenExpiresAt: tokens.expiresAt };
}

const ENV = { ACCOUNTS_ENC_KEY: KEY, THREADS_APP_ID: "app", THREADS_APP_SECRET: "secret" };

test("login: decrypts his token; no refresh while far from expiry", async () => {
  const { ctx, mutations } = await loginCtx(await sealedRow({ issuedAt: NOW - 10 * DAY, expiresAt: NOW + 50 * DAY }));
  const api = fake(() => "throw");
  const login = await threadsLoginForElder(ctx, "elder1", { env: ENV, fetchFn: api.fetchFn, now: () => NOW });
  assert.deepEqual(login, { accessToken: "OLD-TOKEN", userId: "42", username: "walter" });
  assert.equal(api.calls.length, 0);
  assert.equal(mutations.length, 0);
});

test("login: refreshes under 7 days left and saves the new token (encrypted), only over the old one", async () => {
  const row = await sealedRow({ issuedAt: NOW - 55 * DAY, expiresAt: NOW + 5 * DAY });
  const { ctx, mutations } = await loginCtx(row);
  const api = fake(() => ({ body: { access_token: "NEW-TOKEN", expires_in: 5184000 } }));
  const login = await threadsLoginForElder(ctx, "elder1", { env: ENV, fetchFn: api.fetchFn, now: () => NOW });
  assert.equal(login?.accessToken, "NEW-TOKEN");
  assert.equal(mutations.length, 1);
  const saved = mutations[0].args;
  assert.equal(saved.tokenExpiresAt, NOW + 5184000 * 1000);
  assert.equal(saved.expectedIv, row.secret.iv, "compare-and-swap on the token it refreshed from");
  assert.ok(!JSON.stringify(saved).includes("NEW-TOKEN"));
  const back = await openTokens(await loadAccountKey(KEY), saved.secret, "elder1", "threads", {});
  assert.equal(back.accessToken, "NEW-TOKEN");
});

test("login: a failed refresh keeps the current token", async () => {
  const warnings: string[] = [];
  const { ctx, mutations } = await loginCtx(await sealedRow({ issuedAt: NOW - 55 * DAY, expiresAt: NOW + 5 * DAY }));
  const api = fake(() => ({ status: 400, body: { error: { code: 190 } } }));
  const login = await threadsLoginForElder(ctx, "elder1", { env: ENV, fetchFn: api.fetchFn, now: () => NOW, warn: (m) => warnings.push(m) });
  assert.equal(login?.accessToken, "OLD-TOKEN");
  assert.equal(mutations.length, 0);
  assert.ok(warnings.every((w) => !w.includes("OLD-TOKEN")));
});

test("login: missing key, no row, expired token -> null (never throws)", async () => {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  const row = await sealedRow({ issuedAt: NOW - 10 * DAY, expiresAt: NOW + 50 * DAY });
  assert.equal(await threadsLoginForElder((await loginCtx(row)).ctx, "elder1", { env: {}, now: () => NOW, warn }), null);
  assert.ok(warnings.some((w) => w.includes("ACCOUNTS_ENC_KEY")));
  assert.equal(await threadsLoginForElder((await loginCtx(null)).ctx, "elder1", { env: ENV, warn }), null);
  assert.equal(await threadsLoginForElder((await loginCtx({ ...row, status: "invalid" })).ctx, "elder1", { env: ENV, warn }), null);
  // another elder's ciphertext doesn't decrypt
  assert.equal(await threadsLoginForElder((await loginCtx(row)).ctx, "elder2", { env: ENV, now: () => NOW, warn }), null);
  const expired = await loginCtx(await sealedRow({ issuedAt: NOW - 61 * DAY, expiresAt: NOW - 1 }));
  assert.equal(await threadsLoginForElder(expired.ctx, "elder1", { env: ENV, now: () => NOW, warn }), null);
  assert.equal(expired.mutations.length, 1); // marked invalid
});
