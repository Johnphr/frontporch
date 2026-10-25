// Run: node --test tests/   (Node 22.18+ / 24 strips TypeScript types natively)
// Thread-reply posting with a fake fetch: no network, no real accounts.
import { test } from "node:test";
import assert from "node:assert/strict";

import { blueskySearchPlan } from "../convex/lib/bluesky.ts";
import {
  BlueskyHttpError,
  SESSION_REUSE_MS,
  getSession,
  ownReplyIn,
  withSession,
  type FetchFn,
  type SessionCache,
} from "../convex/lib/blueskyClient.ts";
import { blueskyLoginForElder, redditLoginForElder } from "../convex/lib/logins.ts";
import { postBlueskyReply, postRedditReply, runPostReply, type PostOutcome, type ReplyForPosting } from "../convex/lib/replyPosting.ts";
import { draftCutoff, guardContextForReply, writeFailureStatus } from "../convex/lib/threadReplies.ts";
import { renderRepliesSection } from "../convex/lib/postsPage.ts";

const QUESTION_URI = "at://did:plc:asker/app.bsky.feed.post/q1";
const LOGIN = { service: "https://bsky.social", identifier: "walter.bsky.social", password: "app-pass" };
const REDDIT = { clientId: "cid", clientSecret: "csecret", username: "walter", password: "rpass", userAgent: "web:test:v1" };
const THREAD_URL = "https://www.reddit.com/r/Baking/comments/1abcde/how_to_price/";

type Route = { match: string; respond: () => { status: number; json?: unknown } | "throw" };

/** Fake fetch: first route whose `match` is in the url answers; every call is recorded. */
function fakeFetch(routes: Route[]) {
  const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, ...init });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`unexpected request ${url}`);
    const out = route.respond();
    if (out === "throw") throw new Error("The operation was aborted");
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.json ?? {} };
  };
  return { fetchFn, calls, count: (m: string) => calls.filter((c) => c.url.includes(m)).length };
}

const ok = (json: unknown) => () => ({ status: 200, json });
const SESSION = ok({ accessJwt: "acc1", refreshJwt: "ref1", did: "did:plc:him", handle: "walter.bsky.social" });
const QUESTION = ok({ posts: [{ uri: QUESTION_URI, cid: "bafyq", author: { did: "did:plc:asker" }, record: { text: "How?" } }] });
const NO_REPLIES = ok({ thread: { post: { uri: QUESTION_URI }, replies: [{ post: { uri: "at://did:plc:other/app.bsky.feed.post/x", author: { did: "did:plc:other" } } }] } });
const CREATED = ok({ uri: "at://did:plc:him/app.bsky.feed.post/r1", cid: "bafyr" });

const blueskyRoutes = (create: Route["respond"], thread: Route["respond"] = NO_REPLIES): Route[] => [
  { match: "createSession", respond: SESSION },
  { match: "getPostThread", respond: thread },
  { match: "getPosts", respond: QUESTION },
  { match: "createRecord", respond: create },
];

const post = (fetchFn: FetchFn, cache: SessionCache = new Map()) =>
  postBlueskyReply(fetchFn, cache, LOGIN, { threadRef: QUESTION_URI, text: "My answer", lang: "en" });

// ---------- Bluesky ----------

test("bluesky: posts under the question and returns the web link", async () => {
  const f = fakeFetch(blueskyRoutes(CREATED));
  const out = await post(f.fetchFn);
  assert.deepEqual(out, { status: "posted", url: "https://bsky.app/profile/walter.bsky.social/post/r1" });
  const body = JSON.parse(f.calls.find((c) => c.url.includes("createRecord"))?.body ?? "{}");
  assert.equal(body.record.reply.parent.uri, QUESTION_URI);
  assert.equal(body.record.reply.root.uri, QUESTION_URI);
  assert.ok(!JSON.stringify(out).includes("acc1"), "no token in the outcome");
});

test("bluesky: a timeout on the post request is maybe_posted, never failed", async () => {
  const f = fakeFetch(blueskyRoutes(() => "throw"));
  const out = await post(f.fetchFn);
  assert.equal(out.status, "maybe_posted");
  assert.match((out as { error: string }).error, /check the thread/);
});

