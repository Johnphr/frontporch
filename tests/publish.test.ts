// Story publishing (publish.ts) with fakes: no network, no real accounts, no database.
//   createThread chaining + partial failure, Bluesky story recovery, Reddit profile posts,
//   claim / finish rules, platform gating, and the removedAt re-check.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createThread, type FetchFn } from "../convex/lib/blueskyClient.ts";
import { splitBlueskyThread } from "../convex/lib/blueskyThread.ts";
import { DEFAULT_DISCLOSURE, SPANISH_DISCLOSURE } from "../convex/lib/linkedinPost.ts";
import { isBlueskyLoginRefused, redditLoginForElder } from "../convex/lib/logins.ts";
import {
  PLATFORMS,
  PLATFORM_LABEL,
  STALE_CLAIM_MS,
  canClaimPublication,
  canRetry,
  canStartPublish,
  enabledPlatforms,
  isSwitchOn,
  linkedinPostingOn,
  mayBeOut,
  overallPostStatus,
  runPublish,
  shouldRecover,
  skipReason,
  type GuardResult,
  type Platform,
  type PlatformOutcome,
  type PublishDeps,
} from "../convex/lib/postFlow.ts";
import { postBlueskyStory, redditStoryParts, submitRedditStory } from "../convex/lib/storyPublishing.ts";
import { NOW } from "./helpers.ts";

const LOGIN = { service: "https://bsky.social", identifier: "walter.bsky.social", password: "app-pass" };
const REDDIT = { clientId: "cid", clientSecret: "csecret", username: "walter", password: "rpass", userAgent: "web:test:v1" };

type Call = { url: string; method?: string; headers?: Record<string, string>; body?: string };

/** Fake Bluesky PDS: createSession, createRecord (numbered), listRecords. `fail` decides per createRecord call. */
function fakeBluesky(opts: { fail?: (n: number) => { status: number; json?: unknown } | "throw" | null; listed?: unknown[] } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, ...init });
    const reply = (status: number, json: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
    if (url.includes("createSession")) return reply(200, { accessJwt: "acc", refreshJwt: "ref", did: "did:plc:him", handle: "walter.bsky.social" });
    if (url.includes("listRecords")) return reply(200, { records: opts.listed ?? [] });
    if (url.includes("createRecord")) {
      n += 1;
      const f = opts.fail?.(n);
      if (f === "throw") throw new Error("The operation was aborted");
      if (f) return reply(f.status, f.json ?? {});
      return reply(200, { uri: `at://did:plc:him/app.bsky.feed.post/p${n}`, cid: `cid${n}` });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const records = () => calls.filter((c) => c.url.includes("createRecord")).map((c) => JSON.parse(c.body ?? "{}").record);
  return { fetchFn, calls, records };
}

const TEXTS = ["Post one #baking", "Post two", "Post three"];

// ---------- createThread ----------

test("createThread: root first, then replies with root = post 1 and parent = the previous post", async () => {
  const bs = fakeBluesky();
  const out = await createThread(bs.fetchFn, new Map(), LOGIN, { texts: TEXTS, langs: ["en"], now: () => NOW });
  assert.equal(out.ok, true);
  assert.deepEqual(out.records.map((r) => r.uri), [1, 2, 3].map((i) => `at://did:plc:him/app.bsky.feed.post/p${i}`));
  const [r1, r2, r3] = bs.records();
  assert.equal(r1.reply, undefined);
  assert.deepEqual(r2.reply, { root: { uri: out.records[0].uri, cid: "cid1" }, parent: { uri: out.records[0].uri, cid: "cid1" } });
  assert.deepEqual(r3.reply, { root: { uri: out.records[0].uri, cid: "cid1" }, parent: { uri: out.records[1].uri, cid: "cid2" } });
  for (const r of [r1, r2, r3]) {
    assert.deepEqual(r.langs, ["en"]);
    assert.ok(!Number.isNaN(Date.parse(r.createdAt)));
  }
  assert.ok(Date.parse(r1.createdAt) < Date.parse(r2.createdAt), "strictly increasing createdAt");
  // One login for the whole thread (session cache), and no password anywhere but the login.
  assert.equal(bs.calls.filter((c) => c.url.includes("createSession")).length, 1);
  assert.ok(bs.calls.filter((c) => !c.url.includes("createSession")).every((c) => !(c.body ?? "").includes("app-pass")));
});

test("createThread: a refused post stops the thread and returns the posts already made", async () => {
  const bs = fakeBluesky({ fail: (n) => (n === 2 ? { status: 400, json: { error: "InvalidRequest", message: "secret body text" } } : null) });
  const out = await createThread(bs.fetchFn, new Map(), LOGIN, { texts: TEXTS, langs: ["en"] });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.records.length, 1);
  assert.equal(out.sent, true);
  assert.equal(out.httpStatus, 400);
  assert.match(out.error, /HTTP 400 \(InvalidRequest\)/);
  assert.doesNotMatch(out.error, /secret body text/);
  assert.equal(bs.records().length, 2, "post 3 is never tried");
});

