// Undo: take a post (and its thread replies) back down. Posting is automatic, so this is the
// safety valve: "Pip, please take down my last post." Rules: lib/undo.ts.
//
//   removePost({ postId, reason?, attempt? })
//                                     posts.removedAt first (publish.ts never sends a post with
//                                     it set), then every postPublications row: never-posted
//                                     rows -> removed; anything that went out (a half-posted
//                                     thread too) deleted on Bluesky / Threads / X / Reddit;
//                                     LinkedIn (and a Threads / X row with no post ids) ->
//                                     "manual". An in-flight `posting` row is left: publish.ts
//                                     calls us again after. Then the thread replies from the
//                                     post's call. Something failed or waiting: runs again later
//                                     (3 tries in all). -> { removed, failed, manual, waiting }
//   removeReply({ replyId })          the same for one thread reply (Bluesky deleteRecord on
//                                     postedUri; Reddit /api/del by the comment's fullname)
//   removeLatest({ elderId, reason?, askedOnCallId? })   his newest post that went out (last
//                                     14 days). The phone path: pipeline.processCall runs it when
//                                     Pip confirmed on a call (askedOnCallId: not that call's
//                                     post, nothing newer than it; the pick is saved on the call
//                                     and reused, so a re-run never reaches an older post).
//   holdPostForCall({ callId })       pipeline: a take-down on this call stops this call's own post
//   markRemovedByHand({ publicationId } | { postId })    after someone removed a post by hand
//
// Family / admin:  npx convex run undo:removePost '{"postId":"..."}'   (any post)
//                  npx convex run undo:removeLatest '{"elderId":"..."}'
// Safe to run twice. His logins come ONLY from lib/logins.ts, lib/threadsLogin.ts and
// lib/xLogin.ts (those two save refreshed tokens, so they get the action ctx). Never log tokens, passwords,
// post text or reply text; ids, platforms and statuses only.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { findOwnReply, sharedSessionCache, withSession, type FetchFn } from "./lib/blueskyClient";
import { deleteBlueskyThread, type DeleteOutcome } from "./lib/blueskyDelete";
import { blueskyLoginForElder, redditLoginForElder } from "./lib/logins";
import { threadsLoginForElder } from "./lib/threadsLogin";
import { deleteThreadsPosts } from "./lib/threadsPublishing";
import { xLoginForElder } from "./lib/xLogin";
import { deleteXPosts } from "./lib/xPublishing";
import {
  EMPTY_RESULT,
  LATEST_WINDOW_MS,
  MANUAL_REPLY_NOTE,
  claimPatch,
  cleanReason,
  deleteCopy,
  deleteRedditThing,
  finishPatch,
  holdReason,
  mergeResults,
  ownsClaim,
  pickLatestPost,
  planPostRemoval,
  postRemovalPatch,
  pubHasCopy,
  replyDeleteTarget,
  replyStep,
  retryDelay,
  runRemoval,
  summaryLine,
  takeDownNote,
  type Entry,
  type LatestCandidate,
  type Platform,
  type RemovalResult,
} from "./lib/undo";

const HTTP_TIMEOUT_MS = 20_000;

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

/** What a failed delete puts the row back to (lib/undo.RestoreStatus). */
const restoreStatus = v.union(
  v.literal("posted"),
  v.literal("maybe_posted"),
  v.literal("failed"),
  v.literal("pending"),
  v.literal("skipped"),
  v.literal("draft"),
  v.literal("needs_review"),
);

// ---------- posts ----------

/**
 * One transaction: mark the post removed (so nothing new goes out), then claim every
 * publication row. Returns what the action still has to delete on the platforms.
 */
export const claimPostRemoval = internalMutation({
  args: { postId: v.id("posts"), reason: v.optional(v.string()) },
  handler: async (
    ctx,
    { postId, reason },
  ): Promise<{ found: false } | { found: true; elderId: Id<"elders">; callId: Id<"calls">; entries: Entry[] }> => {
    const post = await ctx.db.get(postId);
    if (!post) return { found: false };
    const rows = await ctx.db
      .query("postPublications")
      .withIndex("by_post", (q) => q.eq("postId", postId))
      .collect();
    const plan = planPostRemoval(post, rows, reason, Date.now());
    await ctx.db.patch(postId, plan.postPatch); // first: nothing new goes out
    for (const { id, patch } of plan.rowPatches) await ctx.db.patch(id as Id<"postPublications">, patch);
    return { found: true, elderId: post.elderId, callId: post.callId, entries: plan.entries };
  },
});

