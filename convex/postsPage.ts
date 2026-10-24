// TEMPORARY: a read-only page with every generated post, to iterate on the content before
// LinkedIn is connected. Served by http.ts at https://<deployment>.convex.site/posts?key=<key>.
//
//   npx convex env set POSTS_PAGE_KEY <long random string>   # the page is off without it
//
// Shows posts newest first, as they would be published, with the call's question and why the
// fact-check held them. "Fact-check now" runs linkedapi.previewPost (nothing is posted).
// Never shows transcripts or phone numbers. Remove this file, lib/postsPage.ts and the /posts
// route in http.ts once posts are reviewed on LinkedIn itself. Owner: Brain.

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, internalQuery } from "./_generated/server";
import { prepareLinkedInText } from "./lib/linkedinPost";
import { firstName } from "./lib/onboarding";
import { renderPostsPage, type PageCheck, type PagePost } from "./lib/postsPage";

declare const process: { env: Record<string, string | undefined> };

const MAX_POSTS = 50;

export const listForPage = internalQuery({
  args: {},
  handler: async (ctx): Promise<PagePost[]> => {
    const posts = await ctx.db.query("posts").order("desc").take(MAX_POSTS);
    return Promise.all(
      posts.map(async (p) => {
        const [elder, call] = await Promise.all([ctx.db.get(p.elderId), ctx.db.get(p.callId)]);
        let text = p.text;
        try {
          text = prepareLinkedInText(p.text).text;
        } catch {
          // empty or oversized draft: show it raw
        }
        const plan = (call?.plan ?? null) as { question?: unknown } | null;
        return {
          id: p._id,
          createdAt: p._creationTime,
          status: p.status,
          elderFirstName: firstName(elder?.name ?? ""),
          ...(call?.kind ? { kind: call.kind } : {}),
          ...(typeof plan?.question === "string" ? { question: plan.question } : {}),
          text,
          ...(p.guardSummary ? { guardSummary: p.guardSummary } : {}),
          ...(p.guardIssues?.length ? { guardIssues: p.guardIssues } : {}),
          ...(p.error ? { error: p.error } : {}),
        };
      }),
    );
  },
});

export const servePostsPage = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const expected = process.env.POSTS_PAGE_KEY;
  const key = url.searchParams.get("key") ?? "";
  if (!expected || key !== expected) return new Response("Not found", { status: 404 });

  let check: PageCheck | undefined;
  const checkId = url.searchParams.get("check");
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
  return new Response(renderPostsPage(posts, { key, check }), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
});