test("createThread: continues after `done` (a retry never posts the first posts again)", async () => {
  const bs = fakeBluesky();
  const done = [{ uri: "at://did:plc:him/app.bsky.feed.post/old1", cid: "old1" }];
  const out = await createThread(bs.fetchFn, new Map(), LOGIN, { texts: TEXTS, langs: ["en"], done });
  assert.equal(out.ok, true);
  assert.equal(bs.records().length, 2);
  assert.deepEqual(bs.records()[0].reply.root, done[0]);
  assert.deepEqual(out.records[0], done[0]);
});

test("createThread: login failure -> nothing sent; a timeout on a post -> sent (unclear)", async () => {
  const noLogin: FetchFn = async () => ({ ok: false, status: 401, json: async () => ({ error: "AuthenticationRequired" }) });
  const a = await createThread(noLogin, new Map(), LOGIN, { texts: TEXTS, langs: ["en"] });
  assert.equal(a.ok, false);
  if (!a.ok) {
    assert.equal(a.sent, false);
    assert.equal(a.error, "Bluesky login refused: HTTP 401 (AuthenticationRequired)");
  }
  const bs = fakeBluesky({ fail: (n) => (n === 3 ? "throw" : null) });
  const b = await createThread(bs.fetchFn, new Map(), LOGIN, { texts: TEXTS, langs: ["en"] });
  assert.equal(b.ok, false);
  if (!b.ok) {
    assert.equal(b.sent, true);
    assert.equal(b.httpStatus, undefined);
    assert.equal(b.records.length, 2);
  }
});

test("createThread: hashtag facets are attached when asked", async () => {
  const bs = fakeBluesky();
  await createThread(bs.fetchFn, new Map(), LOGIN, {
    texts: TEXTS,
    langs: ["en"],
    facetsFor: (t) => (t.includes("#") ? [{ tag: true }] : []),
  });
  assert.deepEqual(bs.records()[0].facets, [{ tag: true }]);
  assert.equal(bs.records()[1].facets, undefined);
});

// ---------- the Bluesky story outcome ----------

test("postBlueskyStory: posted -> records root first + web url of post 1", async () => {
  const bs = fakeBluesky();
  const out = await postBlueskyStory(bs.fetchFn, new Map(), LOGIN, { texts: TEXTS, langs: ["en"] });
  assert.equal(out.status, "posted");
  if (out.status !== "posted") return;
  assert.equal(out.records?.length, 3);
  assert.equal(out.url, "https://bsky.app/profile/walter.bsky.social/post/p1");
});

test("postBlueskyStory: partial refused -> failed with records + url; partial timeout -> maybe_posted", async () => {
  const refused = await postBlueskyStory(fakeBluesky({ fail: (n) => (n === 2 ? { status: 400 } : null) }).fetchFn, new Map(), LOGIN, { texts: TEXTS, langs: ["en"] });
  assert.equal(refused.status, "failed");
  assert.ok(mayBeOut(refused), "a half thread is out");
  if (refused.status === "failed") {
    assert.equal(refused.records?.length, 1);
    assert.match(refused.error, /Posted 1 of 3/);
    assert.match(refused.url ?? "", /post\/p1$/);
  }
  const unclear = await postBlueskyStory(fakeBluesky({ fail: (n) => (n === 2 ? { status: 502 } : null) }).fetchFn, new Map(), LOGIN, { texts: TEXTS, langs: ["en"] });
  assert.equal(unclear.status, "maybe_posted");
  const refusedLogin: FetchFn = async () => ({ ok: false, status: 401, json: async () => ({ error: "AuthenticationRequired" }) });
  const badPassword = await postBlueskyStory(refusedLogin, new Map(), LOGIN, { texts: TEXTS, langs: ["en"] });
  assert.equal(badPassword.status, "failed", "a refused login posts nothing");
  if (badPassword.status === "failed") assert.match(badPassword.error, /^Bluesky login refused: HTTP 401/);
  const noLogin = await postBlueskyStory(fakeBluesky().fetchFn, new Map(), null, { texts: TEXTS, langs: ["en"] });
  assert.equal(noLogin.status, "failed");
  assert.equal(mayBeOut(noLogin), false);
});

