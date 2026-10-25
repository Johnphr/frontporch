// Thread replies: after a story call whose question came from an online thread (an
// audienceQuestions row), answer that thread in his words, from his own account.
//
//   draftForCall({ callId })   scheduled by pipeline.processCall (story calls). No-op (no row)
//                              unless the call's plan used an audience question from Bluesky or
//                              Reddit AND that platform is set up. One reply per thread:
//                              replyWriter.writeReply -> disclosure line -> postGuard.checkPost
//                              -> row: draft | needs_review
//                              -> postReply scheduled for "draft" when AUTO_POST isn't off
//   postReply({ replyId, approve? })   claim (no double replies) -> Bluesky / Reddit -> posted
//                              (+ link) | failed (nothing went out) | maybe_posted (unclear:
//                              check the thread, then approve:true). approve:true also posts a
//                              reply the fact-check held. Bluesky first looks for his existing
//                              reply under the post, so a retry never answers twice.
//   postDrafts({ maxAgeDays? })   posts every "draft" reply newer than maxAgeDays (default 7):
//                              the way to send drafts written while AUTO_POST was off.
//
// Platform rules: lib/threadReplies.ts (Bluesky auto with his app password; Reddit auto only
// when REDDIT_POSTING=on + credentials; every other source gets no reply). HTTP side:
// lib/replyPosting.ts. His logins come ONLY from lib/logins.ts.
// Never log tokens, keys, reply text or transcripts; ids and statuses only.
// Env: AUTO_POST, POST_GUARD_MODE (+ the login variables listed in lib/logins.ts).
// Owner: Integrations.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { sharedSessionCache, type FetchFn } from "./lib/blueskyClient";
import { blueskyLoginForElder, redditLoginForElder } from "./lib/logins";
import { parseAutoPost } from "./lib/postFlow";
import { postBlueskyReply, postRedditReply, runPostReply, type PostOutcome } from "./lib/replyPosting";
import {
  audienceIdForCall,
  canClaimReply,
  draftCutoff,
  draftStatus,
  finalReplyText,
  guardContextForReply,
  replyBody,
  replyLanguage,
  replyTarget,
  type ReplyEnv,
} from "./lib/threadReplies";

declare const process: { env: Record<string, string | undefined> };

const HTTP_TIMEOUT_MS = 20_000;

/** Which platforms he can reply on, from his logins (lib/logins.ts). */
async function replyEnvFor(elderId: Id<"elders">): Promise<ReplyEnv> {
  const [bluesky, reddit] = await Promise.all([blueskyLoginForElder(elderId), redditLoginForElder(elderId)]);
  return {
    blueskyHandle: bluesky?.identifier,
    blueskyPassword: bluesky?.password,
    ...(reddit
      ? {
          redditPosting: "on",
          redditClientId: reddit.clientId,
          redditClientSecret: reddit.clientSecret,
          redditUsername: reddit.username,
          redditPassword: reddit.password,
        }
      : {}),
  };
}

// ---------- queries + mutations ----------

/** Everything draftForCall needs, or null when this call answers no online thread. */
export const getDraftContext = internalQuery({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => {
    const call = await ctx.db.get(callId);
    if (!call || call.kind !== "story") return null;
    const bankId = (call.plan as { bankId?: unknown } | undefined)?.bankId;
    const bankDocId = typeof bankId === "string" ? ctx.db.normalizeId("questionBank", bankId) : null;
    const bankRow = bankDocId ? await ctx.db.get(bankDocId) : null;
    const audienceRef = audienceIdForCall(call.plan, bankRow ? { _id: bankRow._id, source: bankRow.source, sourceRef: bankRow.sourceRef } : null);
    const audienceId = audienceRef ? ctx.db.normalizeId("audienceQuestions", audienceRef) : null;
    const question = audienceId ? await ctx.db.get(audienceId) : null;
    if (!question || question.elderId !== call.elderId) return null;
    const elder = await ctx.db.get(call.elderId);
    const existing = await ctx.db
      .query("threadReplies")
      .withIndex("by_audience", (q) => q.eq("audienceQuestionId", question._id))
      .first();
    return {
      elderId: call.elderId,
      callLanguage: elder?.language ?? "en",
      turns: call.transcript,
      question: {
        _id: question._id,
        source: question.source,
        url: question.url,
        title: question.title,
        ...(question.body ? { body: question.body } : {}),
        ...(question.community ? { community: question.community } : {}),
        ...(question.atUri ? { atUri: question.atUri } : {}),
      },
      existingReplyId: existing?._id ?? null,
    };
  },
});

