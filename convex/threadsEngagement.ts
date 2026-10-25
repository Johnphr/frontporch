// How readers reacted to his Threads threads (like blueskyEngagement.ts).
//
//   scrapeForElder       daily (schedule.dailyEngagement, once wired): for each Threads thread he
//                        posted in the last 30 days -> likes + reposts on the root, replies by
//                        others -> engagement:upsert (platform "threads"). One failing thread
//                        doesn't stop the rest. Needs his Threads login (lib/threadsLogin.ts).
//   publicationsForElder his Threads postPublications rows (read only; publish.ts writes them)
// Pure parsing: lib/threadsEngagement.ts. Errors carry HTTP statuses only, never tokens.

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalQuery } from "./_generated/server";
import type { FetchFn } from "./lib/blueskyClient";
import { isThreadsAuthError, isThreadsGone } from "./lib/threadsClient";
import {
  readThreadsEngagement,
  threadsPublicationsToScrape,
  toThreadsUpsertArgs,
  type ThreadsEngagement,
  type ThreadsPublication,
  type ThreadsUpsertArgs,
} from "./lib/threadsEngagement";
import { reportThreadsLoginError, threadsLoginForElder } from "./lib/threadsLogin";

const MAX_PUBLICATIONS = 100;

// engagement.upsert takes platform "threads" once its validator is widened (see the wiring notes).
const upsertEngagement = makeFunctionReference<"mutation", Omit<ThreadsUpsertArgs, "elderId" | "postId"> & { elderId: Id<"elders">; postId: Id<"posts"> }>(
  "engagement:upsert",
);

const timedFetch: FetchFn = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

export const publicationsForElder = internalQuery({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<ThreadsPublication[]> => {
    const rows = await ctx.db
      .query("postPublications")
      .withIndex("by_elder_platform", (q) => q.eq("elderId", elderId).eq("platform", "threads"))
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

type ScrapeResult = { threads: number; upserted: number; likes: number; reposts: number; replies: number; gone: number; errors: string[] };

const short = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export const scrapeForElder = internalAction({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<ScrapeResult> => {
    const rows = await ctx.runQuery(internal.threadsEngagement.publicationsForElder, { elderId });
    const pubs = threadsPublicationsToScrape(rows, Date.now());
    const result: ScrapeResult = { threads: pubs.length, upserted: 0, likes: 0, reposts: 0, replies: 0, gone: 0, errors: [] };
    if (pubs.length === 0) return result;
    const login = await threadsLoginForElder(ctx, elderId, { fetchFn: timedFetch });
    if (!login) {
      result.errors.push("no Threads login");
      return result;
    }

    for (const pub of pubs) {
      const label = pub.url || String(pub._id);
      let e: ThreadsEngagement;
      try {
        e = await readThreadsEngagement(timedFetch, login, pub.records ?? []);
      } catch (error) {
        if (isThreadsGone(error)) {
          result.gone += 1;
          continue;
        }
        result.errors.push(`${label}: ${short(error)}`);
        if (isThreadsAuthError(error)) {
          await reportThreadsLoginError(ctx, elderId, error);
          break; // the rest would fail the same way
        }
        continue;
      }
      const args = toThreadsUpsertArgs(elderId, pub, e);
      if (!args.linkedinUrl) {
        result.errors.push(`${label}: no post link`);
        continue;
      }
      try {
        await ctx.runMutation(upsertEngagement, { ...args, elderId, postId: pub.postId as Id<"posts"> });
        result.upserted += 1;
        result.likes += e.likes;
        result.reposts += e.reposts;
        result.replies += e.replies.length;
      } catch (error) {
        result.errors.push(`engagement:upsert ${label}: ${short(error)}`);
      }
    }
    return result;
  },
});