test("postBlueskyStory: recover finds the earlier attempt's posts and only posts the rest", async () => {
  const at = (ms: number) => new Date(ms).toISOString();
  const listed = [
    { uri: "at://did:plc:him/app.bsky.feed.post/a1", cid: "a1", value: { text: TEXTS[0], createdAt: at(NOW + 1000) } },
    { uri: "at://did:plc:him/app.bsky.feed.post/a2", cid: "a2", value: { text: TEXTS[1], createdAt: at(NOW + 1001), reply: { parent: { uri: "at://did:plc:him/app.bsky.feed.post/a1" } } } },
  ];
  const bs = fakeBluesky({ listed });
  const out = await postBlueskyStory(bs.fetchFn, new Map(), LOGIN, { texts: TEXTS, langs: ["en"], recover: true, since: NOW });
  assert.equal(out.status, "posted");
  assert.equal(bs.records().length, 1);
  assert.equal(bs.records()[0].text, TEXTS[2]);
  assert.equal(bs.records()[0].reply.parent.uri, "at://did:plc:him/app.bsky.feed.post/a2");
  if (out.status === "posted") assert.match(out.url ?? "", /post\/a1$/);
});

test("postBlueskyStory: recover ignores an older post with the same text", async () => {
  // Same opening as an old story of his, posted a day before this row existed.
  const listed = [{ uri: "at://did:plc:him/app.bsky.feed.post/old", cid: "old", value: { text: TEXTS[0], createdAt: new Date(NOW - 86_400_000).toISOString() } }];
  const bs = fakeBluesky({ listed });
  const out = await postBlueskyStory(bs.fetchFn, new Map(), LOGIN, { texts: TEXTS, langs: ["en"], recover: true, since: NOW });
  assert.equal(out.status, "posted");
  assert.equal(bs.records().length, 3, "the whole thread is posted, not replies under the old post");
  assert.equal(bs.records()[1].reply.root.uri, "at://did:plc:him/app.bsky.feed.post/p1");
});

test("postBlueskyStory: a refused login is reported (his account gets marked invalid)", async () => {
  const refusedLogin: FetchFn = async () => ({ ok: false, status: 401, json: async () => ({ error: "AuthenticationRequired" }) });
  const seen: unknown[] = [];
  const out = await postBlueskyStory(refusedLogin, new Map(), LOGIN, { texts: TEXTS, langs: ["en"], onLoginError: (e) => void seen.push(e) });
  assert.equal(out.status, "failed");
  assert.equal(seen.length, 1);
  assert.equal(isBlueskyLoginRefused(seen[0]), true);
  // A post that's refused (not the login) isn't a login problem.
  const later: unknown[] = [];
  await postBlueskyStory(fakeBluesky({ fail: () => ({ status: 400 }) }).fetchFn, new Map(), LOGIN, { texts: TEXTS, langs: ["en"], onLoginError: (e) => void later.push(e) });
  assert.equal(later.length, 0);
  // A throwing reporter never breaks posting.
  const ok = await postBlueskyStory(refusedLogin, new Map(), LOGIN, { texts: TEXTS, langs: ["en"], onLoginError: () => { throw new Error("db down"); } });
  assert.equal(ok.status, "failed");
});

test("the real split goes out as is: disclosure in the last post, Spanish langs", async () => {
  const story = "Hook line here.\n\nThe story, part one. It goes on.\n\nThe lesson.\n\n¿Y usted?";
  const split = splitBlueskyThread(story, "es");
  assert.ok(split.ok);
  if (!split.ok) return;
  const bs = fakeBluesky();
  await postBlueskyStory(bs.fetchFn, new Map(), LOGIN, { texts: split.posts, langs: split.langs });
  const recs = bs.records();
  assert.ok(recs.at(-1).text.endsWith(SPANISH_DISCLOSURE));
  assert.deepEqual(recs[0].langs, ["es"]);
});

// ---------- Reddit profile post ----------

function fakeReddit(submit: () => { status: number; json?: unknown } | "throw") {
  const calls: Call[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, ...init });
    if (url.includes("access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "tok" }) };
    if (url.includes("/api/submit")) {
      const r = submit();
      if (r === "throw") throw new Error("aborted");
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json ?? {} };
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetchFn, calls };
}

