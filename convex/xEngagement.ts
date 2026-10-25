// How readers reacted to his X posts (only when X_READ_FEEDBACK=on: X bills every read).
//
//   scrapeForElder       daily (schedule.dailyEngagement), and every 5 min with days: 2 when
//                        FAST_POST=on (schedule.recentEngagement): his posted X publications from
//                        the window (default 30 days, not removed) -> likes + retweets + quotes on the root post;
//                        reply texts too only with X_READ_REPLIES=on (posts < 7 days old, max 10
//                        each) -> engagement:upsert with platform "x". Logs the estimated reads.
//   publicationsForElder his X postPublications rows (read only; publish.ts writes them)
//
// Reads use his own token (lib/xLogin.ts). Pure parts: lib/xEngagement.ts. No tokens or texts in logs.
// Env: X_READ_FEEDBACK, X_READ_REPLIES (+ the X login variables in xAuth.ts).

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalQuery } from "./_generated/server";
import { scrapeDays } from "./lib/blueskyEngagement";
import { readXEngagement, xFeedbackOn, xPublicationsToRead, xRepliesOn, type XPublication } from "./lib/xEngagement";
import { xLoginForElder } from "./lib/xLogin";
import type { FetchFn } from "./lib/xOAuth";

declare const process: { env: Record<string, string | undefined> };

const MAX_PUBLICATIONS = 100;
const HTTP_TIMEOUT_MS = 20_000;

// engagement.upsert (platform "x"), referenced by name with this file's arg type.
const upsertEngagement = makeFunctionReference<
  "mutation",
  {
    elderId: Id<"elders">;
    linkedinUrl: string;
    platform: "x";
    postId: Id<"posts">;
    reactions: number;
    comments: { author: string; text: string }[];
    commentsKnown: boolean;
  }
>("engagement:upsert");

const timedFetch: FetchFn = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

export const publicationsForElder = internalQuery({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<XPublication[]> => {
    const rows = await ctx.db
      .query("postPublications")
      .withIndex("by_elder_platform", (q) => q.eq("elderId", elderId).eq("platform", "x"))
      .order("desc")
      .take(MAX_PUBLICATIONS);
    return rows.map((r) => ({
      _id: r._id,
      postId: r.postId,
      status: r.status,
      _creationTime: r._creationTime,
      ...(r.url !== undefined ? { url: r.url } : {}),
      ...(r.records !== undefined ? { records: r.records } : {}),
      ...(r.postedAt !== undefined ? { postedAt: r.postedAt } : {}),
      ...(r.removedAt !== undefined ? { removedAt: r.removedAt } : {}),
    }));
  },
});

type ScrapeResult = { skipped?: string; posts: number; upserted: number; reactions: number; replies: number; gone: number; reads: number; errors: string[] };

export const scrapeForElder = internalAction({
  // days: only posts from the last `days` (the 5-min recent cron passes 2). Default 30.
  args: { elderId: v.id("elders"), days: v.optional(v.number()) },
  handler: async (ctx, { elderId, days }): Promise<ScrapeResult> => {
    const result: ScrapeResult = { posts: 0, upserted: 0, reactions: 0, replies: 0, gone: 0, reads: 0, errors: [] };
    if (!xFeedbackOn(process.env)) return { ...result, skipped: "X_READ_FEEDBACK is off" };
    const rows = await ctx.runQuery(internal.xEngagement.publicationsForElder, { elderId });
    const pubs = xPublicationsToRead(rows, Date.now(), scrapeDays(days));
    result.posts = pubs.length;
    if (!pubs.length) return result;
    const login = await xLoginForElder(ctx, elderId, { fetchFn: timedFetch });
    if (!login) return { ...result, skipped: "no X login" };

    const read = await readXEngagement(timedFetch, login, pubs, { replies: xRepliesOn(process.env), now: Date.now() });
    result.reads = read.reads;
    result.gone = read.gone;
    result.errors.push(...read.errors);
    for (const item of read.items) {
      try {
        await ctx.runMutation(upsertEngagement, {
          elderId,
          linkedinUrl: item.url,
          platform: "x",
          postId: item.pub.postId as Id<"posts">,
          reactions: item.reactions,
          comments: item.comments,
          commentsKnown: item.commentsKnown,
        });
        result.upserted += 1;
        result.reactions += item.reactions;
        result.replies += item.comments.length;
      } catch (error) {
        result.errors.push(`engagement:upsert ${item.pub._id}: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`);
      }
    }
    console.log(`xEngagement: elder ${elderId} posts=${result.posts} upserted=${result.upserted} gone=${result.gone} estimatedReads=${result.reads} errors=${result.errors.length}`);
    return result;
  },
});
