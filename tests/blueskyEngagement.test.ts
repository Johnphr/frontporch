import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchFn } from "../convex/lib/blueskyClient.ts";
import {
  MAX_REPLIES,
  MAX_REPLY_CHARS,
  PUBLIC_APPVIEW,
  isNotFound,
  parseThread,
  publicationsToScrape,
  publicationUrl,
  repoOf,
  threadEngagement,
  toUpsertArgs,
  webUrlFor,
  type BlueskyPublication,
} from "../convex/lib/blueskyEngagement.ts";
import { cleanComments, nextSnapshot } from "../convex/lib/engagementRules.ts";
import { NOW, fixture } from "./helpers.ts";

const WALT = "did:plc:walt123";
const ROOT = `at://${WALT}/app.bsky.feed.post/3lroot`;
const DAY = 86_400_000;

type Call = { url: string; headers: Record<string, string> };

function fakeFetch(respond: (url: string) => { status: number; body: unknown }): { fetchFn: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const { status, body } = respond(url);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchFn, calls };
}

function node(uri: string, did: string, text: string, extra: Record<string, unknown> = {}, replies: unknown[] = []) {
  return {
    $type: "app.bsky.feed.defs#threadViewPost",
    post: { uri, cid: "c", author: { did, handle: `${did.slice(8)}.bsky.social` }, record: { text }, ...extra },
    replies,
  };
}

test("parseThread: likes + reposts on his posts only, replies by others, blocked/notFound skipped", () => {
  const e = parseThread(fixture("bluesky_thread.json"), WALT);
  // root 12+3, post 2 4+1, post 3 2+0, his reply to Carol 1+0. Carol's 5 likes are hers, not his.
  assert.equal(e.likes, 19);
  assert.equal(e.reposts, 4);
  assert.deepEqual(e.ownUris.sort(), [
    `at://${WALT}/app.bsky.feed.post/3lpost2`,
    `at://${WALT}/app.bsky.feed.post/3lpost3`,
    ROOT,
    `at://${WALT}/app.bsky.feed.post/3lwaltreply`,
  ]);
  // Breadth first: direct replies before nested ones. Image-only reply (no text) skipped.
  assert.deepEqual(e.replies, [
    { author: "Carol Diaz (@carol.bsky.social)", text: "Lovely story. My grandfather was a baker too." },
    { author: "@ana.example.com", text: "How did you price bread back then? Did flour costs change it?" },
    { author: "Bo (@bo.bsky.social)", text: "Same question!" },
  ]);
  assert.equal(e.repliesSeen, 3);
});

test("parseThread: no thread, garbage or a not-found root gives nothing", () => {
  for (const json of [null, {}, { thread: { $type: "app.bsky.feed.defs#notFoundPost", uri: ROOT, notFound: true } }]) {
    assert.deepEqual(parseThread(json, WALT), { likes: 0, reposts: 0, replies: [], repliesSeen: 0, ownUris: [] });
  }
});

test("parseThread: caps reply count and length, ignores bad counts", () => {
  const long = "x".repeat(2000);
  const replies = Array.from({ length: 30 }, (_, i) => node(`at://did:plc:r${i}/app.bsky.feed.post/${i}`, `did:plc:r${i}`, `${i} ${long}`));
  const json = { thread: node(ROOT, WALT, "root", { likeCount: -3, repostCount: "7" }, replies) };
  const e = parseThread(json, WALT);
  assert.equal(e.replies.length, MAX_REPLIES);
  assert.equal(e.repliesSeen, 30);
  assert.ok(e.replies.every((r) => r.text.length <= MAX_REPLY_CHARS));
  assert.ok(e.replies[0].text.startsWith("0 x"));
  assert.equal(e.likes, 0);
  assert.equal(e.reposts, 0);
  assert.equal(parseThread(json, WALT, { maxReplies: 2 }).replies.length, 2);
});

test("repoOf and webUrlFor read at:// uris", () => {
  assert.equal(repoOf(ROOT), WALT);
  assert.equal(repoOf("https://bsky.app/x"), "");
  assert.equal(webUrlFor(ROOT), `https://bsky.app/profile/${WALT}/post/3lroot`);
  assert.equal(webUrlFor("at://did:plc:x/app.bsky.feed.like/1"), "");
});

test("threadEngagement reads the public AppView without a login", async () => {
  const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: fixture("bluesky_thread.json") }));
  const e = await threadEngagement(fetchFn, [{ uri: ROOT }, { uri: `at://${WALT}/app.bsky.feed.post/3lpost2` }]);
  assert.equal(calls.length, 1, "every record was in the root read");
  const url = new URL(calls[0].url);
  assert.equal(url.origin, PUBLIC_APPVIEW);
  assert.equal(url.pathname, "/xrpc/app.bsky.feed.getPostThread");
  assert.equal(url.searchParams.get("uri"), ROOT);
  assert.equal(url.searchParams.get("depth"), "6");
  assert.deepEqual(calls[0].headers, {});
  assert.equal(e.likes, 19);
});

test("threadEngagement with a session uses his PDS and token", async () => {
  const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: fixture("bluesky_thread.json") }));
  await threadEngagement(fetchFn, [{ uri: ROOT }], { service: "https://pds.example.com/", accessJwt: "tok" });
  assert.ok(calls[0].url.startsWith("https://pds.example.com/xrpc/app.bsky.feed.getPostThread?"));
  assert.equal(calls[0].headers.Authorization, "Bearer tok");
});

