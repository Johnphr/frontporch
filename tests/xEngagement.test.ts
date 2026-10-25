// X feedback (lib/xEngagement.ts) with a fake X: which rows are read, metrics parsing,
// reply search (gated, capped, his own left out), read counting, the gates.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseMetrics,
  parseReplies,
  readXEngagement,
  searchUrl,
  xFeedbackOn,
  xPublicationsToRead,
  xRepliesOn,
  type XPublication,
} from "../convex/lib/xEngagement.ts";
import type { FetchFn } from "../convex/lib/xOAuth.ts";
import { NOW } from "./helpers.ts";

const DAY = 86_400_000;
const login = { accessToken: "AT", userId: "42", username: "joe" };

function pub(id: string, root: string, ageDays: number, over: Partial<XPublication> = {}): XPublication {
  return { _id: id, postId: `p-${id}`, status: "posted", _creationTime: NOW - ageDays * DAY, postedAt: NOW - ageDays * DAY, records: [{ uri: root, cid: "" }, { uri: `${root}9`, cid: "" }], ...over };
}

test("gates: both reads are off by default", () => {
  assert.equal(xFeedbackOn({}), false);
  assert.equal(xRepliesOn({}), false);
  assert.equal(xFeedbackOn({ X_READ_FEEDBACK: "on" }), true);
  assert.equal(xRepliesOn({ X_READ_REPLIES: "on" }), true);
});

test("rows to read: posted, not removed, numeric root, last 30 days, newest first", () => {
  const rows = [
    pub("a", "1", 3),
    pub("b", "2", 1),
    pub("old", "3", 31),
    pub("removed", "4", 1, { removedAt: NOW }),
    pub("failed", "5", 1, { status: "failed" }),
    pub("bsky", "at://did/x", 1),
  ];
  assert.deepEqual(xPublicationsToRead(rows, NOW).map((r) => r._id), ["b", "a"]);
});

test("metrics parsing: counts per id, gone ids, junk ignored", () => {
  const out = parseMetrics({
    data: [
      { id: "1", text: "...", public_metrics: { like_count: 5, retweet_count: 2, quote_count: 1, reply_count: 3, impression_count: 900 } },
      { id: "2", public_metrics: { like_count: -4, retweet_count: "x" } },
    ],
    errors: [{ resource_id: "3", title: "Not Found Error", type: "https://api.twitter.com/2/problems/resource-not-found" }],
  });
  assert.deepEqual(out.metrics.get("1"), { likes: 5, retweets: 2, quotes: 1, replies: 3 });
  assert.deepEqual(out.metrics.get("2"), { likes: 0, retweets: 0, quotes: 0, replies: 0 });
  assert.deepEqual([...out.gone], ["3"]);
  assert.equal(out.returned, 2);
  assert.equal(parseMetrics(null).metrics.size, 0);
});

test("reply parsing: others only, leading @handles dropped, capped at 10", () => {
  const data = [
    { id: "a", author_id: "42", text: "my own reply" },
    { id: "b", author_id: "7", text: "@joe @other What a story, thank you." },
    ...Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, author_id: "8", text: `reply ${i}` })),
  ];
  const out = parseReplies({ data, includes: { users: [{ id: "7", username: "mary" }] } }, "42");
  assert.equal(out.replies.length, 10);
  assert.deepEqual(out.replies[0], { author: "@mary", text: "What a story, thank you." });
  assert.equal(out.replies[1].author, "an X reader");
  assert.ok(!out.replies.some((r) => r.text === "my own reply"));
  assert.equal(out.returned, 15);
});

test("search query: the conversation, minus him, at most 10", () => {
  const url = new URL(searchUrl("100", "42"));
  assert.equal(url.pathname, "/2/tweets/search/recent");
  assert.equal(url.searchParams.get("query"), "conversation_id:100 -from:42 -is:retweet");
  assert.equal(url.searchParams.get("max_results"), "10");
});

function fakeX(handler: (url: string) => { status: number; body: unknown } | "throw") {
  const calls: string[] = [];
  const fetchFn: FetchFn = async (url) => {
    calls.push(url);
    const r = handler(url);
    if (r === "throw") throw new Error("aborted");
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  };
  return { fetchFn, calls };
}

const metricsBody = {
  data: [
    { id: "1", public_metrics: { like_count: 4, retweet_count: 1, quote_count: 0, reply_count: 2 } },
    { id: "2", public_metrics: { like_count: 1, retweet_count: 0, quote_count: 1, reply_count: 0 } },
  ],
  errors: [{ resource_id: "3", title: "Not Found Error" }],
};

test("metrics only (X_READ_REPLIES off): one batched read, reactions = likes + retweets + quotes", async () => {
  const { fetchFn, calls } = fakeX(() => ({ status: 200, body: metricsBody }));
  const out = await readXEngagement(fetchFn, login, [pub("a", "1", 1), pub("b", "2", 10), pub("c", "3", 2)], { replies: false, now: NOW });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/2\/tweets\?ids=1,2,3&tweet\.fields=public_metrics$/);
  assert.deepEqual(out.items.map((i) => [i.pub._id, i.reactions, i.commentsKnown, i.url]), [
    ["a", 5, false, "https://x.com/joe/status/1"],
    ["b", 2, false, "https://x.com/joe/status/2"],
  ]);
  assert.equal(out.gone, 1);
  assert.equal(out.reads, 2);
});

test("with replies on: searches only posts from the last 7 days, counts the reads", async () => {
  const { fetchFn, calls } = fakeX((url) =>
    url.includes("/search/recent")
      ? { status: 200, body: { data: [{ id: "r1", author_id: "7", text: "Lovely" }], includes: { users: [{ id: "7", username: "mary" }] } } }
      : { status: 200, body: metricsBody },
  );
  const out = await readXEngagement(fetchFn, login, [pub("a", "1", 1), pub("b", "2", 10)], { replies: true, now: NOW });
  assert.equal(calls.filter((c) => c.includes("/search/recent")).length, 1, "post b is past the 7-day search window");
  const a = out.items.find((i) => i.pub._id === "a")!;
  assert.deepEqual(a.comments, [{ author: "@mary", text: "Lovely" }]);
  assert.equal(a.commentsKnown, true);
  assert.equal(out.items.find((i) => i.pub._id === "b")!.commentsKnown, false, "old post keeps its stored comments");
  assert.equal(out.reads, 2 + 2);
});

test("a failed metrics read reports a status and upserts nothing", async () => {
  const { fetchFn } = fakeX(() => ({ status: 429, body: {} }));
  const out = await readXEngagement(fetchFn, login, [pub("a", "1", 1)], { replies: true, now: NOW });
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.errors, ["X metrics HTTP 429"]);
  const down = await readXEngagement(fakeX(() => "throw").fetchFn, login, [pub("a", "1", 1)], { replies: false, now: NOW });
  assert.deepEqual(down.errors, ["X metrics: network error or timeout"]);
});