/** After the platform delete: removed, or back to the previous status with a short error. Only for this run's claim. */
export const finishPublication = internalMutation({
  args: {
    publicationId: v.id("postPublications"),
    previous: restoreStatus,
    claimedAt: v.optional(v.number()),
    ok: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { publicationId, previous, claimedAt, ok, error }) => {
    const row = await ctx.db.get(publicationId);
    if (!row || !ownsClaim(row, claimedAt)) return; // someone else finished or retook it
    const outcome: DeleteOutcome = ok ? { ok: true, deleted: 0, alreadyGone: 0 } : { ok: false, error: error ?? "unknown error" };
    await ctx.db.patch(publicationId, finishPatch(previous, outcome, Date.now()));
  },
});

/** Delete one platform copy (a Bluesky / Threads / X thread, or a Reddit post) with his login. */
function deleteOnPlatform(
  ctx: ActionCtx,
  elderId: Id<"elders">,
  e: { platform: Platform; uris?: string[]; externalId?: string },
): Promise<DeleteOutcome> {
  return deleteCopy(e, {
    bluesky: async (uris) => deleteBlueskyThread(timedFetch, sharedSessionCache(), await blueskyLoginForElder(ctx, elderId), uris),
    threads: async (ids) => deleteThreadsPosts(timedFetch, await threadsLoginForElder(ctx, elderId, { fetchFn: timedFetch }), ids),
    x: async (ids) => deleteXPosts(timedFetch, await xLoginForElder(ctx, elderId, { fetchFn: timedFetch }), ids),
    reddit: async (fullname) => deleteRedditThing(timedFetch, await redditLoginForElder(ctx, elderId), fullname),
  });
}

/**
 * Take a post down everywhere it went, and the thread replies from its call. Contract with
 * publish.ts: called with { postId } when it finds removedAt set right after posting.
 * attempt: which try this is (1 = first); failed / waiting rows get up to 3 tries in all.
 *   npx convex run undo:removePost '{"postId":"..."}'
 */
export const removePost = internalAction({
  args: { postId: v.id("posts"), reason: v.optional(v.string()), attempt: v.optional(v.number()) },
  handler: async (ctx, { postId, reason, attempt }): Promise<RemovalResult> => {
    const claim = await ctx.runMutation(internal.undo.claimPostRemoval, { postId, reason: cleanReason(reason) });
    if (!claim.found) return { ...EMPTY_RESULT, failed: ["Post not found."] };
    const { elderId, callId } = claim;
    let result = await runRemoval(claim.entries, {
      remove: (e) => deleteOnPlatform(ctx, elderId, e),
      finish: async (e, outcome) => {
        await ctx.runMutation(internal.undo.finishPublication, {
          publicationId: e.id as Id<"postPublications">,
          previous: e.step.previous,
          ...(e.claimedAt !== undefined ? { claimedAt: e.claimedAt } : {}),
          ok: outcome.ok,
          ...(outcome.ok ? {} : { error: outcome.error }),
        });
      },
    });
    // The thread replies from the same call come down with it.
    const replyIds = await ctx.runQuery(internal.undo.replyIdsForCall, { callId });
    for (const replyId of replyIds) {
      result = mergeResults(result, await ctx.runAction(internal.undo.removeReply, { replyId }));
    }
    const tries = attempt ?? 1;
    const delay = retryDelay(result, tries);
    if (delay !== null) {
      await ctx.scheduler.runAfter(delay, internal.undo.removePost, { postId, ...(reason ? { reason } : {}), attempt: tries + 1 });
    }
    console.log(
      `undo.removePost: post ${postId} ${summaryLine(result)} (try ${tries}${delay !== null ? `; again in ${Math.round(delay / 60_000)} min` : ""})`,
    );
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
      ...(step.kind === "delete" ? { claimedAt: now } : {}),
    };
    return { found: true, elderId: reply.elderId, entry, ...(target && "findUnder" in target ? { threadRef: target.findUnder } : {}) };
  },
});