test("bluesky: 5xx on the post is maybe_posted; 4xx (refused) is failed", async () => {
  assert.equal((await post(fakeFetch(blueskyRoutes(() => ({ status: 502 }))).fetchFn)).status, "maybe_posted");
  const refused = await post(fakeFetch(blueskyRoutes(() => ({ status: 400, json: { error: "InvalidRequest" } }))).fetchFn);
  assert.deepEqual(refused, { status: "failed", error: "Bluesky post HTTP 400 (InvalidRequest)" });
});

test("bluesky: failures before the post request are failed (nothing went out)", async () => {
  const loginDown = fakeFetch([{ match: "createSession", respond: () => "throw" }]);
  assert.equal((await post(loginDown.fetchFn)).status, "failed");
  const gone = fakeFetch([...blueskyRoutes(CREATED).filter((r) => r.match !== "getPosts"), { match: "getPosts", respond: ok({ posts: [] }) }]);
  const out = await post(gone.fetchFn);
  assert.deepEqual(out, { status: "failed", error: "The Bluesky post is gone (deleted or hidden)." });
  assert.equal(gone.count("createRecord"), 0);
  assert.deepEqual(await postBlueskyReply(gone.fetchFn, new Map(), null, { threadRef: QUESTION_URI, text: "x", lang: "en" }), {
    status: "failed",
    error: "His Bluesky account isn't connected.",
  });
});

test("bluesky: his existing reply under the post counts as posted (retry never answers twice)", async () => {
  const mine = ok({ thread: { replies: [{ post: { uri: "at://did:plc:him/app.bsky.feed.post/old", author: { did: "did:plc:him" } } }] } });
  const f = fakeFetch(blueskyRoutes(CREATED, mine));
  const out = await post(f.fetchFn);
  assert.deepEqual(out, { status: "posted", url: "https://bsky.app/profile/walter.bsky.social/post/old", alreadyThere: true });
  assert.equal(f.count("createRecord"), 0, "no second reply");
  assert.equal(ownReplyIn({ thread: { replies: [{ post: { uri: "u", author: { did: "did:plc:x" } } }] } }, "did:plc:him"), undefined);
  assert.equal(ownReplyIn(null, "did:plc:him"), undefined);
});

// ---------- session reuse ----------

test("session: reused while fresh, refreshed when old, new login only when refresh fails", async () => {
  const cache: SessionCache = new Map();
  const f = fakeFetch([
    { match: "createSession", respond: SESSION },
    { match: "refreshSession", respond: ok({ accessJwt: "acc2", refreshJwt: "ref2", did: "did:plc:him", handle: "walter.bsky.social" }) },
  ]);
  const s1 = await getSession(f.fetchFn, cache, LOGIN);
  const s2 = await getSession(f.fetchFn, cache, LOGIN);
  assert.equal(s2, s1);
  assert.equal(f.count("createSession"), 1, "one login for two uses");
  const s3 = await getSession(f.fetchFn, cache, LOGIN, { now: (s1.obtainedAt ?? 0) + SESSION_REUSE_MS + 1 });
  assert.equal(s3.accessJwt, "acc2");
  assert.equal(f.calls.find((c) => c.url.includes("refreshSession"))?.headers?.Authorization, "Bearer ref1");
  assert.equal(f.count("createSession"), 1, "refresh doesn't log in again");

  const g = fakeFetch([
    { match: "createSession", respond: SESSION },
    { match: "refreshSession", respond: () => ({ status: 400, json: { error: "ExpiredToken" } }) },
  ]);
  const c2: SessionCache = new Map();
  await getSession(g.fetchFn, c2, LOGIN);
  await getSession(g.fetchFn, c2, LOGIN, { force: true });
  assert.equal(g.count("createSession"), 2, "expired refresh token: log in again");
});

test("session: an expired access token is renewed and the call retried once; other errors aren't retried", async () => {
  const cache: SessionCache = new Map();
  const f = fakeFetch([
    { match: "createSession", respond: SESSION },
    { match: "refreshSession", respond: ok({ accessJwt: "acc2", refreshJwt: "ref2", did: "did:plc:him" }) },
  ]);
  const seen: string[] = [];
  const out = await withSession(f.fetchFn, cache, LOGIN, async (s) => {
    seen.push(s.accessJwt);
    if (s.accessJwt === "acc1") throw new BlueskyHttpError("search", 400, "ExpiredToken");
    return "done";
  });
  assert.equal(out, "done");
  assert.deepEqual(seen, ["acc1", "acc2"]);
  let tries = 0;
  await assert.rejects(
    withSession(f.fetchFn, cache, LOGIN, async () => {
      tries++;
      throw new Error("boom");
    }),
  );
  assert.equal(tries, 1);
});

