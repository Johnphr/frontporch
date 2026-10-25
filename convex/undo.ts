// Undo: take a post (and its thread replies) back down. Posting is automatic, so this is the
// safety valve: "Pip, please take down that last post." Rules: lib/undo.ts.
//
//   removePost({ postId, reason? })   posts.removedAt first (publish.ts never sends a post with
//                                     it set), then every postPublications row: never-posted
//                                     rows -> removed; posted ones deleted on Bluesky / Reddit;
//                                     LinkedIn -> "manual" (no delete API). An in-flight
//                                     `posting` row is left: publish.ts calls us again after.
//                                     -> { removed, failed, manual, waiting }
//   removeReply({ replyId, reason? }) the same for one thread reply (Bluesky deleteRecord on
//                                     postedUri; Reddit /api/del by the comment's fullname)
//   removeLatest({ elderId, reason?, askedOnCallId? })   his newest post that went out (last
//                                     14 days) + the thread replies from that call. The phone
//                                     path: pipeline.processCall runs it when he asked on a call
//                                     (askedOnCallId: not that call's post, nothing newer than it).
//   markRemovedByHand({ publicationId } | { postId })    after someone removed a LinkedIn post by hand
//
// Family / admin:  npx convex run undo:removePost '{"postId":"..."}'
//                  npx convex run undo:removeLatest '{"elderId":"..."}'
// Safe to run twice. His logins come ONLY from lib/logins.ts. Never log tokens, passwords,
// post text or reply text; ids, platforms and statuses only.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { findOwnReply, sharedSessionCache, withSession, type FetchFn } from "./lib/blueskyClient";
import { deleteBlueskyThread, type DeleteOutcome } from "./lib/blueskyDelete";
import { blueskyLoginForElder, redditLoginForElder } from "./lib/logins";
import {
  LATEST_WINDOW_MS,
  MANUAL_REPLY_NOTE,
  claimPatch,
  cleanReason,
  deleteRedditThing,
  finishPatch,
  legacyLinkedinEntry,
  pickLatestPost,
  postRemovalPatch,
  publicationStep,
  replyDeleteTarget,
  replyStep,
  runRemoval,
  summaryLine,
  type Entry,
  type LatestCandidate,
  type Platform,
  type RemovalResult,
} from "./lib/undo";

const HTTP_TIMEOUT_MS = 20_000;

const EMPTY: RemovalResult = { removed: [], failed: [], manual: [], waiting: [] };

/** fetch with a timeout (AbortController); a timeout surfaces as a thrown error. */
const timedFetch: FetchFn = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

// ---------- posts ----------

/**
 * One transaction: mark the post removed (so nothing new goes out), then claim every
 * publication row. Returns what the action still has to delete on the platforms.
 */
export const claimPostRemoval = internalMutation({
  args: { postId: v.id("posts"), reason: v.optional(v.string()) },
  handler: async (ctx, { postId, reason }): Promise<{ found: false } | { found: true; elderId: Id<"elders">; entries: Entry[] }> => {
    const post = await ctx.db.get(postId);
    if (!post) return { found: false };
    const now = Date.now();
    await ctx.db.patch(postId, postRemovalPatch(post, reason, now));
    const rows = await ctx.db
      .query("postPublications")
      .withIndex("by_post", (q) => q.eq("postId", postId))
      .collect();
    const entries: Entry[] = [];
    for (const row of rows) {
      const step = publicationStep(row, now);
      const patch = claimPatch(step, now);
      if (patch) await ctx.db.patch(row._id, patch);
      entries.push({
        id: row._id,
        platform: row.platform,
        ...(row.url ? { url: row.url } : {}),
        step,
        ...(row.records?.length ? { uris: row.records.map((r) => r.uri) } : {}),
        ...(row.externalId ? { externalId: row.externalId } : {}),
      });
    }
    const legacy = legacyLinkedinEntry(post, rows);
    if (legacy) entries.push(legacy);
    return { found: true, elderId: post.elderId, entries };
  },
});

const previousStatus = v.union(v.literal("posted"), v.literal("maybe_posted"));

