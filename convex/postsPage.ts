// TEMPORARY: a read-only page with every generated post, to iterate on the content.
// Served by http.ts at https://<deployment>.convex.site/posts?key=<key>.
//
//   npx convex env set POSTS_PAGE_KEY <long random string>   # the page is off without it
//
// Shows posts newest first: the Bluesky thread as it would be split (post 1/N ...), where each
// platform stands (postPublications: status + link), the call's question and why a post was
// held, with the publish: commands to run. "Fact-check now" (a POST) runs linkedapi.previewPost
// (the fact-check only: nothing is posted, LinkedAPI isn't called).
// Never shows transcripts or phone numbers. Remove this file, lib/postsPage.ts and the /posts
// route in http.ts once posts are reviewed on the platforms themselves. Owner: Brain.

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, internalQuery } from "./_generated/server";
import { splitBlueskyThread } from "./lib/blueskyThread";
import { sameSecret } from "./lib/inbound";
import { firstName } from "./lib/onboarding";
import { renderPostsPage, type PageCheck, type PagePost } from "./lib/postsPage";
import { postLanguage } from "./publish";

declare const process: { env: Record<string, string | undefined> };

const MAX_POSTS = 50;

export const listForPage = internalQuery({
  args: {},
  handler: async (ctx): Promise<PagePost[]> => {
    const posts = await ctx.db.query("posts").order("desc").take(MAX_POSTS);
    return Promise.all(
      posts.map(async (p) => {
        const [elder, call, rows] = await Promise.all([
          ctx.db.get(p.elderId),
          ctx.db.get(p.callId),
          ctx.db.query("postPublications").withIndex("by_post", (q) => q.eq("postId", p._id)).collect(),
        ]);
        // The thread as publish.ts would split it, in the post's language (posts.language).
        const split = splitBlueskyThread(p.text, p.language ?? postLanguage(elder));
        const plan = (call?.plan ?? null) as { question?: unknown } | null;
        return {
          id: p._id,
          createdAt: p._creationTime,
          status: p.status,
          elderFirstName: firstName(elder?.name ?? ""),
          ...(call?.kind ? { kind: call.kind } : {}),
          ...(typeof plan?.question === "string" ? { question: plan.question } : {}),
          text: p.text,
          ...(split.ok ? { thread: split.posts } : { threadProblem: split.reason }),
          publications: rows.map((r) => ({
            id: r._id,
            platform: r.platform,
            status: r.status,
            ...(r.url ? { url: r.url } : {}),
            ...(r.error ? { error: r.error } : {}),
            ...(r.records?.length ? { posts: r.records.length } : {}),
          })),
          ...(p.guardSummary ? { guardSummary: p.guardSummary } : {}),
          ...(p.guardIssues?.length ? { guardIssues: p.guardIssues } : {}),
          ...(p.error ? { error: p.error } : {}),
          ...(p.quality
            ? {
                quality: {
                  score: p.quality.score,
                  passed: p.quality.passed,
                  rounds: p.quality.rounds,
                  notes: p.quality.notes,
                  ...(p.quality.mode ? { mode: p.quality.mode } : {}),
                },
              }
            : {}),
          ...(p.timings ? { timings: p.timings } : {}),
          ...(p.heldFor ? { heldFor: p.heldFor } : {}),
          ...(p.removedAt !== undefined ? { removedAt: p.removedAt } : {}),
          ...(p.removedReason ? { removedReason: p.removedReason } : {}),
        };
      }),
    );
  },
});

export const servePostsPage = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const expected = process.env.POSTS_PAGE_KEY;
  const key = url.searchParams.get("key") ?? "";
  if (!sameSecret(key, expected)) return new Response("Not found", { status: 404 });

  let check: PageCheck | undefined;
  // The fact-check costs a model call: only from the page's POST button, never a GET (link
  // previews and crawlers fetch GETs).
  const checkId = request.method === "POST" ? url.searchParams.get("check") : null;
  if (checkId) {
    try {
      // previewPost validates the id (v.id("posts")); a bad one lands in the catch below
      const preview = await ctx.runAction(internal.linkedapi.previewPost, { postId: checkId as Id<"posts"> });
      check = { postId: checkId, ...preview.guard };
    } catch {
      check = { postId: checkId, error: "Could not run the fact-check (unknown post or model error)." };
    }
  }
  const posts = await ctx.runQuery(internal.postsPage.listForPage, {});
  const replies = await ctx.runQuery(internal.threadReplies.listForPage, {});
  return new Response(renderPostsPage(posts, { key, check, replies }), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
});