test("redditStoryParts: title = the hook, text = the rest + disclosure, hashtag lines escaped", () => {
  const parts = redditStoryParts("The oven died.\n\nWe baked by hand.\n#baking #bread\n\nWhat saved you?", "en");
  assert.equal(parts.title, "The oven died.");
  assert.ok(parts.text.startsWith("We baked by hand."));
  assert.ok(parts.text.endsWith(DEFAULT_DISCLOSURE));
  assert.match(parts.text, /^\\#baking #bread$/m);
  const long = redditStoryParts(`${"word ".repeat(80)}end.\n\nRest.`, "es");
  assert.ok(long.title.length <= 300 && long.title.endsWith("…"));
  assert.ok(long.text.startsWith("word word"), "a cut title keeps the whole story in the text");
  assert.ok(long.text.endsWith(SPANISH_DISCLOSURE));
});

test("submitRedditStory: self post on u_<name>; posted / refused / unclear", async () => {
  const ok = fakeReddit(() => ({ status: 200, json: { json: { errors: [], data: { url: "https://www.reddit.com/user/walter/comments/abc/x/", name: "t3_abc" } } } }));
  const posted = await submitRedditStory(ok.fetchFn, REDDIT, { title: "T", text: "Body" });
  assert.deepEqual(posted, { status: "posted", url: "https://www.reddit.com/user/walter/comments/abc/x/", externalId: "t3_abc" });
  const body = new URLSearchParams(ok.calls.find((c) => c.url.includes("/api/submit"))!.body);
  assert.equal(body.get("sr"), "u_walter");
  assert.equal(body.get("kind"), "self");
  assert.equal(body.get("title"), "T");
  assert.equal(body.get("text"), "Body");

  const refused = await submitRedditStory(fakeReddit(() => ({ status: 200, json: { json: { errors: [["RATELIMIT", "try later"]] } } })).fetchFn, REDDIT, { title: "T", text: "B" });
  assert.deepEqual(refused, { status: "failed", error: "Reddit: RATELIMIT" });
  assert.equal((await submitRedditStory(fakeReddit(() => ({ status: 403 })).fetchFn, REDDIT, { title: "T", text: "B" })).status, "failed");
  assert.equal((await submitRedditStory(fakeReddit(() => ({ status: 503 })).fetchFn, REDDIT, { title: "T", text: "B" })).status, "maybe_posted");
  assert.equal((await submitRedditStory(fakeReddit(() => "throw").fetchFn, REDDIT, { title: "T", text: "B" })).status, "maybe_posted");
  assert.equal((await submitRedditStory(ok.fetchFn, null, { title: "T", text: "B" })).status, "failed");
  // Errors never carry the token or the password.
  for (const c of ok.calls) if (c.url.includes("/api/submit")) assert.ok(!(c.body ?? "").includes("rpass"));
});

// ---------- gating ----------

test("gating: LINKEDIN_POSTING off unless on/true/1/yes; Reddit only with REDDIT_POSTING + login", async () => {
  for (const v of ["on", "TRUE", " 1 ", "yes"]) assert.equal(linkedinPostingOn(v), true, v);
  for (const v of [undefined, "", "off", "no", "0", "enabled"]) assert.equal(linkedinPostingOn(v), false, String(v));
  assert.equal(isSwitchOn("On"), true);
  const env = { REDDIT_CLIENT_ID: "a", REDDIT_CLIENT_SECRET: "b", REDDIT_USERNAME: "c", REDDIT_PASSWORD: "d" };
  assert.equal(await redditLoginForElder(null, null, env), null);
  assert.notEqual(await redditLoginForElder(null, null, { ...env, REDDIT_POSTING: "on" }), null);
  assert.deepEqual(
    enabledPlatforms({ blueskyLogin: true, threadsLogin: false, xOn: false, xLogin: false, redditLogin: false, linkedinOn: false }),
    { bluesky: true, threads: false, x: false, reddit: false, linkedin: false },
  );
});

// ---------- claim / finish rules ----------

test("canStartPublish: pending/failed ok; held only with approve; one run at a time; removed never", () => {
  assert.equal(canStartPublish({ status: "pending" }, NOW, false).ok, true);
  assert.equal(canStartPublish({ status: "failed" }, NOW, false).ok, true);
  assert.equal(canStartPublish({ status: "needs_review" }, NOW, false).ok, false);
  assert.equal(canStartPublish({ status: "needs_review" }, NOW, true).ok, true);
  assert.equal(canStartPublish({ status: "posting", claimedAt: NOW - 60_000 }, NOW, false).ok, false);
  assert.equal(canStartPublish({ status: "posting", claimedAt: NOW - STALE_CLAIM_MS - 1 }, NOW, false).ok, true);
  assert.equal(canStartPublish({ status: "published" }, NOW, true).ok, false);
  assert.equal(canStartPublish({ status: "removed" }, NOW, true).ok, false);
  assert.equal(canStartPublish({ status: "pending", removedAt: NOW }, NOW, true).ok, false);
});

test("canClaimPublication: stale claims retaken, maybe_posted only with approve, never after removal", () => {
  const row = (status: string, extra: Record<string, unknown> = {}) => ({ platform: "bluesky", status, ...extra });
  assert.equal(canClaimPublication(row("pending"), NOW, false, false).ok, true);
  assert.equal(canClaimPublication(row("failed"), NOW, false, false).ok, true);
  assert.equal(canClaimPublication(row("skipped"), NOW, false, false).ok, true);
  assert.equal(canClaimPublication(row("posting", { claimedAt: NOW - 1000 }), NOW, true, false).ok, false);
  assert.equal(canClaimPublication(row("posting", { claimedAt: NOW - STALE_CLAIM_MS - 1 }), NOW, false, false).ok, true);
  assert.equal(canClaimPublication(row("maybe_posted"), NOW, false, false).ok, false, "never auto-reclaimed");
  assert.equal(canClaimPublication(row("maybe_posted", { claimedAt: NOW - 10 * STALE_CLAIM_MS }), NOW, false, false).ok, false);
  assert.equal(canClaimPublication(row("maybe_posted"), NOW, true, false).ok, true);
  assert.equal(canClaimPublication(row("posted"), NOW, true, false).ok, false);
  assert.equal(canClaimPublication(row("removing"), NOW, true, false).ok, false);
  assert.equal(canClaimPublication(row("removed"), NOW, true, false).ok, false);
  assert.equal(canClaimPublication(row("pending"), NOW, true, true).ok, false, "post taken down");
  assert.equal(canClaimPublication({ platform: "linkedin", status: "pending", externalId: "wf1" }, NOW, true, false).ok, false, "waiting on LinkedAPI");
});

test("canClaimPublication: a stale Reddit / LinkedIn claim becomes maybe_posted; Bluesky retakes it", () => {
  const stale = NOW - STALE_CLAIM_MS - 1;
  for (const platform of ["reddit", "linkedin"]) {
    for (const approve of [false, true]) {
      const c = canClaimPublication({ platform, status: "posting", claimedAt: stale }, NOW, approve, false);
      assert.equal(c.ok, false, `${platform} is never retaken (it can't check what went out)`);
      assert.ok(!c.ok && "becomes" in c && c.becomes === "maybe_posted");
      if (!c.ok) assert.match(c.reason, /approve: true/);
    }
    const fresh = canClaimPublication({ platform, status: "posting", claimedAt: NOW - 1000 }, NOW, false, false);
    assert.ok(!fresh.ok && !("becomes" in fresh), "a live claim is left alone");
  }
  assert.deepEqual(canClaimPublication({ platform: "bluesky", status: "posting", claimedAt: stale }, NOW, false, false), { ok: true });
  // The row then needs a person: maybe_posted only with approve.
  assert.equal(canClaimPublication({ platform: "reddit", status: "maybe_posted" }, NOW, false, false).ok, false);
  assert.equal(canClaimPublication({ platform: "reddit", status: "maybe_posted" }, NOW, true, false).ok, true);
});

test("overallPostStatus: published once any platform posted; failed when all failed; nowhere to post", () => {
  assert.equal(overallPostStatus([{ platform: "bluesky", status: "posted" }, { platform: "reddit", status: "failed", error: "Reddit HTTP 403" }]).status, "published");
  const pub = overallPostStatus([{ platform: "bluesky", status: "posted" }, { platform: "reddit", status: "failed", error: "Reddit HTTP 403" }]);
  assert.match(pub.error ?? "", /Reddit: failed \(Reddit HTTP 403\)/);
  const failed = overallPostStatus([{ platform: "bluesky", status: "maybe_posted" }, { platform: "linkedin", status: "skipped" }]);
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /maybe posted/);
  assert.equal(overallPostStatus([{ platform: "linkedin", status: "pending", externalId: "wf" }]).status, "posting");
  const nowhere = overallPostStatus([{ platform: "bluesky", status: "skipped" }, { platform: "reddit", status: "skipped" }]);
  assert.equal(nowhere.status, "failed");
  assert.match(nowhere.error ?? "", /Nowhere to post/);
});

