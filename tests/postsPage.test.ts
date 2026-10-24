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