/** Insert the reply for this thread, or return the one that's already there (one per thread). */
export const saveReply = internalMutation({
  args: {
    elderId: v.id("elders"),
    callId: v.id("calls"),
    audienceQuestionId: v.id("audienceQuestions"),
    platform: v.string(),
    threadUrl: v.string(),
    threadRef: v.optional(v.string()),
    text: v.string(),
    language: v.optional(v.string()),
    status: v.string(),
    guardIssues: v.optional(v.array(v.string())),
    guardSummary: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ replyId: Id<"threadReplies">; created: boolean }> => {
    const existing = await ctx.db
      .query("threadReplies")
      .withIndex("by_audience", (q) => q.eq("audienceQuestionId", args.audienceQuestionId))
      .first();
    if (existing) return { replyId: existing._id, created: false };
    return { replyId: await ctx.db.insert("threadReplies", args), created: true };
  },
});

export const getReplyForPosting = internalQuery({
  args: { replyId: v.id("threadReplies") },
  handler: async (ctx, { replyId }) => {
    const reply = await ctx.db.get(replyId);
    if (!reply) return null;
    return {
      _id: reply._id,
      elderId: reply.elderId,
      platform: reply.platform,
      threadUrl: reply.threadUrl,
      ...(reply.threadRef ? { threadRef: reply.threadRef } : {}),
      text: reply.text,
      language: reply.language ?? "en",
      status: reply.status,
    };
  },
});

/** Atomic claim: only one run moves a reply to `posting`. */
export const claimReply = internalMutation({
  args: { replyId: v.id("threadReplies"), approve: v.boolean() },
  handler: async (ctx, { replyId, approve }): Promise<{ ok: boolean; reason?: string }> => {
    const reply = await ctx.db.get(replyId);
    if (!reply) return { ok: false, reason: "Reply not found." };
    const now = Date.now();
    const check = canClaimReply({ status: reply.status, claimedAt: reply.claimedAt }, now, approve);
    if (!check.ok) return { ok: false, reason: check.reason };
    await ctx.db.patch(replyId, {
      status: "posting",
      claimedAt: now,
      error: undefined,
      ...(approve && reply.status !== "draft" && reply.status !== "failed" ? { approvedAt: now } : {}),
    });
    return { ok: true };
  },
});

export const finishReply = internalMutation({
  args: {
    replyId: v.id("threadReplies"),
    status: v.union(v.literal("posted"), v.literal("failed"), v.literal("maybe_posted")),
    postedUrl: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { replyId, status, postedUrl, error }) => {
    await ctx.db.patch(replyId, {
      status,
      claimedAt: undefined,
      ...(postedUrl ? { postedUrl } : {}),
      ...(status === "posted" ? { postedAt: Date.now(), error: undefined } : { error: error ?? "Posting failed." }),
    });
  },
});

/** Drafts waiting to be posted (AUTO_POST was off), oldest first, newer than `since`. */
export const draftIdsToPost = internalQuery({
  args: { since: v.number(), limit: v.number() },
  handler: async (ctx, { since, limit }): Promise<Id<"threadReplies">[]> => {
    const rows = await ctx.db
      .query("threadReplies")
      .withIndex("by_status", (q) => q.eq("status", "draft"))
      .filter((q) => q.gte(q.field("_creationTime"), since))
      .take(limit);
    return rows.map((r) => r._id);
  },
});

/** Newest replies for the /posts review page (no transcripts, no numbers). */
export const listForPage = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("threadReplies").order("desc").take(50);
    return Promise.all(
      rows.map(async (r) => {
        const q = await ctx.db.get(r.audienceQuestionId);
        return {
          id: r._id,
          createdAt: r._creationTime,
          platform: r.platform,
          status: r.status,
          threadUrl: r.threadUrl,
          threadTitle: q?.title ?? "",
          text: r.text,
          ...(r.guardSummary ? { guardSummary: r.guardSummary } : {}),
          ...(r.guardIssues?.length ? { guardIssues: r.guardIssues } : {}),
          ...(r.postedUrl ? { postedUrl: r.postedUrl } : {}),
          ...(r.error ? { error: r.error } : {}),
        };
      }),
    );
  },
});

// ---------- actions ----------

type DraftResult = { status: string; replyId?: Id<"threadReplies">; reason?: string };