test("threadEngagement reads a long thread's tail from the first record the root read missed", async () => {
  const p = (n: number) => `at://${WALT}/app.bsky.feed.post/p${n}`;
  const records = [{ uri: ROOT }, { uri: p(2) }, { uri: p(3) }, { uri: p(4) }];
  const rootRead = { thread: node(ROOT, WALT, "1", { likeCount: 10 }, [node(p(2), WALT, "2", { likeCount: 1 })]) };
  const tailRead = {
    thread: node(p(3), WALT, "3", { likeCount: 2 }, [
      node(p(4), WALT, "4", { repostCount: 1 }, [node("at://did:plc:dee/app.bsky.feed.post/d", "did:plc:dee", "When did you retire?")]),
    ]),
  };
  const { fetchFn, calls } = fakeFetch((url) => ({
    status: 200,
    body: new URL(url).searchParams.get("uri") === ROOT ? rootRead : tailRead,
  }));
  const e = await threadEngagement(fetchFn, records);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get("uri"), p(3));
  assert.equal(e.likes, 13);
  assert.equal(e.reposts, 1);
  assert.deepEqual(e.replies, [{ author: "@dee.bsky.social", text: "When did you retire?" }]);
});

test("threadEngagement: a deleted root is NotFound; other errors carry the status only", async () => {
  const gone = fakeFetch(() => ({ status: 400, body: { error: "NotFound", message: "Post not found: at://..." } }));
  await assert.rejects(threadEngagement(gone.fetchFn, [{ uri: ROOT }]), (error) => isNotFound(error));

  const blocked = fakeFetch(() => ({ status: 200, body: { thread: { $type: "app.bsky.feed.defs#blockedPost", uri: ROOT, blocked: true } } }));
  await assert.rejects(threadEngagement(blocked.fetchFn, [{ uri: ROOT }]), (error) => isNotFound(error));

  const down = fakeFetch(() => ({ status: 502, body: { error: "UpstreamFailure", message: "secret detail" } }));
  await assert.rejects(threadEngagement(down.fetchFn, [{ uri: ROOT }], { service: "https://pds.example.com", accessJwt: "tok-123" }), (error) => {
    assert.ok(!isNotFound(error));
    const message = (error as Error).message;
    assert.equal(message, "Bluesky getPostThread HTTP 502 (UpstreamFailure)");
    assert.ok(!message.includes("tok-123") && !message.includes("secret"));
    return true;
  });

  await assert.rejects(threadEngagement(down.fetchFn, []), /no root/);
});

function pub(over: Partial<BlueskyPublication> = {}): BlueskyPublication {
  return {
    _id: "pub1",
    postId: "post1",
    status: "posted",
    url: `https://bsky.app/profile/walt.bsky.social/post/3lroot`,
    records: [{ uri: ROOT, cid: "bafyroot" }],
    postedAt: NOW - 2 * DAY,
    _creationTime: NOW - 2 * DAY,
    ...over,
  };
}

test("publicationsToScrape: posted, not removed, has records, last 30 days, newest first", () => {
  const rows = [
    pub({ _id: "old", postedAt: NOW - 31 * DAY }),
    pub({ _id: "removed", removedAt: NOW - DAY }),
    pub({ _id: "failed", status: "failed" }),
    pub({ _id: "removing", status: "removing" }),
    pub({ _id: "noRecords", records: [] }),
    pub({ _id: "older", postedAt: NOW - 10 * DAY }),
    pub({ _id: "newest", postedAt: NOW - DAY }),
    pub({ _id: "noPostedAt", postedAt: undefined, _creationTime: NOW - 5 * DAY }),
  ];
  assert.deepEqual(
    publicationsToScrape(rows, NOW).map((r) => r._id),
    ["newest", "noPostedAt", "older"],
  );
});

test("toUpsertArgs maps a thread to engagement.upsert (likes + reposts, replies as comments)", () => {
  const e = parseThread(fixture("bluesky_thread.json"), WALT);
  const args = toUpsertArgs("elder1", pub(), e);
  assert.deepEqual(args, {
    elderId: "elder1",
    linkedinUrl: "https://bsky.app/profile/walt.bsky.social/post/3lroot",
    platform: "bluesky",
    postId: "post1",
    reactions: 23,
    comments: e.replies,
  });
  // No stored url: built from the root uri.
  assert.equal(publicationUrl(pub({ url: undefined })), `https://bsky.app/profile/${WALT}/post/3lroot`);
  // Reader replies survive engagement.upsert's cleaning as-is.
  assert.deepEqual(cleanComments(args.comments), args.comments);
});

test("a Bluesky scrape counts as changed only when likes/reposts or replies change", () => {
  const e = parseThread(fixture("bluesky_thread.json"), WALT);
  const first = toUpsertArgs("elder1", pub(), e);
  const snap = { reactions: first.reactions, comments: first.comments };
  assert.equal(nextSnapshot(null, snap).changed, true, "new thread with activity");
  assert.equal(nextSnapshot(snap, { ...snap }).changed, false, "same numbers next day");
  assert.equal(nextSnapshot(snap, { ...snap, reactions: snap.reactions + 1 }).changed, true, "a new like");
  const withReply = [...snap.comments, { author: "@eve.bsky.social", text: "What flour did you use?" }];
  assert.equal(nextSnapshot(snap, { reactions: snap.reactions, comments: withReply }).changed, true, "a new reply");
});
