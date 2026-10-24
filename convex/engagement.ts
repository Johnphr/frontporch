// How readers reacted to his LinkedIn posts.
//
//   upsert          called by apify.scrapeEngagement once per post: keeps the latest
//                   snapshot, links it to our posts row by canonical URL, and when
//                   something changed schedules conversation.refreshQuestionBank
//                   (debounced: at most once per elder every 10 minutes, 2 minutes
//                   after the first change so the whole scrape run lands first)
//   recentFeedback  posts whose reactions/comments changed recently, for the planner
//
// Owner: Core: Data.

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  BANK_REFRESH_DELAY_MS,
  cleanComments,
  feedbackWindowStart,
  nextSnapshot,
  shouldRefreshBank,
} from "./lib/engagementRules";
import { canonicalLinkedInPostUrl } from "./lib/linkedinUrl";

// Implemented by Core: Brain in conversation.ts. Referenced by name so this file
// doesn't depend on their generated types while both are in flight.
const refreshQuestionBank = makeFunctionReference<"action">("conversation:refreshQuestionBank");

const commentValidator = v.object({ author: v.string(), text: v.string() });

export const upsert = internalMutation({
  args: {
    elderId: v.id("elders"),
    linkedinUrl: v.string(),
    reactions: v.number(),
    comments: v.array(commentValidator),
    // false when the source only had counts (apify's backup Actor): keep stored comments.
    commentsKnown: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ engagementId: Id<"engagement">; changed: boolean; refreshScheduled: boolean }> => {
    const linkedinUrl = canonicalLinkedInPostUrl(args.linkedinUrl);
    if (!linkedinUrl) throw new Error("engagement.upsert: empty linkedinUrl");
    const now = Date.now();
    const reactions = Number.isFinite(args.reactions) ? Math.max(0, args.reactions) : 0;
    const scraped = cleanComments(args.comments);

    const existing = (
      await ctx.db
        .query("engagement")
        .withIndex("by_url", (q) => q.eq("linkedinUrl", linkedinUrl))
        .collect()
    ).find((row) => row.elderId === args.elderId);

    const post = (
      await ctx.db
        .query("posts")
        .withIndex("by_url", (q) => q.eq("linkedinUrl", linkedinUrl))
        .collect()
    ).find((row) => row.elderId === args.elderId);

    const { comments, changed } = nextSnapshot(
      existing ?? null,
      { reactions, comments: scraped },
      args.commentsKnown ?? true,
    );

    let engagementId: Id<"engagement">;
    if (existing) {
      engagementId = existing._id;
      await ctx.db.patch(existing._id, {
        reactions,
        comments,
        scrapedAt: now,
        ...(changed ? { changedAt: now } : {}),
        ...(post && !existing.postId ? { postId: post._id } : {}),
      });
    } else {
      engagementId = await ctx.db.insert("engagement", {
        elderId: args.elderId,
        ...(post ? { postId: post._id } : {}),
        linkedinUrl,
        reactions,
        comments,
        scrapedAt: now,
        ...(changed ? { changedAt: now } : {}),
      });
    }

    let refreshScheduled = false;
    if (changed) {
      const elder = await ctx.db.get(args.elderId);
      if (elder && shouldRefreshBank(elder.lastBankRefreshAt, now)) {
        try {
          await ctx.scheduler.runAfter(BANK_REFRESH_DELAY_MS, refreshQuestionBank, { elderId: args.elderId });
          await ctx.db.patch(args.elderId, { lastBankRefreshAt: now });
          refreshScheduled = true;
        } catch (error) {
          // conversation.refreshQuestionBank not deployed yet: keep the snapshot anyway.
          console.warn(`engagement.upsert: couldn't schedule refreshQuestionBank: ${String(error)}`);
        }
      }
    }

    return { engagementId, changed, refreshScheduled };
  },
});

export type Feedback = {
  linkedinUrl: string;
  postText?: string;
  reactions: number;
  comments: { author: string; text: string }[];
  scrapedAt: number;
  changedAt: number;
};

export const recentFeedback = internalQuery({
  args: { elderId: v.id("elders"), sinceDays: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Feedback[]> => {
    // Filter on changedAt, not scrapedAt: the daily scrape re-touches scrapedAt on
    // every recent post, so old comments would look fresh every week.
    const since = feedbackWindowStart(Date.now(), args.sinceDays);
    const rows = await ctx.db
      .query("engagement")
      .withIndex("by_elder_changed", (q) => q.eq("elderId", args.elderId).gte("changedAt", since))
      .order("desc")
      .take(50);
    return await Promise.all(
      rows.map(async (row): Promise<Feedback> => {
        const post = row.postId ? await ctx.db.get(row.postId) : null;
        return {
          linkedinUrl: row.linkedinUrl,
          ...(post?.text ? { postText: post.text } : {}),
          reactions: row.reactions,
          comments: row.comments,
          scrapedAt: row.scrapedAt,
          changedAt: row.changedAt ?? row.scrapedAt,
        };
      }),
    );
  },
});
