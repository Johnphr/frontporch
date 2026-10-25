// TEMPORARY posts review page (convex/lib/postsPage.ts). Remove with it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { escapeHtml, renderPostsPage, type PagePost } from "../convex/lib/postsPage.ts";

const post: PagePost = {
  id: "p1",
  createdAt: Date.UTC(2026, 9, 24, 18, 30),
  status: "needs_review",
  elderFirstName: "Walter",
  question: "Tell me how you hired Eddie.",
  text: "The oven died <script>alert(1)</script> at 2 a.m.",
  guardSummary: "Unsupported claim",
  guardIssues: ["\"won an award\" isn't in the call"],
};

test("escapeHtml escapes markup and quotes", () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
});

test("renderPostsPage: post text, question, held reason, escaped; key kept in links", () => {
  const html = renderPostsPage([post], { key: "k&1" });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Call question: Tell me how you hired Eddie\./);
  assert.match(html, /Held by fact-check/);
  assert.match(html, /&quot;won an award&quot; isn&#39;t in the call/);
  assert.match(html, /\?key=k%261&amp;check=p1|\?key=k%261&check=p1/);
  assert.match(html, /2026-10-24 18:30 UTC/);
});

test("renderPostsPage: empty state and an on-demand fact-check result", () => {
  assert.match(renderPostsPage([], { key: "k" }), /No posts yet/);
  const html = renderPostsPage([post], {
    key: "k",
    check: { postId: "p1", pass: true, summary: "All supported.", issues: [], mode: "enforce" },
  });
  assert.match(html, /Fact-check now: pass/);
  const other = renderPostsPage([post], { key: "k", check: { postId: "p2", error: "x" } });
  assert.doesNotMatch(other, /Fact-check failed to run/); // only shown on its own post
});

test("renderPostsPage: the Bluesky thread preview (post 1/N) and each platform's status + link", () => {
  const html = renderPostsPage(
    [
      {
        ...post,
        status: "published",
        thread: ["Hook <b>", "Story.", "Question?\n\nDisclosure."],
        publications: [
          { id: "pb1", platform: "bluesky", status: "posted", url: "https://bsky.app/profile/w/post/1", posts: 3 },
          { id: "pb2", platform: "reddit", status: "maybe_posted", error: "Reddit HTTP 503" },
          { id: "pb3", platform: "linkedin", status: "skipped", error: "LinkedIn posting is off (LINKEDIN_POSTING)." },
          { id: "pb4", platform: "x", status: "posted", url: "javascript:alert(1)" },
        ],
      },
    ],
    { key: "k" },
  );
  assert.match(html, /1\/3/);
  assert.match(html, /3\/3/);
  assert.match(html, /Hook &lt;b&gt;/);
  assert.match(html, /Bluesky<\/strong>: <span class="pstatus s-posted">Posted<\/span> \(3 posts\)/);
  assert.match(html, /href="https:\/\/bsky\.app\/profile\/w\/post\/1"/);
  assert.match(html, /Maybe posted: check his profile/);
  assert.match(html, /publish:retryPublication &#39;\{&quot;publicationId&quot;:&quot;pb2&quot;,&quot;approve&quot;:true\}&#39;/);
  assert.match(html, /LinkedIn<\/strong>: <span class="pstatus s-skipped">Off<\/span>/);
  assert.doesNotMatch(html, /javascript:alert/);
  assert.doesNotMatch(html, /linkedapi:approvePost/);
});

test("renderPostsPage: held posts show publish:approvePost; saved posts show publish:publishPost; a thread that doesn't fit says why", () => {
  const held = renderPostsPage([{ ...post, threadProblem: "It needs 6 posts; a thread holds at most 5." }], { key: "k" });
  assert.match(held, /publish:approvePost &#39;\{&quot;postId&quot;:&quot;p1&quot;\}&#39;/);
  assert.match(held, /Doesn't fit a Bluesky thread: It needs 6 posts/);
  const saved = renderPostsPage([{ ...post, status: "pending" }], { key: "k" });
  assert.match(saved, /publish:publishPost &#39;\{&quot;postId&quot;:&quot;p1&quot;\}&#39;/);
  assert.match(saved, /Saved \(not posted\)/);
});

test("statusLabel follows the real state: a post that went out is never 'Saved (not posted)'", async () => {
  const { statusLabel } = await import("../convex/lib/postsPage.ts");
  assert.equal(statusLabel({ status: "pending", publications: [{ id: "a", platform: "bluesky", status: "posted" }] }), "Published");
  assert.equal(statusLabel({ status: "pending", publications: [{ id: "a", platform: "linkedin", status: "pending" }] }), "Posting");
  assert.equal(statusLabel({ status: "posting", publications: [{ id: "a", platform: "bluesky", status: "maybe_posted" }] }), "Maybe posted: check");
  assert.equal(statusLabel({ status: "pending" }), "Saved (not posted)");
  assert.equal(statusLabel({ status: "needs_review", heldFor: "quality" }), "Held: below the quality bar");
});

test("a half-posted thread shows as partly posted, never just 'Failed'", async () => {
  const { statusLabel, publicationLabel } = await import("../convex/lib/postsPage.ts");
  const half = { id: "a", platform: "bluesky", status: "failed", posts: 2, error: "Bluesky post HTTP 400. Posted 2 of 4; a retry continues the thread." };
  assert.equal(statusLabel({ status: "partly_posted", publications: [half] }), "Partly posted");
  assert.equal(statusLabel({ status: "failed", publications: [half] }), "Partly posted", "older rows saved it as failed");
  assert.equal(statusLabel({ status: "failed", publications: [{ id: "a", platform: "bluesky", status: "failed" }] }), "Failed");
  assert.equal(publicationLabel(half), "Partly posted (2 posts out)");
  assert.match(publicationLabel({ ...half, status: "maybe_posted" }), /maybe more: check his profile/);
  const html = renderPostsPage([{ ...post, status: "partly_posted", publications: [half] }], { key: "k" });
  assert.match(html, /Partly posted \(2 posts out\)/);
  assert.match(html, /publish:retryPublication/);
  assert.doesNotMatch(html, />Failed</);
});

test("a thread-fit hold is labelled as one, not as a quality hold", async () => {
  const { statusLabel } = await import("../convex/lib/postsPage.ts");
  assert.equal(statusLabel({ status: "needs_review", heldFor: "thread_fit" }), "Held: too long for a Bluesky thread");
  const html = renderPostsPage([{ ...post, heldFor: "thread_fit" }], { key: "k" });
  assert.match(html, /Held: too long for a Bluesky thread/);
  assert.doesNotMatch(html, /below the quality bar/);
});

test("renderPostsPage: Threads and X rows show their name, status and link", () => {
  const html = renderPostsPage(
    [
      {
        ...post,
        status: "published",
        publications: [
          { id: "t1", platform: "threads", status: "posted", url: "https://www.threads.com/@walter/post/p1", posts: 3 },
          { id: "x1", platform: "x", status: "failed", error: "X HTTP 403.", posts: 1 },
        ],
      },
    ],
    { key: "k" },
  );
  assert.match(html, /<strong>Threads<\/strong>: <span class="pstatus s-posted">Posted<\/span> \(3 posts\) <a href="https:\/\/www\.threads\.com\/@walter\/post\/p1"/);
  assert.match(html, /<strong>X<\/strong>: <span class="pstatus s-failed">Partly posted \(1 post out\)<\/span>/);
  assert.match(html, /publish:retryPublication &#39;\{&quot;publicationId&quot;:&quot;x1&quot;\}&#39;/);
});
