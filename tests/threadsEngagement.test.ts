// Run: npm test
// Threads engagement: insights (root only), replies by others, the upsert mapping. Fakes only.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { FetchFn } from "../convex/lib/blueskyClient.ts";
import { ThreadsHttpError, isThreadsGone } from "../convex/lib/threadsClient.ts";
import {
  MAX_REPLIES,
  MAX_REPLY_CHARS,
  parseConversation,
  parseInsights,
  readThreadsEngagement,
  threadsPublicationsToScrape,
  toThreadsUpsertArgs,
} from "../convex/lib/threadsEngagement.ts";
import { NOW } from "./helpers.ts";

const DAY = 86_400_000;

test("insights: values[0].value per metric (total_value too)", () => {
  const json = {
    data: [
      { name: "likes", period: "lifetime", values: [{ value: 12 }], id: "p1/insights/likes/lifetime" },
      { name: "reposts", period: "lifetime", values: [{ value: 3 }] },
      { name: "quotes", total_value: { value: 2 } },
      { name: "views", values: [{ value: -1 }] },
    ],
  };
  assert.deepEqual(parseInsights(json), { likes: 12, reposts: 3, quotes: 2, views: 0 });
  assert.deepEqual(parseInsights(null), {});
});

test("conversation: only others' visible replies, capped", () => {
  const items = [
    { id: "p2", text: "my own second post", username: "walter" },
    { id: "r1", text: "  Great   story!  ", username: "ana" },
    { id: "r2", text: "thanks all", username: "walter", is_reply_owned_by_me: true },
    { id: "r3", text: "spam", username: "bot", hide_status: "HIDDEN" },
    { id: "r4", text: "covered", username: "x", hide_status: "COVERED" },
    { id: "r5", text: "unhushed is fine", username: "ben", hide_status: "UNHUSHED" },
    { id: "r1", text: "duplicate", username: "ana" },
    { id: "r6", text: "", username: "empty" },
    { id: "r7", text: "no name" },
    { id: "r8", text: "case", username: "Walter" },
  ];
  const { replies, seen } = parseConversation(items, { ids: ["p1", "p2"], username: "walter" });
  assert.deepEqual(replies, [
    { author: "@ana", text: "Great story!" },
    { author: "@ben", text: "unhushed is fine" },
    { author: "Someone", text: "no name" },
  ]);
  assert.equal(seen, 3);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, text: "x".repeat(900), username: `u${i}` }));
  const capped = parseConversation(many, { ids: [] });
  assert.equal(capped.replies.length, MAX_REPLIES);
  assert.equal(capped.seen, 30);
  assert.ok(capped.replies.every((r) => r.text.length <= MAX_REPLY_CHARS));
});

test("read: insights for the root only, conversation of the root", async () => {
  const urls: string[] = [];
  const fetchFn: FetchFn = async (url) => {
    urls.push(url);
    const path = new URL(url).pathname;
    const body =
      path === "/v1.0/p1/insights"
        ? { data: [{ name: "likes", values: [{ value: 5 }] }, { name: "reposts", values: [{ value: 1 }] }] }
        : path === "/v1.0/p1/conversation"
          ? { data: [{ id: "p2", text: "mine" }, { id: "r1", text: "Hello", username: "ana" }], paging: { cursors: { after: "A" } } }
          : {};
    return { ok: true, status: 200, json: async () => body };
  };
  const e = await readThreadsEngagement(fetchFn, { accessToken: "T", userId: "42", username: "walter" }, [{ uri: "p1" }, { uri: "p2" }]);
  assert.deepEqual(e, { likes: 5, reposts: 1, replies: [{ author: "@ana", text: "Hello" }], repliesSeen: 1 });
  assert.equal(urls.filter((u) => u.includes("/insights")).length, 1); // not summed across posts
  assert.ok(new URL(urls[0]).searchParams.get("metric") === "likes,reposts");
});

test("read: a deleted root throws a 'gone' error", async () => {
  const fetchFn: FetchFn = async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 100, error_subcode: 33 } }) });
  await assert.rejects(readThreadsEngagement(fetchFn, { accessToken: "T", userId: "42" }, [{ uri: "p1" }]), (e: unknown) => {
    assert.ok(e instanceof ThreadsHttpError && isThreadsGone(e));
    return true;
  });
});

test("scrape window + upsert args (permalink in linkedinUrl)", () => {
  const rows = [
    { _id: "a", postId: "post1", status: "posted", url: "https://www.threads.com/@walter/post/X", records: [{ uri: "p1", cid: "" }], postedAt: NOW - DAY, _creationTime: NOW - DAY },
    { _id: "b", postId: "post2", status: "removed", records: [{ uri: "p9", cid: "" }], postedAt: NOW - DAY, _creationTime: NOW - DAY },
    { _id: "c", postId: "post3", status: "posted", records: [{ uri: "p8", cid: "" }], postedAt: NOW - 40 * DAY, _creationTime: NOW - 40 * DAY },
  ];
  const pubs = threadsPublicationsToScrape(rows, NOW);
  assert.deepEqual(pubs.map((p) => p._id), ["a"]);
  assert.deepEqual(toThreadsUpsertArgs("elder1", pubs[0], { likes: 4, reposts: 2, replies: [{ author: "@ana", text: "Hi" }], repliesSeen: 1 }), {
    elderId: "elder1",
    linkedinUrl: "https://www.threads.com/@walter/post/X",
    platform: "threads",
    postId: "post1",
    reactions: 6,
    comments: [{ author: "@ana", text: "Hi" }],
  });
});