test("canRetry: failed / maybe_posted / skipped rows of a published or failed post", () => {
  const checked = { guardPassedAt: NOW - 1000 };
  assert.equal(canRetry({ status: "published", ...checked }, { status: "failed" }).ok, true);
  assert.equal(canRetry({ status: "failed", ...checked }, { status: "maybe_posted" }).ok, true);
  assert.equal(canRetry({ status: "partly_posted", ...checked }, { status: "failed" }).ok, true);
  assert.equal(canRetry({ status: "published", ...checked }, { status: "posted" }).ok, false);
  assert.equal(canRetry({ status: "needs_review", ...checked }, { status: "failed" }).ok, false);
  assert.equal(canRetry({ status: "pending", ...checked }, { status: "failed" }).ok, false);
  assert.equal(canRetry({ status: "published", removedAt: NOW, ...checked }, { status: "failed" }).ok, false);
});

test("canRetry: never posts a story the fact-check didn't clear", () => {
  // Nothing was set up when it ran: guard skipped, rows skipped, post failed. Then his Bluesky
  // gets connected and someone retries the skipped row.
  const never = canRetry({ status: "failed" }, { platform: "bluesky", status: "skipped" });
  assert.equal(never.ok, false);
  if (!never.ok) assert.match(never.reason, /never fact-checked.*publish:publishPost/);
  assert.equal(canRetry({ status: "failed", guardIssues: ["made up"] }, { status: "failed" }).ok, false, "flagged in warn mode, before guardPassedAt");
  assert.equal(canRetry({ status: "published", guardIssues: [] }, { status: "failed" }).ok, true, "older rows: a clean saved check");
  assert.equal(canRetry({ status: "failed", guardPassedAt: NOW }, { platform: "bluesky", status: "skipped" }).ok, true);
});

