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
//                              (+ link) | failed. approve:true posts a reply the fact-check held.
//
// Platform rules: lib/threadReplies.ts (Bluesky auto with his app password; Reddit auto only
// when REDDIT_POSTING=on + credentials; every other source gets no reply).
// Never log tokens, keys, reply text or transcripts; ids and statuses only.
// Env: BLUESKY_HANDLE, BLUESKY_APP_PASSWORD, BLUESKY_SERVICE (optional), REDDIT_POSTING,
//      REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD,
//      REDDIT_USER_AGENT, AUTO_POST, POST_GUARD_MODE.
// Owner: Integrations.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { postWebUrl, replyRefFor } from "./lib/bluesky";
import { blueskyService, createReply, createSession, getPost, type FetchFn } from "./lib/blueskyClient";
import { parseAutoPost } from "./lib/postFlow";
import {
  audienceIdForCall,
  canClaimReply,
  draftStatus,
  finalReplyText,
  parseRedditComment,
  redditThingId,
  replyBody,
  replyLanguage,
  replyTarget,
  type ReplyEnv,
} from "./lib/threadReplies";

declare const process: { env: Record<string, string | undefined> };

const HTTP_TIMEOUT_MS = 20_000;

function replyEnv(): ReplyEnv {
  const e = process.env;
  return {
    blueskyHandle: e.BLUESKY_HANDLE,
    blueskyPassword: e.BLUESKY_APP_PASSWORD,
    redditPosting: e.REDDIT_POSTING,
    redditClientId: e.REDDIT_CLIENT_ID,
    redditClientSecret: e.REDDIT_CLIENT_SECRET,
    redditUsername: e.REDDIT_USERNAME,
    redditPassword: e.REDDIT_PASSWORD,
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
    const existing = await ctx.db
      .query("threadReplies")
      .withIndex("by_audience", (q) => q.eq("audienceQuestionId", question._id))
      .first();
    return {
      elderId: call.elderId,
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
      ...(approve && reply.status === "needs_review" ? { approvedAt: now } : {}),
    });
    return { ok: true };
  },
});

export const finishReply = internalMutation({
  args: {
    replyId: v.id("threadReplies"),
    status: v.union(v.literal("posted"), v.literal("failed")),
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
    const target = replyTarget(question, replyEnv());
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
    // Same fact-check as LinkedIn posts, on the body (our disclosure line isn't his claim).
    const guard = await ctx.runAction(internal.postGuard.checkPost, { postText: replyBody(text), turns: data.turns });
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

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function postToReddit(threadUrl: string, text: string): Promise<{ url?: string; error?: string }> {
  const e = process.env;
  const thingId = redditThingId(threadUrl);
  if (!thingId) return { error: "Couldn't find the Reddit post id in the thread link." };
  if (!e.REDDIT_CLIENT_ID || !e.REDDIT_CLIENT_SECRET || !e.REDDIT_USERNAME || !e.REDDIT_PASSWORD) {
    return { error: "Reddit credentials are missing." };
  }
  const userAgent = e.REDDIT_USER_AGENT || `web:frontporch:v1 (by /u/${e.REDDIT_USERNAME})`;
  const basic = btoa(`${e.REDDIT_CLIENT_ID}:${e.REDDIT_CLIENT_SECRET}`); // default Convex runtime: no Buffer
  const tokenRes = await timedFetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent },
    body: new URLSearchParams({ grant_type: "password", username: e.REDDIT_USERNAME, password: e.REDDIT_PASSWORD }).toString(),
  });
  if (!tokenRes.ok) return { error: `Reddit token HTTP ${tokenRes.status}` };
  const token = ((await tokenRes.json().catch(() => null)) as { access_token?: unknown } | null)?.access_token;
  if (typeof token !== "string" || !token) return { error: "Reddit returned no access token." };
  const res = await timedFetch("https://oauth.reddit.com/api/comment", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent },
    body: new URLSearchParams({ api_type: "json", thing_id: thingId, text }).toString(),
  });
  if (!res.ok) return { error: `Reddit HTTP ${res.status}` };
  const parsed = parseRedditComment(await res.json().catch(() => null));
  if (parsed.errors.length) return { error: `Reddit: ${parsed.errors.join(", ")}` };
  return parsed.url ? { url: parsed.url } : {};
}

async function postToBluesky(threadRef: string | undefined, text: string, lang: string): Promise<{ url?: string; error?: string }> {
  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !password) return { error: "Bluesky login isn't set." };
  if (!threadRef) return { error: "No Bluesky post uri to reply under." };
  const fetchFn = timedFetch as unknown as FetchFn;
  const session = await createSession(fetchFn, { service: blueskyService(process.env.BLUESKY_SERVICE), identifier: handle, password });
  const question = await getPost(fetchFn, session, threadRef);
  if (!question) return { error: "The Bluesky post is gone (deleted or hidden)." };
  const reply = replyRefFor(question);
  if (!reply) return { error: "Couldn't read the Bluesky post to reply under." };
  const created = await createReply(fetchFn, session, { text, langs: [lang === "es" ? "es" : "en"], reply });
  return { url: postWebUrl(created.uri, session.handle) };
}

/** Post a reply (one run at a time). approve:true posts a reply the fact-check held. */
export const postReply = internalAction({
  args: { replyId: v.id("threadReplies"), approve: v.optional(v.boolean()) },
  handler: async (ctx, { replyId, approve }): Promise<{ status: string; url?: string; reason?: string }> => {
    const reply = await ctx.runQuery(internal.threadReplies.getReplyForPosting, { replyId });
    if (!reply) return { status: "failed", reason: "Reply not found." };
    const claim = await ctx.runMutation(internal.threadReplies.claimReply, { replyId, approve: approve ?? false });
    if (!claim.ok) return { status: reply.status, reason: claim.reason };

    let result: { url?: string; error?: string };
    try {
      if (reply.platform === "bluesky") result = await postToBluesky(reply.threadRef, reply.text, reply.language);
      else if (reply.platform === "reddit") result = await postToReddit(reply.threadUrl, reply.text);
      else result = { error: `No posting integration for ${reply.platform}.` };
    } catch {
      result = { error: "Network error or timeout while posting." }; // the reply may have gone out: check the thread
    }
    if (result.error) {
      await ctx.runMutation(internal.threadReplies.finishReply, { replyId, status: "failed", error: result.error });
      console.warn(`threadReplies.postReply: reply ${replyId} failed (${result.error})`);
      return { status: "failed", reason: result.error };
    }
    await ctx.runMutation(internal.threadReplies.finishReply, { replyId, status: "posted", ...(result.url ? { postedUrl: result.url } : {}) });
    console.log(`threadReplies.postReply: reply ${replyId} posted`);
    return { status: "posted", ...(result.url ? { url: result.url } : {}) };
  },
});