test("search plan: every keyword, a small limit each", () => {
  assert.deepEqual(blueskySearchPlan(["bakery"]), { queries: ["bakery"], limit: 25 });
  assert.deepEqual(blueskySearchPlan(["a", "b", "c", "d", "e"]), { queries: ["a", "b", "c", "d", "e"], limit: 10 });
  assert.equal(blueskySearchPlan(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]).queries.length, 8);
  assert.equal(blueskySearchPlan(["a", "b", "c", "d", "e", "f", "g", "h"]).limit, 7);
  assert.deepEqual(blueskySearchPlan([" x ", "x", ""]), { queries: ["x"], limit: 25 });
  assert.deepEqual(blueskySearchPlan([]), { queries: [], limit: 0 });
});

// ---------- Reddit ----------

const redditRoutes = (comment: Route["respond"]): Route[] => [
  { match: "access_token", respond: ok({ access_token: "rtok" }) },
  { match: "api/comment", respond: comment },
];

test("reddit: comment posted with the permalink; refusals in json.errors are failed", async () => {
  const f = fakeFetch(redditRoutes(ok({ json: { errors: [], data: { things: [{ data: { permalink: "/r/Baking/comments/1abcde/x/c1/" } }] } } })));
  assert.deepEqual(await postRedditReply(f.fetchFn, REDDIT, { threadUrl: THREAD_URL, text: "My answer" }), {
    status: "posted",
    url: "https://www.reddit.com/r/Baking/comments/1abcde/x/c1/",
  });
  const body = new URLSearchParams(f.calls[1].body ?? "");
  assert.equal(body.get("thing_id"), "t3_1abcde");
  assert.equal(f.calls[1].headers?.Authorization, "bearer rtok");
  const limited = fakeFetch(redditRoutes(ok({ json: { errors: [["RATELIMIT", "slow down", "ratelimit"]] } })));
  assert.deepEqual(await postRedditReply(limited.fetchFn, REDDIT, { threadUrl: THREAD_URL, text: "x" }), { status: "failed", error: "Reddit: RATELIMIT" });
});

test("reddit: timeout or 5xx on the comment is maybe_posted; token trouble is failed", async () => {
  assert.equal((await postRedditReply(fakeFetch(redditRoutes(() => "throw")).fetchFn, REDDIT, { threadUrl: THREAD_URL, text: "x" })).status, "maybe_posted");
  assert.equal((await postRedditReply(fakeFetch(redditRoutes(() => ({ status: 503 }))).fetchFn, REDDIT, { threadUrl: THREAD_URL, text: "x" })).status, "maybe_posted");
  assert.equal((await postRedditReply(fakeFetch(redditRoutes(() => ({ status: 403 }))).fetchFn, REDDIT, { threadUrl: THREAD_URL, text: "x" })).status, "failed");
  const noToken = fakeFetch([{ match: "access_token", respond: () => ({ status: 401 }) }]);
  assert.deepEqual(await postRedditReply(noToken.fetchFn, REDDIT, { threadUrl: THREAD_URL, text: "x" }), { status: "failed", error: "Reddit token HTTP 401" });
  assert.equal((await postRedditReply(noToken.fetchFn, null, { threadUrl: THREAD_URL, text: "x" })).status, "failed");
  assert.equal((await postRedditReply(noToken.fetchFn, REDDIT, { threadUrl: "https://example.com/x", text: "x" })).status, "failed");
});

// ---------- claim -> post -> finish ----------

const REPLY: ReplyForPosting = { platform: "bluesky", status: "draft", threadUrl: "https://bsky.app/x", threadRef: QUESTION_URI, text: "t", language: "en" };

function flow(over: { claimOk?: boolean; post?: () => Promise<PostOutcome>; reply?: ReplyForPosting | null } = {}) {
  const finished: PostOutcome[] = [];
  const claims: boolean[] = [];
  let posts = 0;
  const deps = {
    load: async () => (over.reply === undefined ? REPLY : over.reply),
    claim: async (approve: boolean) => {
      claims.push(approve);
      return over.claimOk === false ? { ok: false, reason: "Already posted." } : { ok: true };
    },
    post: async () => {
      posts++;
      return over.post ? over.post() : ({ status: "posted", url: "https://bsky.app/r" } as PostOutcome);
    },
    finish: async (o: PostOutcome) => {
      finished.push(o);
    },
  };
  return { deps, finished, claims, posts: () => posts };
}