test("canRetry: a stuck LinkedIn row is re-polled, never re-sent", () => {
  const r = canRetry({ status: "posting" }, { platform: "linkedin", status: "pending", externalId: "wf1" });
  assert.deepEqual(r, { ok: true, repoll: true });
  assert.equal(canRetry({ status: "posting", guardPassedAt: NOW }, { platform: "linkedin", status: "pending" }).ok, false, "not sent yet");
  assert.equal(canRetry({ status: "posting", removedAt: NOW }, { platform: "linkedin", status: "pending", externalId: "wf1" }).ok, false);
});

test("overallPostStatus: a half-posted thread is partly_posted, not failed", () => {
  const records = [{ uri: "at://x/app.bsky.feed.post/1", cid: "c1" }];
  const half = overallPostStatus([
    { platform: "bluesky", status: "failed", error: "Bluesky post HTTP 400. Posted 1 of 4; a retry continues the thread.", records },
    { platform: "reddit", status: "skipped" },
  ]);
  assert.equal(half.status, "partly_posted");
  assert.match(half.error ?? "", /Bluesky: partly posted/);
  const unclear = overallPostStatus([{ platform: "bluesky", status: "maybe_posted", error: "timeout", records }]);
  assert.equal(unclear.status, "partly_posted");
  assert.match(unclear.error ?? "", /maybe more/);
  // Another platform posted: published, and the error still names the half thread.
  const pub = overallPostStatus([{ platform: "bluesky", status: "failed", records }, { platform: "reddit", status: "posted" }]);
  assert.equal(pub.status, "published");
  assert.match(pub.error ?? "", /Bluesky: partly posted/);
  assert.equal(overallPostStatus([{ platform: "bluesky", status: "failed", error: "x" }]).status, "failed", "nothing out");
  assert.equal(canStartPublish({ status: "partly_posted" }, NOW, false).ok, true, "a run continues it");
});

// ---------- runPublish (fake deps) ----------

type Fake = {
  deps: PublishDeps;
  log: string[];
  rows: Map<string, { platform: Platform; status: string }>;
  state: { removed: boolean; status: string };
};

function fakeDeps(o: {
  status?: string;
  heldFor?: "quality" | "guard";
  removedAt?: number;
  enabled?: Partial<Record<Platform, boolean>>;
  guard?: GuardResult;
  outcomes?: Partial<Record<Platform, PlatformOutcome>>;
  removeAfter?: Platform;
}): Fake {
  const log: string[] = [];
  const rows = new Map<string, { platform: Platform; status: string }>();
  const state = { removed: o.removedAt !== undefined, status: o.status ?? "pending" };
  const deps: PublishDeps = {
    load: async () => ({ status: state.status, ...(o.removedAt !== undefined ? { removedAt: o.removedAt } : {}), ...(o.heldFor ? { heldFor: o.heldFor } : {}) }),
    platforms: async () => ({ bluesky: false, threads: false, x: false, reddit: false, linkedin: false, ...o.enabled }),
    claimPost: async (approve) => {
      log.push(`claimPost:${approve}`);
      const c = canStartPublish({ status: state.status }, NOW, approve);
      if (c.ok) state.status = "posting";
      return c;
    },
    guard: async () => {
      log.push("guard");
      return o.guard ?? { pass: true, issues: [], summary: "ok", mode: "enforce" };
    },
    saveGuard: async (_g, hold) => {
      log.push(`saveGuard:${hold}`);
      if (hold) state.status = "needs_review";
    },
    ensureRow: async (platform, enabled) => {
      const id = `row-${platform}`;
      if (!rows.has(id)) rows.set(id, { platform, status: enabled ? "pending" : "skipped" });
      return { id };
    },
    claimRow: async (id, approve) => {
      const r = rows.get(id)!;
      const c = canClaimPublication({ platform: r.platform, status: r.status }, NOW, approve, state.removed);
      if (c.ok) r.status = "posting";
      return c;
    },
    post: async (platform) => {
      log.push(`post:${platform}`);
      if (o.removeAfter === platform) state.removed = true; // undo asked while this platform was posting
      return o.outcomes?.[platform] ?? { status: "posted", url: `https://${platform}.example/p` };
    },
    finishRow: async (id, outcome) => {
      rows.get(id)!.status = outcome.status;
    },
    isRemoved: async () => state.removed,
    scheduleUndo: async () => {
      log.push("undo");
    },
    settle: async () => {
      const s = overallPostStatus([...rows.values()]);
      state.status = s.status;
      return s;
    },
  };
  return { deps, log, rows, state };
}

