// Run: node --test tests/   (Node 22.18+ / 24 strips TypeScript types natively)
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  blueskyItem,
  blueskyItemsFromSearch,
  clampGraphemes,
  graphemeCount,
  parseAtUri,
  postWebUrl,
  replyRefFor,
  searchPostsQuery,
} from "../convex/lib/bluesky.ts";
import { createReply, createSession, getPost, searchPosts, type FetchFn } from "../convex/lib/blueskyClient.ts";
import { SOURCES, processItems } from "../convex/lib/questionSources.ts";

const URI = "at://did:plc:abc123/app.bsky.feed.post/3kq2xyz";
const NOW = Date.parse("2026-10-24T12:00:00Z");

const postView = (over: Record<string, unknown> = {}) => ({
  uri: URI,
  cid: "bafyquestion",
  author: { did: "did:plc:abc123", handle: "maria.bsky.social" },
  record: { text: "How do you price custom cakes when you're just starting out?", createdAt: "2026-10-20T10:00:00Z" },
  likeCount: 4,
  repostCount: 1,
  replyCount: 2,
  indexedAt: "2026-10-20T10:00:05Z",
  ...over,
});

test("postWebUrl / parseAtUri", () => {
  assert.deepEqual(parseAtUri(URI), { repo: "did:plc:abc123", collection: "app.bsky.feed.post", rkey: "3kq2xyz" });
  assert.equal(postWebUrl(URI, "maria.bsky.social"), "https://bsky.app/profile/maria.bsky.social/post/3kq2xyz");
  assert.equal(postWebUrl(URI), "https://bsky.app/profile/did%3Aplc%3Aabc123/post/3kq2xyz");
  assert.equal(postWebUrl("at://did:plc:x/app.bsky.feed.like/1"), undefined, "only posts");
  assert.equal(parseAtUri("https://bsky.app/x"), undefined);
});

test("blueskyItem maps a PostView to an audience-question item (keeps the at:// uri)", () => {
  const item = blueskyItem(postView());
  assert.equal(item?.title, "How do you price custom cakes when you're just starting out?");
  assert.equal(item?.url, "https://bsky.app/profile/maria.bsky.social/post/3kq2xyz");
  assert.equal(item?.atUri, URI);
  assert.equal(item?.score, 5);
  assert.equal(item?.answers, 2);
  assert.equal(blueskyItem({ uri: URI, record: { text: "" } }), null, "empty text dropped");
  assert.deepEqual(blueskyItemsFromSearch({ posts: [postView(), { nope: 1 }] }).length, 1);
  assert.deepEqual(blueskyItemsFromSearch(null), []);
});

test("Bluesky questions go through the shared filters and keep atUri", () => {
  const source = SOURCES.find((s) => s.name === "bluesky-search");
  assert.ok(source);
  const items = blueskyItemsFromSearch({
    posts: [
      postView(),
      postView({ uri: "at://did:plc:abc123/app.bsky.feed.post/2", record: { text: "Great day at the bakery today!", createdAt: "2026-10-20T10:00:00Z" } }),
    ],
  });
  const { kept, dropped } = processItems(items, source, ["bakery"], NOW);
  assert.equal(kept.length, 1, `kept one question (dropped: ${JSON.stringify(dropped)})`);
  assert.equal(kept[0].source, "bluesky");
  assert.equal(kept[0].atUri, URI);
  assert.equal(kept[0].community, "Bluesky");
});

test("replyRefFor: a top-level post is both root and parent; a reply keeps its thread root", () => {
  assert.deepEqual(replyRefFor(postView()), {
    root: { uri: URI, cid: "bafyquestion" },
    parent: { uri: URI, cid: "bafyquestion" },
  });
  const rootRef = { uri: "at://did:plc:root/app.bsky.feed.post/1", cid: "bafyroot" };
  const nested = postView({
    record: { text: "Any tips?", createdAt: "2026-10-20T10:00:00Z", reply: { root: rootRef, parent: { uri: "at://x/app.bsky.feed.post/9", cid: "c9" } } },
  });
  assert.deepEqual(replyRefFor(nested), { root: rootRef, parent: { uri: URI, cid: "bafyquestion" } });
  assert.equal(replyRefFor({ uri: URI }), undefined, "no cid -> can't reply");
});

test("graphemes: counts and clamps without splitting emoji", () => {
  assert.equal(graphemeCount("héllo👍🏽"), 6);
  const long = `${"word ".repeat(80)}end`;
  const cut = clampGraphemes(long, 50);
  assert.ok(graphemeCount(cut) <= 50);
  assert.ok(cut.endsWith("…"));
  const emoji = "👨‍👩‍👧".repeat(20);
  const cutEmoji = clampGraphemes(emoji, 10);
  assert.ok(graphemeCount(cutEmoji) <= 10);
  assert.ok(!cutEmoji.includes("‍…"), "no half family emoji");
  assert.equal(clampGraphemes("short", 50), "short");
});

test("searchPostsQuery", () => {
  const q = new URLSearchParams(searchPostsQuery("cake pricing", { limit: 500, since: "2026-10-01T00:00:00Z" }));
  assert.equal(q.get("q"), "cake pricing");
  assert.equal(q.get("sort"), "latest");
  assert.equal(q.get("limit"), "100");
  assert.equal(q.get("since"), "2026-10-01T00:00:00Z");
});

test("client: session -> search -> getPost -> createReply (requests and parsing)", async () => {
  const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, ...init });
    const json = url.includes("createSession")
      ? { accessJwt: "tok", did: "did:plc:him", handle: "walter.bsky.social" }
      : url.includes("searchPosts")
        ? { posts: [postView()] }
        : url.includes("getPosts")
          ? { posts: [postView()] }
          : { uri: "at://did:plc:him/app.bsky.feed.post/new1", cid: "bafynew" };
    return { ok: true, status: 200, json: async () => json };
  };
  const s = await createSession(fetchFn, { service: "https://bsky.social", identifier: "walter.bsky.social", password: "app-pass" });
  assert.equal(s.did, "did:plc:him");
  const items = await searchPosts(fetchFn, s, "bakery");
  assert.equal(items.length, 1);
  assert.equal(calls[1].headers?.Authorization, "Bearer tok");
  const post = await getPost(fetchFn, s, URI);
  const ref = replyRefFor(post);
  assert.ok(ref);
  const created = await createReply(fetchFn, s, { text: "hi", langs: ["en"], reply: ref, now: new Date(NOW) });
  assert.equal(created.uri, "at://did:plc:him/app.bsky.feed.post/new1");
  const body = JSON.parse(calls[3].body ?? "{}");
  assert.equal(body.repo, "did:plc:him");
  assert.equal(body.collection, "app.bsky.feed.post");
  assert.deepEqual(body.record.reply, ref);
  assert.equal(body.record.createdAt, new Date(NOW).toISOString());
  assert.ok(!JSON.stringify(calls.map((c) => c.url)).includes("app-pass"), "password never in a url");
});

test("client: login failure surfaces only the status", async () => {
  const fetchFn: FetchFn = async () => ({ ok: false, status: 401, json: async () => ({ error: "AuthFactorTokenRequired" }) });
  await assert.rejects(
    createSession(fetchFn, { service: "https://bsky.social", identifier: "x", password: "secret-pass" }),
    (e: Error) => e.message === "Bluesky login HTTP 401" && !e.message.includes("secret"),
  );
});