/** After the platform delete: removed, or back to the previous status with a short error. */
export const finishPublication = internalMutation({
  args: { publicationId: v.id("postPublications"), previous: previousStatus, ok: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, { publicationId, previous, ok, error }) => {
    const row = await ctx.db.get(publicationId);
    if (!row || row.status !== "removing") return; // someone else finished it
    const outcome: DeleteOutcome = ok ? { ok: true, deleted: 0, alreadyGone: 0 } : { ok: false, error: error ?? "unknown error" };
    await ctx.db.patch(publicationId, finishPatch(previous, outcome, Date.now()));
  },
});

/** Delete one platform copy (Bluesky thread or Reddit post) with his login. */
async function deleteOnPlatform(
  ctx: Parameters<typeof blueskyLoginForElder>[0],
  elderId: Id<"elders">,
  e: { platform: Platform; uris?: string[]; externalId?: string },
): Promise<DeleteOutcome> {
  if (e.platform === "bluesky") {
    return deleteBlueskyThread(timedFetch, sharedSessionCache(), await blueskyLoginForElder(ctx, elderId), e.uris ?? []);
  }
  if (e.platform === "reddit") return deleteRedditThing(timedFetch, await redditLoginForElder(ctx, elderId), e.externalId);
  return { ok: false, error: `No delete for ${e.platform}.` };
}

/**
 * Take a post down everywhere it went. Contract with publish.ts: called with { postId } when it
 * finds removedAt set right after posting.
 *   npx convex run undo:removePost '{"postId":"..."}'
 */
export const removePost = internalAction({
  args: { postId: v.id("posts"), reason: v.optional(v.string()) },
  handler: async (ctx, { postId, reason }): Promise<RemovalResult> => {
    const claim = await ctx.runMutation(internal.undo.claimPostRemoval, { postId, reason: cleanReason(reason) });
    if (!claim.found) return { ...EMPTY, failed: ["Post not found."] };
    const { elderId } = claim;
    const result = await runRemoval(claim.entries, {
      remove: (e) => deleteOnPlatform(ctx, elderId, e),
      finish: async (e, outcome) => {
        await ctx.runMutation(internal.undo.finishPublication, {
          publicationId: e.id as Id<"postPublications">,
          previous: e.step.previous,
          ok: outcome.ok,
          ...(outcome.ok ? {} : { error: outcome.error }),
        });
      },
    });
    console.log(`undo.removePost: post ${postId} ${summaryLine(result)}`);
    return result;
  },
});

// ---------- thread replies ----------

/** Mark the reply removed (it never posts again) and claim it for the platform delete. */
export const claimReplyRemoval = internalMutation({
  args: { replyId: v.id("threadReplies") },
  handler: async (ctx, { replyId }): Promise<{ found: false } | { found: true; elderId: Id<"elders">; entry: Entry; threadRef?: string }> => {
    const reply = await ctx.db.get(replyId);
    if (!reply) return { found: false };
    const now = Date.now();
    const step = replyStep(reply, now);
    await ctx.db.patch(replyId, { removedAt: reply.removedAt ?? now, ...(claimPatch(step, now, MANUAL_REPLY_NOTE) ?? {}) });
    const target = replyDeleteTarget(reply);
    const platform: Platform = reply.platform === "reddit" ? "reddit" : "bluesky";
    const entry: Entry = {
      id: reply._id,
      platform,
      ...(reply.postedUrl ? { url: reply.postedUrl } : {}),
      step,
      ...(target && "uri" in target ? { uris: [target.uri] } : {}),
      ...(target && "fullname" in target ? { externalId: target.fullname } : {}),
    };
    return { found: true, elderId: reply.elderId, entry, ...(target && "findUnder" in target ? { threadRef: target.findUnder } : {}) };
  },
});