test("runPublish: Bluesky on, the rest off -> one post, skipped rows, published", async () => {
  const f = fakeDeps({ enabled: { bluesky: true } });
  const out = await runPublish(f.deps, false);
  assert.equal(out.status, "published");
  assert.deepEqual(f.log, ["claimPost:false", "guard", "saveGuard:false", "post:bluesky"]);
  assert.equal(f.rows.get("row-reddit")?.status, "skipped");
  assert.equal(f.rows.get("row-linkedin")?.status, "skipped");
  assert.deepEqual(out.platforms, { bluesky: "posted", threads: "skipped", x: "skipped", reddit: "skipped", linkedin: "skipped" });
});

test("runPublish: every enabled platform in order; all failed -> failed", async () => {
  const f = fakeDeps({
    enabled: { bluesky: true, reddit: true, linkedin: true },
    outcomes: {
      bluesky: { status: "failed", error: "Bluesky post HTTP 400" },
      reddit: { status: "failed", error: "Reddit HTTP 403" },
      linkedin: { status: "failed", error: "nope" },
    },
  });
  const out = await runPublish(f.deps, false);
  assert.deepEqual(f.log.filter((l) => l.startsWith("post:")), ["post:bluesky", "post:reddit", "post:linkedin"]);
  assert.equal(out.status, "failed");
});

test("runPublish: the fact-check holds it -> needs_review, posted nowhere", async () => {
  const f = fakeDeps({ enabled: { bluesky: true }, guard: { pass: false, issues: ["made up"], summary: "x", mode: "enforce" } });
  const out = await runPublish(f.deps, false);
  assert.equal(out.status, "needs_review");
  assert.ok(!f.log.some((l) => l.startsWith("post:")));
  assert.equal(f.rows.size, 0);
  // warn mode posts anyway
  const w = fakeDeps({ enabled: { bluesky: true }, guard: { pass: false, issues: ["made up"], summary: "x", mode: "warn" } });
  assert.equal((await runPublish(w.deps, false)).status, "published");
});

test("runPublish: approve skips the guard for a guard hold, runs it for a quality hold", async () => {
  const g = fakeDeps({ status: "needs_review", heldFor: "guard", enabled: { bluesky: true } });
  assert.equal((await runPublish(g.deps, true)).status, "published");
  assert.ok(!g.log.includes("guard"));
  const q = fakeDeps({ status: "needs_review", heldFor: "quality", enabled: { bluesky: true } });
  assert.equal((await runPublish(q.deps, true)).status, "published");
  assert.ok(q.log.includes("guard"));
  const held = fakeDeps({ status: "needs_review", enabled: { bluesky: true } });
  const out = await runPublish(held.deps, false);
  assert.equal(out.status, "needs_review");
  assert.match(out.reason ?? "", /publish:approvePost/);
});

test("runPublish: approving a post that was never held still fact-checks it", async () => {
  // AUTO_POST=off: pending, no heldFor. A failed post whose guard never ran: same.
  for (const status of ["pending", "failed"]) {
    const f = fakeDeps({ status, enabled: { bluesky: true }, guard: { pass: false, issues: ["made up"], summary: "x", mode: "enforce" } });
    const out = await runPublish(f.deps, true);
    assert.ok(f.log.includes("guard"), `${status}: checked`);
    assert.equal(out.status, "needs_review", `${status}: held, not posted`);
    assert.ok(!f.log.some((l) => l.startsWith("post:")));
  }
  const t = fakeDeps({ status: "needs_review", heldFor: "thread_fit", enabled: { bluesky: true } });
  await runPublish(t.deps, true);
  assert.ok(t.log.includes("guard"), "a thread-fit hold was never fact-checked");
});

test("runPublish: nothing set up -> no fact-check, failed with 'nowhere to post'", async () => {
  const f = fakeDeps({});
  const out = await runPublish(f.deps, false);
  assert.equal(out.status, "failed");
  assert.match(out.reason ?? "", /Nowhere to post/);
  assert.ok(!f.log.includes("guard"));
});

test("runPublish: a post with removedAt is never claimed or posted", async () => {
  const f = fakeDeps({ removedAt: NOW, enabled: { bluesky: true } });
  const out = await runPublish(f.deps, false);
  assert.match(out.reason ?? "", /Taken down/);
  assert.deepEqual(f.log, []);
});

test("runPublish: taken down while Bluesky was posting -> undo scheduled, Reddit never posted", async () => {
  const f = fakeDeps({ enabled: { bluesky: true, reddit: true }, removeAfter: "bluesky" });
  await runPublish(f.deps, false);
  assert.deepEqual(f.log.filter((l) => l === "undo" || l.startsWith("post:")), ["post:bluesky", "undo"]);
  assert.equal(f.rows.has("row-reddit"), false);
});