test("runPostReply: claim, post, record posted", async () => {
  const f = flow();
  assert.deepEqual(await runPostReply(f.deps, false), { status: "posted", url: "https://bsky.app/r" });
  assert.deepEqual(f.claims, [false]);
  assert.deepEqual(f.finished, [{ status: "posted", url: "https://bsky.app/r" }]);
});

test("runPostReply: no claim, no post", async () => {
  const f = flow({ claimOk: false });
  assert.deepEqual(await runPostReply(f.deps, true), { status: "draft", reason: "Already posted." });
  assert.equal(f.posts(), 0);
  assert.deepEqual(f.finished, []);
  const missing = flow({ reply: null });
  assert.deepEqual(await runPostReply(missing.deps, false), { status: "failed", reason: "Reply not found." });
});

test("runPostReply: maybe_posted and failed are recorded as such; a throw is maybe_posted", async () => {
  const unclear = flow({ post: async () => ({ status: "maybe_posted", error: "timeout: check the thread" }) });
  assert.deepEqual(await runPostReply(unclear.deps, false), { status: "maybe_posted", reason: "timeout: check the thread" });
  assert.equal(unclear.finished[0].status, "maybe_posted");
  const thrown = flow({ post: async () => { throw new Error("bug"); } });
  assert.equal((await runPostReply(thrown.deps, false)).status, "maybe_posted");
  assert.equal(thrown.finished[0].status, "maybe_posted");
});

// ---------- small rules ----------

test("writeFailureStatus: only a clear refusal is failed", () => {
  assert.equal(writeFailureStatus(undefined), "maybe_posted");
  assert.equal(writeFailureStatus(408), "maybe_posted");
  assert.equal(writeFailureStatus(500), "maybe_posted");
  assert.equal(writeFailureStatus(200), "maybe_posted", "a 2xx we couldn't read");
  assert.equal(writeFailureStatus(400), "failed");
  assert.equal(writeFailureStatus(429), "failed");
});

test("guardContextForReply: a note only when the reply is translated", () => {
  assert.equal(guardContextForReply("es", "es-MX"), undefined);
  assert.equal(guardContextForReply("en", "en-US"), undefined);
  const note = guardContextForReply("en", "es-MX") ?? "";
  assert.match(note, /English/);
  assert.match(note, /Spanish/);
  assert.match(note, /meaning, not wording/);
});

test("draftCutoff: default 7 days, clamped to 1-60", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  assert.equal(draftCutoff(now, undefined), now - 7 * 86_400_000);
  assert.equal(draftCutoff(now, 0), now - 86_400_000);
  assert.equal(draftCutoff(now, 365), now - 60 * 86_400_000);
});

test("logins: env for now, null when missing; Reddit only when REDDIT_POSTING is on", async () => {
  const env = { BLUESKY_HANDLE: "walter.bsky.social", BLUESKY_APP_PASSWORD: "p", REDDIT_CLIENT_ID: "a", REDDIT_CLIENT_SECRET: "b", REDDIT_USERNAME: "w", REDDIT_PASSWORD: "c" };
  assert.deepEqual(await blueskyLoginForElder(null, "e1", env), { service: "https://bsky.social", identifier: "walter.bsky.social", password: "p" });
  assert.equal(await blueskyLoginForElder(null, "e1", { BLUESKY_HANDLE: "x" }), null);
  assert.equal(await redditLoginForElder(null, "e1", env), null, "off by default");
  const on = await redditLoginForElder(null, "e1", { ...env, REDDIT_POSTING: "on" });
  assert.equal(on?.userAgent, "web:frontporch:v1 (by /u/w)");
  assert.equal(await redditLoginForElder(null, "e1", { ...env, REDDIT_POSTING: "on", REDDIT_PASSWORD: undefined }), null);
});

test("review page: maybe_posted says to check the thread first, with the approve command", () => {
  const html = renderRepliesSection([
    { id: "r9", createdAt: 0, platform: "bluesky", status: "maybe_posted", threadUrl: "https://bsky.app/profile/a/post/q", threadTitle: "t", text: "y", error: "timeout" },
  ]);
  assert.match(html, /Maybe posted: check the thread/);
  assert.match(html, /Open thread/);
  assert.match(html, /threadReplies:postReply/);
  assert.match(html, /"replyId":"r9","approve":true/);
  assert.match(html, /threadReplies:postDrafts/);
});
