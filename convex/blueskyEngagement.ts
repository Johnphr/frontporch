// How readers reacted to his Bluesky threads (the feedback loop's main source).
//
//   scrapeForElder       daily (schedule.dailyEngagement): for each thread he posted in the
//                        last ~30 days, getPostThread -> likes + reposts on his posts, replies
//                        by others -> engagement:upsert. One failing thread doesn't stop the rest.
//   publicationsForElder his Bluesky postPublications rows (read only; publish.ts writes them)
//
// Reads go to the public AppView (no login needed). Only if that fails for another reason
// than "deleted" do we retry through his PDS with his session (lib/logins.ts), if he has one.
// Pure parsing/mapping: lib/blueskyEngagement.ts. Errors carry HTTP statuses only, never tokens.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalQuery } from "./_generated/server";
import { sharedSessionCache, withSession, type FetchFn } from "./lib/blueskyClient";
import {
  isNotFound,
  publicationsToScrape,
  publicationUrl,
  threadEngagement,
  toUpsertArgs,
  type BlueskyPublication,
  type ThreadEngagement,
} from "./lib/blueskyEngagement";
import { blueskyLoginForElder, type BlueskyLogin } from "./lib/logins";

/** At most this many rows are looked at per run (newest first). */
const MAX_PUBLICATIONS = 100;

export const publicationsForElder = internalQuery({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<BlueskyPublication[]> => {
    const rows = await ctx.db
      .query("postPublications")
      .withIndex("by_elder_platform", (q) => q.eq("elderId", elderId).eq("platform", "bluesky"))
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

type ScrapeResult = {
  threads: number; // recent posted threads looked at
  upserted: number;
  likes: number;
  reposts: number;
  replies: number;
  gone: number; // deleted on Bluesky
  errors: string[];
};

function short(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

export const scrapeForElder = internalAction({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<ScrapeResult> => {
    const rows = await ctx.runQuery(internal.blueskyEngagement.publicationsForElder, { elderId });
    const pubs = publicationsToScrape(rows, Date.now());
    const result: ScrapeResult = { threads: pubs.length, upserted: 0, likes: 0, reposts: 0, replies: 0, gone: 0, errors: [] };
    if (pubs.length === 0) return result;

    const fetchFn = fetch as unknown as FetchFn;
    let login: BlueskyLogin | null | undefined; // looked up only if a public read fails

    const read = async (pub: BlueskyPublication): Promise<ThreadEngagement> => {
      const records = pub.records ?? [];
      try {
        return await threadEngagement(fetchFn, records);
      } catch (error) {
        if (isNotFound(error)) throw error;
        if (login === undefined) login = await blueskyLoginForElder(ctx, elderId);
        if (!login) throw error;
        return await withSession(fetchFn, sharedSessionCache(), login, (s) =>
          threadEngagement(fetchFn, records, { service: s.service, accessJwt: s.accessJwt }),
        );
      }
    };

    for (const pub of pubs) {
      const label = publicationUrl(pub) || String(pub._id);
      let engagement: ThreadEngagement;
      try {
        engagement = await read(pub);
      } catch (error) {
        if (isNotFound(error)) result.gone += 1; // deleted on Bluesky: nothing to read
        else result.errors.push(`${label}: ${short(error)}`);
        continue;
      }
      const args = toUpsertArgs(elderId, pub, engagement);
      if (!args.linkedinUrl) {
        result.errors.push(`${label}: no post link`);
        continue;
      }
      try {
        await ctx.runMutation(internal.engagement.upsert, { ...args, elderId, postId: pub.postId as Id<"posts"> });
        result.upserted += 1;
        result.likes += engagement.likes;
        result.reposts += engagement.reposts;
        result.replies += engagement.replies.length;
      } catch (error) {
        result.errors.push(`engagement:upsert ${label}: ${short(error)}`);
      }
    }
    return result;
  },
});