test("runPublish: removed meanwhile but nothing went out -> no undo needed", async () => {
  const f = fakeDeps({ enabled: { bluesky: true, reddit: true }, removeAfter: "bluesky", outcomes: { bluesky: { status: "failed", error: "Bluesky post HTTP 400" } } });
  await runPublish(f.deps, false);
  assert.ok(!f.log.includes("undo"));
  assert.ok(!f.log.includes("post:reddit"), "stops before the next platform");
});

test("runPublish: a maybe_posted row is not retried by a second automatic run", async () => {
  const f = fakeDeps({ enabled: { bluesky: true }, outcomes: { bluesky: { status: "maybe_posted", error: "timeout" } } });
  const first = await runPublish(f.deps, false);
  assert.equal(first.status, "failed");
  f.log.length = 0;
  await runPublish(f.deps, false);
  assert.ok(!f.log.includes("post:bluesky"));
});

// ---------- Threads and X ----------

test("enabledPlatforms: Threads with a login (no switch); X only with X_POSTING and a login", () => {
  const base = { blueskyLogin: false, threadsLogin: false, xOn: false, xLogin: false, redditLogin: false, linkedinOn: false };
  assert.equal(enabledPlatforms({ ...base, threadsLogin: true }).threads, true);
  assert.equal(enabledPlatforms(base).threads, false);
  assert.equal(enabledPlatforms({ ...base, xOn: true, xLogin: true }).x, true);
  assert.equal(enabledPlatforms({ ...base, xOn: true }).x, false, "no X login");
  assert.equal(enabledPlatforms({ ...base, xLogin: true }).x, false, "X_POSTING off");
  assert.deepEqual(PLATFORMS, ["bluesky", "threads", "x", "reddit", "linkedin"]);
  assert.equal(PLATFORM_LABEL.threads, "Threads");
  assert.equal(PLATFORM_LABEL.x, "X");
  assert.match(skipReason("threads"), /Threads account isn't connected/);
  assert.match(skipReason("x"), /X_POSTING/);
});

test("shouldRecover: after maybe_posted / a crashed claim / a partial thread", () => {
  assert.equal(shouldRecover("maybe_posted", []), true);
  assert.equal(shouldRecover("posting", undefined), true);
  assert.equal(shouldRecover("failed", [{ uri: "p1", cid: "" }]), true);
  assert.equal(shouldRecover("pending", []), false);
  assert.equal(shouldRecover(undefined, undefined), false);
});

test("canClaimPublication: a stale Threads / X claim becomes maybe_posted (no repo check)", () => {
  for (const platform of ["threads", "x"]) {
    const c = canClaimPublication({ platform, status: "posting", claimedAt: NOW - STALE_CLAIM_MS - 1 }, NOW, true, false);
    assert.ok(!c.ok && "becomes" in c && c.becomes === "maybe_posted", platform);
  }
});

test("overallPostStatus: a half-posted Threads or X thread is partly_posted, named in the error", () => {
  for (const platform of ["threads", "x"]) {
    const out = overallPostStatus([
      { platform: "bluesky", status: "skipped" },
      { platform, status: "failed", error: "HTTP 400", records: [{ uri: "1", cid: "" }] },
    ]);
    assert.equal(out.status, "partly_posted", platform);
    assert.match(out.error ?? "", platform === "x" ? /^X: partly posted/ : /^Threads: partly posted/);
  }
});

test("runPublish: Bluesky, Threads, X in order, then Reddit and LinkedIn", async () => {
  const f = fakeDeps({ enabled: { bluesky: true, threads: true, x: true, reddit: true, linkedin: true } });
  const out = await runPublish(f.deps, false);
  assert.equal(out.status, "published");
  assert.deepEqual(f.log.filter((l) => l.startsWith("post:")), ["post:bluesky", "post:threads", "post:x", "post:reddit", "post:linkedin"]);
});

test("runPublish: taken down while Threads was posting -> undo, X never posted", async () => {
  const f = fakeDeps({ enabled: { bluesky: true, threads: true, x: true }, removeAfter: "threads" });
  await runPublish(f.deps, false);
  assert.deepEqual(f.log.filter((l) => l === "undo" || l.startsWith("post:")), ["post:bluesky", "post:threads", "undo"]);
  assert.equal(f.rows.has("row-x"), false);
});

test("runPublish: only Threads connected -> fact-checked, posted there, published", async () => {
  const f = fakeDeps({ enabled: { threads: true } });
  const out = await runPublish(f.deps, false);
  assert.equal(out.status, "published");
  assert.ok(f.log.includes("guard"));
  assert.deepEqual(f.log.filter((l) => l.startsWith("post:")), ["post:threads"]);
});