export const finishReplyRemoval = internalMutation({
  args: {
    replyId: v.id("threadReplies"),
    previous: restoreStatus,
    claimedAt: v.optional(v.number()),
    ok: v.boolean(),
    error: v.optional(v.string()),
    postedUri: v.optional(v.string()),
  },
  handler: async (ctx, { replyId, previous, claimedAt, ok, error, postedUri }) => {
    const reply = await ctx.db.get(replyId);
    if (!reply || !ownsClaim(reply, claimedAt)) return; // someone else finished or retook it
    const outcome: DeleteOutcome = ok ? { ok: true, deleted: 0, alreadyGone: 0 } : { ok: false, error: error ?? "unknown error" };
    await ctx.db.patch(replyId, { ...finishPatch(previous, outcome, Date.now()), ...(postedUri && !reply.postedUri ? { postedUri } : {}) });
  },
});

/**
 * Take one thread reply down (it's also never posted again).
 *   npx convex run undo:removeReply '{"replyId":"..."}'
 */
export const removeReply = internalAction({
  args: { replyId: v.id("threadReplies") },
  handler: async (ctx, { replyId }): Promise<RemovalResult> => {
    const claim = await ctx.runMutation(internal.undo.claimReplyRemoval, { replyId });
    if (!claim.found) return { ...EMPTY_RESULT, failed: ["Reply not found."] };
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
          ...(e.claimedAt !== undefined ? { claimedAt: e.claimedAt } : {}),
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
          ...(p.removedAt !== undefined ? { removedAt: p.removedAt } : {}),
          ...(p.removedReason ? { removedReason: p.removedReason } : {}),
          publications: pubs.map((r) => ({
            status: r.status,
            ...(r.postedAt !== undefined ? { postedAt: r.postedAt } : {}),
            ...(pubHasCopy(r) ? { hasCopy: true } : {}),
          })),
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

/** When the call he asked on ended (only his own call), and what it already picked. */
export const callWindow = internalQuery({
  args: { callId: v.id("calls"), elderId: v.id("elders") },
  handler: async (
    ctx,
    { callId, elderId },
  ): Promise<{ callId: string; endedAt: number; picked: boolean; postId?: Id<"posts"> } | null> => {
    const call = await ctx.db.get(callId);
    if (!call || call.elderId !== elderId) return null;
    // endedAt is set when the call ends; older rows: creation + 2 h covers any call.
    return {
      callId,
      endedAt: call.endedAt ?? call._creationTime + 2 * 3_600_000,
      picked: call.takeDown?.picked === true,
      ...(call.takeDown?.postId ? { postId: call.takeDown.postId } : {}),
    };
  },
});

/** Save which earlier post this call's take-down means. The first pick wins; returns the saved one. */
export const saveTakeDownPick = internalMutation({
  args: { callId: v.id("calls"), postId: v.optional(v.id("posts")) },
  handler: async (ctx, { callId, postId }): Promise<{ postId?: Id<"posts"> }> => {
    const call = await ctx.db.get(callId);
    if (!call) return {};
    const td = call.takeDown;
    if (td?.picked) return td.postId ? { postId: td.postId } : {};
    const base = td ?? { how: "line" as const, note: takeDownNote("line"), at: Date.now() };
    await ctx.db.patch(callId, { takeDown: { ...base, picked: true, ...(postId ? { postId } : {}) } });
    return postId ? { postId } : {};
  },
});

type LatestResult = { message: string; postId?: Id<"posts">; post?: RemovalResult };

/**
 * His most recent post that went out (last 14 days), with the thread replies from its call
 * (removePost). askedOnCallId: the call he asked on (its own new post isn't "that last post", a
 * post that went out after it ended is never picked, and the pick is saved on the call: a
 * re-run or a second ask on the same call takes down the same post, never an older one).
 *   npx convex run undo:removeLatest '{"elderId":"..."}'
 */
export const removeLatest = internalAction({
  args: { elderId: v.id("elders"), reason: v.optional(v.string()), askedOnCallId: v.optional(v.id("calls")) },
  handler: async (ctx, { elderId, reason, askedOnCallId }): Promise<LatestResult> => {
    let postId: Id<"posts"> | undefined;
    if (askedOnCallId) {
      const askedOn = await ctx.runQuery(internal.undo.callWindow, { callId: askedOnCallId, elderId });
      if (!askedOn) return { message: "nothing to remove (call not found for him)" };
      if (askedOn.picked) {
        postId = askedOn.postId;
      } else {
        const candidates = await ctx.runQuery(internal.undo.latestCandidates, { elderId });
        const pick = pickLatestPost(candidates, Date.now(), { askedOn, windowMs: LATEST_WINDOW_MS });
        const saved = await ctx.runMutation(internal.undo.saveTakeDownPick, {
          callId: askedOnCallId,
          ...(pick ? { postId: pick.postId as Id<"posts"> } : {}),
        });
        postId = saved.postId;
      }
    } else {
      const candidates = await ctx.runQuery(internal.undo.latestCandidates, { elderId });
      postId = pickLatestPost(candidates, Date.now(), { windowMs: LATEST_WINDOW_MS })?.postId as Id<"posts"> | undefined;
    }
    if (!postId) {
      console.log(`undo.removeLatest: elder ${elderId} nothing to remove`);
      return { message: "nothing to remove" };
    }
    const post = await ctx.runAction(internal.undo.removePost, { postId, ...(reason ? { reason } : {}) });
    const message = `post ${postId}: ${summaryLine(post)}`;
    console.log(`undo.removeLatest: elder ${elderId} ${message}`);
    return { message, postId, post };
  },
});

// ---------- the phone: this call's own post ----------

/** pipeline: he asked for a take-down on this call. Saved once (a re-run keeps the first). */
export const recordCallTakeDown = internalMutation({
  args: { callId: v.id("calls"), how: v.union(v.literal("line"), v.literal("today"), v.literal("unconfirmed")) },
  handler: async (ctx, { callId, how }) => {
    const call = await ctx.db.get(callId);
    if (!call || call.takeDown) return;
    await ctx.db.patch(callId, { takeDown: { how, note: takeDownNote(how), at: Date.now() } });
  },
});

/**
 * pipeline: stop this call's own post when he asked for a take-down on the call (removedAt +
 * a "held: ..." reason, so publish.ts never sends it), then removePost for anything that
 * already went out. No post yet, or no take-down: nothing to do. Safe to run twice.
 */
export const holdPostForCall = internalMutation({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }): Promise<{ held: boolean; postId?: Id<"posts"> }> => {
    const call = await ctx.db.get(callId);
    if (!call?.takeDown) return { held: false };
    const post = await ctx.db
      .query("posts")
      .withIndex("by_call", (q) => q.eq("callId", callId))
      .first();
    if (!post) return { held: false };
    const reason = holdReason(call.takeDown.how);
    if (post.removedAt === undefined) await ctx.db.patch(post._id, postRemovalPatch(post, reason, Date.now()));
    await ctx.scheduler.runAfter(0, internal.undo.removePost, { postId: post._id, reason });
    return { held: true, postId: post._id };
  },
});

// ---------- by hand (LinkedIn, Threads, X) ----------

const DELETABLE = new Set(["bluesky", "reddit"]);

/**
 * After someone took a post down by hand where we have no delete (LinkedIn, Threads, X). Pass
 * the publication row, or the post (marks those rows removed; an older post with only
 * posts.linkedinUrl gets a row saying so).
 *   npx convex run undo:markRemovedByHand '{"postId":"..."}'
 */
export const markRemovedByHand = internalMutation({
  args: { publicationId: v.optional(v.id("postPublications")), postId: v.optional(v.id("posts")) },
  handler: async (ctx, { publicationId, postId }): Promise<{ marked: number }> => {
    const now = Date.now();
    const done = { status: "removed" as const, removedAt: now, claimedAt: undefined, error: undefined };
    if (publicationId) {
      const row = await ctx.db.get(publicationId);
      if (!row || DELETABLE.has(row.platform)) return { marked: 0 };
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
    ).filter((r) => !DELETABLE.has(r.platform));
    for (const r of rows) await ctx.db.patch(r._id, done);
    if (!rows.length && post.linkedinUrl) {
      // postedAt: it went out when the post was made (so removeLatest still counts it).
      await ctx.db.insert("postPublications", {
        postId,
        elderId: post.elderId,
        platform: "linkedin",
        url: post.linkedinUrl,
        status: "removed",
        postedAt: post._creationTime,
        removedAt: now,
      });
      return { marked: 1 };
    }
    return { marked: rows.length };
  },
});