export const finishReplyRemoval = internalMutation({
  args: { replyId: v.id("threadReplies"), previous: previousStatus, ok: v.boolean(), error: v.optional(v.string()), postedUri: v.optional(v.string()) },
  handler: async (ctx, { replyId, previous, ok, error, postedUri }) => {
    const reply = await ctx.db.get(replyId);
    if (!reply || reply.status !== "removing") return;
    const outcome: DeleteOutcome = ok ? { ok: true, deleted: 0, alreadyGone: 0 } : { ok: false, error: error ?? "unknown error" };
    await ctx.db.patch(replyId, { ...finishPatch(previous, outcome, Date.now()), ...(postedUri && !reply.postedUri ? { postedUri } : {}) });
  },
});

/**
 * Take one thread reply down (it's also never posted again).
 *   npx convex run undo:removeReply '{"replyId":"..."}'
 */
export const removeReply = internalAction({
  args: { replyId: v.id("threadReplies"), reason: v.optional(v.string()) },
  handler: async (ctx, { replyId }): Promise<RemovalResult> => {
    const claim = await ctx.runMutation(internal.undo.claimReplyRemoval, { replyId });
    if (!claim.found) return { ...EMPTY, failed: ["Reply not found."] };
    const { elderId, threadRef } = claim;
    let foundUri: string | undefined;
    const result = await runRemoval([claim.entry], {
      remove: async (e) => {
        if (e.platform === "bluesky" && !e.uris?.length && threadRef) {
          // Older rows without postedUri: find his reply under the question post.
          const login = await blueskyLoginForElder(ctx, elderId);
          if (!login) return { ok: false, error: "His Bluesky account isn't connected." };
          try {
            const own = await withSession(timedFetch, sharedSessionCache(), login, (s) => findOwnReply(timedFetch, s, threadRef));
            if (!own) return { ok: true, deleted: 0, alreadyGone: 1 }; // nothing of his there
            foundUri = own.uri;
            return deleteOnPlatform(ctx, elderId, { platform: "bluesky", uris: [own.uri] });
          } catch {
            return { ok: false, error: "Couldn't read the Bluesky thread." };
          }
        }
        return deleteOnPlatform(ctx, elderId, e);
      },
      finish: async (e, outcome) => {
        await ctx.runMutation(internal.undo.finishReplyRemoval, {
          replyId,
          previous: e.step.previous,
          ok: outcome.ok,
          ...(outcome.ok ? {} : { error: outcome.error }),
          ...(foundUri ? { postedUri: foundUri } : {}),
        });
      },
    });
    console.log(`undo.removeReply: reply ${replyId} ${summaryLine(result)}`);
    return result;
  },
});

// ---------- "that last post" ----------

/** His newest posts with their publications (for lib/undo.pickLatestPost). No text. */
export const latestCandidates = internalQuery({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<LatestCandidate[]> => {
    const posts = await ctx.db
      .query("posts")
      .withIndex("by_elder", (q) => q.eq("elderId", elderId))
      .order("desc")
      .take(30);
    return Promise.all(
      posts.map(async (p: Doc<"posts">) => {
        const pubs = await ctx.db
          .query("postPublications")
          .withIndex("by_post", (q) => q.eq("postId", p._id))
          .collect();
        return {
          postId: p._id,
          callId: p.callId,
          createdAt: p._creationTime,
          status: p.status,
          ...(p.linkedinUrl ? { linkedinUrl: p.linkedinUrl } : {}),
          publications: pubs.map((r) => ({ status: r.status, ...(r.postedAt !== undefined ? { postedAt: r.postedAt } : {}) })),
        };
      }),
    );
  },
});

export const replyIdsForCall = internalQuery({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }): Promise<Id<"threadReplies">[]> => {
    const rows = await ctx.db
      .query("threadReplies")
      .withIndex("by_call", (q) => q.eq("callId", callId))
      .collect();
    return rows.map((r) => r._id);
  },
});

/** When the call he asked on ended (only his own call). */
export const callWindow = internalQuery({
  args: { callId: v.id("calls"), elderId: v.id("elders") },
  handler: async (ctx, { callId, elderId }): Promise<{ callId: string; endedAt: number } | null> => {
    const call = await ctx.db.get(callId);
    if (!call || call.elderId !== elderId) return null;
    // endedAt is set when the call ends; older rows: creation + 2 h covers any call.
    return { callId, endedAt: call.endedAt ?? call._creationTime + 2 * 3_600_000 };
  },
});