/** Write (once per thread) the reply that answers the call's online question. */
export const draftForCall = internalAction({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }): Promise<DraftResult> => {
    const data = await ctx.runQuery(internal.threadReplies.getDraftContext, { callId });
    if (!data) return { status: "none", reason: "This call's question didn't come from an online thread." };
    if (data.existingReplyId) return { status: "exists", replyId: data.existingReplyId };
    const { question } = data;
    // No reply (and no row) where we can't post: other sources, or Bluesky/Reddit not set up.
    const target = replyTarget(question, await replyEnvFor(data.elderId));
    if (!target.ok) return { status: "none", reason: target.reason };
    const { platform } = target;
    const base = {
      elderId: data.elderId,
      callId,
      audienceQuestionId: question._id,
      platform,
      threadUrl: question.url,
      ...(question.atUri ? { threadRef: question.atUri } : {}),
    };

    const written = await ctx.runAction(internal.replyWriter.writeReply, {
      turns: data.turns,
      thread: {
        title: question.title,
        ...(question.body ? { body: question.body } : {}),
        ...(question.community ? { community: question.community } : {}),
      },
      platform,
    });
    // Nothing in the call answers this thread: no reply, no row.
    if (written.skip) return { status: "none", reason: written.reason };

    const lang = replyLanguage(written.language);
    const text = finalReplyText(written.text, lang, platform);
    // Same fact-check as story posts, on the body (our disclosure line isn't his claim). A reply
    // translated into the thread's language gets a note so it's judged on meaning, not wording.
    const context = guardContextForReply(lang, data.callLanguage);
    const guard = await ctx.runAction(internal.postGuard.checkPost, {
      postText: replyBody(text),
      turns: data.turns,
      ...(context ? { context } : {}),
    });
    const status = draftStatus(guard);
    const saved = await ctx.runMutation(internal.threadReplies.saveReply, {
      ...base,
      text,
      language: lang,
      status,
      ...(!guard.pass ? { guardIssues: guard.issues, guardSummary: guard.summary } : {}),
    });
    if (saved.created && status === "draft" && parseAutoPost(process.env.AUTO_POST)) {
      await ctx.scheduler.runAfter(0, internal.threadReplies.postReply, { replyId: saved.replyId });
    }
    console.log(`threadReplies.draftForCall: call ${callId} reply ${saved.replyId} ${platform} ${status}`);
    return { status, replyId: saved.replyId };
  },
});

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

/** Post a reply (one run at a time). approve:true posts a held or "maybe posted" reply. */
export const postReply = internalAction({
  args: { replyId: v.id("threadReplies"), approve: v.optional(v.boolean()) },
  handler: async (ctx, { replyId, approve }): Promise<{ status: string; url?: string; reason?: string }> => {
    let elderId: Id<"elders"> | null = null;
    const result = await runPostReply(
      {
        load: async () => {
          const reply = await ctx.runQuery(internal.threadReplies.getReplyForPosting, { replyId });
          elderId = reply?.elderId ?? null;
          return reply;
        },
        claim: (ok) => ctx.runMutation(internal.threadReplies.claimReply, { replyId, approve: ok }),
        post: async (reply) => {
          if (reply.platform === "bluesky") {
            const login = await blueskyLoginForElder(elderId);
            return postBlueskyReply(timedFetch, sharedSessionCache(), login, { threadRef: reply.threadRef, text: reply.text, lang: reply.language });
          }
          if (reply.platform === "reddit") {
            return postRedditReply(timedFetch, await redditLoginForElder(elderId), { threadUrl: reply.threadUrl, text: reply.text });
          }
          return { status: "failed", error: `No posting integration for ${reply.platform}.` } satisfies PostOutcome;
        },
        finish: async (outcome) => {
          await ctx.runMutation(
            internal.threadReplies.finishReply,
            outcome.status === "posted"
              ? { replyId, status: "posted", ...(outcome.url ? { postedUrl: outcome.url } : {}) }
              : { replyId, status: outcome.status, error: outcome.error },
          );
        },
      },
      approve ?? false,
    );
    if (result.status === "posted") console.log(`threadReplies.postReply: reply ${replyId} posted`);
    else console.warn(`threadReplies.postReply: reply ${replyId} ${result.status} (${result.reason ?? ""})`);
    return result;
  },
});

/**
 * Post the drafts written while AUTO_POST was off (status "draft", newer than maxAgeDays,
 * default 7). Each goes through postReply (claimed, so nothing posts twice), a few seconds
 * apart. Held (needs_review) and maybe_posted replies are never touched here.
 *   npx convex run threadReplies:postDrafts '{"maxAgeDays": 7}'
 */
export const postDrafts = internalAction({
  args: { maxAgeDays: v.optional(v.number()) },
  handler: async (ctx, { maxAgeDays }): Promise<{ scheduled: number; replyIds: Id<"threadReplies">[] }> => {
    const replyIds = await ctx.runQuery(internal.threadReplies.draftIdsToPost, { since: draftCutoff(Date.now(), maxAgeDays), limit: 20 });
    for (const [i, replyId] of replyIds.entries()) {
      await ctx.scheduler.runAfter(i * 5_000, internal.threadReplies.postReply, { replyId });
    }
    console.log(`threadReplies.postDrafts: ${replyIds.length} scheduled`);
    return { scheduled: replyIds.length, replyIds };
  },
});