type LatestResult = { message: string; postId?: Id<"posts">; post?: RemovalResult; replies?: RemovalResult };

function merge(a: RemovalResult, b: RemovalResult): RemovalResult {
  return {
    removed: [...a.removed, ...b.removed],
    failed: [...a.failed, ...b.failed],
    manual: [...a.manual, ...b.manual],
    waiting: [...a.waiting, ...b.waiting],
  };
}

/**
 * His most recent post that went out (last 14 days), and the thread replies from the same
 * call. askedOnCallId: the call he asked on (its own new post isn't "that last post", and a
 * post that went out after it ended is never picked).
 *   npx convex run undo:removeLatest '{"elderId":"..."}'
 */
export const removeLatest = internalAction({
  args: { elderId: v.id("elders"), reason: v.optional(v.string()), askedOnCallId: v.optional(v.id("calls")) },
  handler: async (ctx, { elderId, reason, askedOnCallId }): Promise<LatestResult> => {
    const candidates = await ctx.runQuery(internal.undo.latestCandidates, { elderId });
    const askedOn = askedOnCallId ? await ctx.runQuery(internal.undo.callWindow, { callId: askedOnCallId, elderId }) : null;
    if (askedOnCallId && !askedOn) return { message: "nothing to remove (call not found for him)" };
    const pick = pickLatestPost(candidates, Date.now(), { ...(askedOn ? { askedOn } : {}), windowMs: LATEST_WINDOW_MS });
    if (!pick) {
      console.log(`undo.removeLatest: elder ${elderId} nothing to remove`);
      return { message: "nothing to remove" };
    }
    const postId = pick.postId as Id<"posts">;
    const post = await ctx.runAction(internal.undo.removePost, { postId, ...(reason ? { reason } : {}) });
    let replies = EMPTY;
    const replyIds = await ctx.runQuery(internal.undo.replyIdsForCall, { callId: pick.callId as Id<"calls"> });
    for (const replyId of replyIds) {
      replies = merge(replies, await ctx.runAction(internal.undo.removeReply, { replyId, ...(reason ? { reason } : {}) }));
    }
    const message = `post ${postId}: ${summaryLine(post)}; replies: ${replyIds.length ? summaryLine(replies) : "none"}`;
    console.log(`undo.removeLatest: elder ${elderId} ${message}`);
    return { message, postId, post, replies };
  },
});

// ---------- LinkedIn, by hand ----------

/**
 * After someone took a LinkedIn post down by hand. Pass the publication row, or the post
 * (marks its LinkedIn rows removed; an older post with only posts.linkedinUrl gets a row
 * saying so).
 *   npx convex run undo:markRemovedByHand '{"postId":"..."}'
 */
export const markRemovedByHand = internalMutation({
  args: { publicationId: v.optional(v.id("postPublications")), postId: v.optional(v.id("posts")) },
  handler: async (ctx, { publicationId, postId }): Promise<{ marked: number }> => {
    const now = Date.now();
    const done = { status: "removed" as const, removedAt: now, claimedAt: undefined, error: undefined };
    if (publicationId) {
      const row = await ctx.db.get(publicationId);
      if (!row || row.platform !== "linkedin") return { marked: 0 };
      await ctx.db.patch(publicationId, done);
      return { marked: 1 };
    }
    if (!postId) throw new Error("Pass publicationId or postId.");
    const post = await ctx.db.get(postId);
    if (!post) return { marked: 0 };
    const rows = (
      await ctx.db
        .query("postPublications")
        .withIndex("by_post", (q) => q.eq("postId", postId))
        .collect()
    ).filter((r) => r.platform === "linkedin");
    for (const r of rows) await ctx.db.patch(r._id, done);
    if (!rows.length && post.linkedinUrl) {
      await ctx.db.insert("postPublications", { postId, elderId: post.elderId, platform: "linkedin", url: post.linkedinUrl, status: "removed", removedAt: now });
      return { marked: 1 };
    }
    return { marked: rows.length };
  },
});
