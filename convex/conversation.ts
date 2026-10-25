// The question planner: what Pip talks about next.
//
//   refreshQuestionBank({ elderId })  after every call, when reader comments arrive,
//                                     and from prepareCall. Rebuilds the ranked bank
//                                     from his profile, open threads, memories,
//                                     reader feedback, audience + recent topics.
//   prepareCall({ elderId })          ~1h before his call (schedule.tick): fresh
//                                     audience questions (Apify) and recent topics in
//                                     his field (LLM web search), in parallel, then
//                                     schedules a refresh with them.
//   planNextCall({ elderId })         at call time -> { plan, dynamicVariables }. The
//                                     kind comes from PR #7's lib/onboarding.planNextCall
//                                     (cartesia.reserveCall uses the same rule). Onboarding:
//                                     PR #7's buildOnboardingVariables (first_name,
//                                     goal, context). Story: question bank + memories +
//                                     avoid topics + saved feedback line, as Cartesia
//                                     dynamic_variables for lib/prompts/agent.ts.
//                                     Fast: never waits on a refresh or an LLM call.
//                                     cartesia.startCall's story branch (slice 2) calls it.
//   markPlanUsed({ elderId, bankId, callId })   cartesia.startCall, once a story call is placed.
//   markCommentsMentioned({ callId })   pipeline.processCall, once a story call was a real
//                                     conversation: its plan's reader comments are shared, so
//                                     refreshes leave them out (only new comments reach a call).
//
// Ranking rules live in lib/planner.ts (pure, tested). Owner: Core: Brain.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import type { MemoryDoc, MemoryHit } from "./lib/dataRefs";
import {
  FALLBACK_MAIN_QUESTION,
  bankIdsHeldByOpenCalls,
  buildCallPlan,
  dropJustUsed,
  fallbackCandidates,
  firstBankQuestion,
  freshReaderSince,
  isStaleRefresh,
  rankCandidates,
  toPromptVariables,
  type CallPlan,
  type Candidate,
  type CandidateSource,
} from "./lib/planner";
import { templateVariables } from "./lib/cartesia";
import { buildOnboardingVariables, callCharacter } from "./lib/onboarding";
import { addMentioned, newComments, quotableComments } from "./lib/readerSafety";
import { asElderV2, isOnboarding, type ElderV2 } from "./lib/v2Fields";
import { accountsLine } from "./lib/prompts/agent";
import { xPostingOn } from "./lib/xPublishing";

// Convex exposes env vars on process.env (declared so we don't need @types/node).
declare const process: { env: Record<string, string | undefined> };

const bankItemValidator = v.object({
  question: v.string(),
  why: v.string(),
  source: v.string(),
  sourceRef: v.optional(v.string()),
  topicKey: v.string(),
  priority: v.number(),
  firstSeenAt: v.number(),
});

const recentTopicValidator = v.object({
  title: v.string(),
  summary: v.string(),
  url: v.string(),
  question: v.string(),
});

type RecentTopic = { title: string; summary: string; url: string; question: string };

type BankRow = {
  _id: Id<"questionBank">;
  question: string;
  why: string;
  source: string;
  sourceRef?: string;
  topicKey: string;
  priority: number;
  firstSeenAt: number;
};

type PlanningContext = {
  elder: ElderV2 | null;
  queued: BankRow[];
  recentlyUsedTopics: string[];
  feedbackLine: string;
  resonated: string;
  readerComments: string;
  pendingCommentKeys: string[];
  mentionedComments: string[];
  accounts: string; // <accounts>: which of Bluesky / X his posts go to (lib/prompts/agent.accountsLine)
};

const RECENTLY_USED_COUNT = 10;
/** Look this far before the refresh's start for rows just used (clock slack between functions). */
const JUST_USED_SLACK_MS = 60_000;
/** Recent calls checked for a plan still holding a queued bank row. */
const OPEN_CALLS_CHECKED = 10;

// ---------- queries + mutations ----------

export const getPlanningContext = internalQuery({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<PlanningContext> => {
    const elder = asElderV2(await ctx.db.get(elderId));
    const queued = await ctx.db
      .query("questionBank")
      .withIndex("by_elder_status_priority", (q) => q.eq("elderId", elderId).eq("status", "queued"))
      .order("desc")
      .take(50);
    // Most recently used first (by usedAt), so "recently asked" really is recent.
    const used = await ctx.db
      .query("questionBank")
      .withIndex("by_elder_status_usedAt", (q) => q.eq("elderId", elderId).eq("status", "used"))
      .order("desc")
      .take(RECENTLY_USED_COUNT);
    const recentlyUsedTopics = used.map((u) => u.topicKey.replace(/-/g, " "));
    const meta = await ctx.db
      .query("questionBankMeta")
      .withIndex("by_elder", (q) => q.eq("elderId", elderId))
      .first();
    const connected = async (platform: "bluesky" | "x") =>
      (await ctx.db
        .query("elderAccounts")
        .withIndex("by_elder_platform", (q) => q.eq("elderId", elderId).eq("platform", platform))
        .first())?.status === "connected";
    const accounts = accountsLine({ bluesky: await connected("bluesky"), x: xPostingOn(process.env) && (await connected("x")) });
    return {
      elder,
      queued: queued.map((r) => ({
        _id: r._id,
        question: r.question,
        why: r.why,
        source: r.source,
        sourceRef: r.sourceRef,
        topicKey: r.topicKey,
        priority: r.priority,
        firstSeenAt: r.firstSeenAt,
      })),
      recentlyUsedTopics,
      feedbackLine: meta?.feedbackLine ?? "",
      resonated: meta?.resonated ?? "",
      readerComments: meta?.readerComments ?? "",
      pendingCommentKeys: meta?.pendingCommentKeys ?? [],
      mentionedComments: meta?.mentionedComments ?? [],
      accounts,
    };
  },
});

/** The feedback the last refresh worked out (for the post writer). */
export const getSavedFeedback = internalQuery({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<{ feedbackLine: string; resonated: string } | null> => {
    const meta = await ctx.db
      .query("questionBankMeta")
      .withIndex("by_elder", (q) => q.eq("elderId", elderId))
      .first();
    return meta ? { feedbackLine: meta.feedbackLine, resonated: meta.resonated } : null;
  },
});

/**
 * Swap the queued bank for a freshly ranked one (unless a refresh that began later already
 * did: lib/planner.isStaleRefresh). Used rows stay as history. Queued rows an
 * open call's plan points at stay too (that call marks them used later), and aren't re-added.
 */
export const replaceQueued = internalMutation({
  args: {
    elderId: v.id("elders"),
    items: v.array(bankItemValidator),
    feedbackLine: v.optional(v.string()),
    resonated: v.optional(v.string()),
    readerComments: v.optional(v.string()),
    pendingCommentKeys: v.optional(v.array(v.string())),
    /** when the refresh read its context: rows used since then must not come back queued */
    startedAt: v.optional(v.number()),
  },
  handler: async (ctx, { elderId, items: ranked, feedbackLine, resonated, readerComments, pendingCommentKeys, startedAt }) => {
    const meta = await ctx.db
      .query("questionBankMeta")
      .withIndex("by_elder", (q) => q.eq("elderId", elderId))
      .first();
    // A newer refresh (it read newer replies) already wrote the bank: keep that one.
    if (isStaleRefresh(startedAt, meta?.refreshStartedAt)) return { removed: 0, kept: 0, queued: 0, stale: true };
    const usedSince =
      startedAt === undefined
        ? []
        : await ctx.db
            .query("questionBank")
            .withIndex("by_elder_status_usedAt", (q) =>
              q.eq("elderId", elderId).eq("status", "used").gte("usedAt", startedAt - JUST_USED_SLACK_MS),
            )
            .collect();
    const recentCalls = await ctx.db
      .query("calls")
      .withIndex("by_elder", (q) => q.eq("elderId", elderId))
      .order("desc")
      .take(OPEN_CALLS_CHECKED);
    const held = bankIdsHeldByOpenCalls(recentCalls);
    const old = await ctx.db
      .query("questionBank")
      .withIndex("by_elder_status_priority", (q) => q.eq("elderId", elderId).eq("status", "queued"))
      .collect();
    const kept = old.filter((row) => held.has(row._id));
    const items = dropJustUsed(ranked, [...usedSince, ...kept]);
    for (const row of old) if (!held.has(row._id)) await ctx.db.delete(row._id);
    for (const item of items) {
      await ctx.db.insert("questionBank", { elderId, ...item, status: "queued" });
    }
    if (feedbackLine !== undefined || resonated !== undefined) {
      const fields = {
        feedbackLine: feedbackLine ?? "",
        resonated: resonated ?? "",
        readerComments: readerComments ?? "",
        pendingCommentKeys: pendingCommentKeys ?? [],
        refreshedAt: Date.now(),
        ...(startedAt !== undefined ? { refreshStartedAt: startedAt } : {}),
      };
      if (meta) await ctx.db.patch(meta._id, fields);
      else await ctx.db.insert("questionBankMeta", { elderId, ...fields });
    }
    return { removed: old.length - kept.length, kept: kept.length, queued: items.length, stale: false };
  },
});

export const listQueued = internalQuery({
  args: { elderId: v.id("elders"), limit: v.optional(v.number()) },
  handler: async (ctx, { elderId, limit }) =>
    ctx.db
      .query("questionBank")
      .withIndex("by_elder_status_priority", (q) => q.eq("elderId", elderId).eq("status", "queued"))
      .order("desc")
      .take(Math.max(1, Math.min(Math.floor(limit ?? 12), 50))),
});

/**
 * cartesia.startCall calls this once the call is placed, with plan.bankId from
 * planNextCall. Marks the question used (and the audience question behind it).
 */
export const markPlanUsed = internalMutation({
  args: { elderId: v.id("elders"), bankId: v.id("questionBank"), callId: v.optional(v.id("calls")) },
  handler: async (ctx, { elderId, bankId, callId }) => markBankRowUsed(ctx, elderId, bankId, callId),
});

/**
 * pipeline.processCall, once a story call was a real conversation (before its plan refresh is
 * scheduled): the reader comments its plan carried were shared, so no call gets them again.
 */
export const markCommentsMentioned = internalMutation({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => {
    const call = await ctx.db.get(callId);
    const keys = (call?.plan as { commentKeys?: unknown } | undefined)?.commentKeys;
    if (!call || !Array.isArray(keys) || keys.length === 0) return { marked: 0 };
    const meta = await ctx.db
      .query("questionBankMeta")
      .withIndex("by_elder", (q) => q.eq("elderId", call.elderId))
      .first();
    if (!meta) return { marked: 0 };
    const strKeys = keys.filter((k): k is string => typeof k === "string");
    await ctx.db.patch(meta._id, { mentionedComments: addMentioned(meta.mentionedComments ?? [], strKeys) });
    return { marked: strKeys.length };
  },
});

/**
 * Shared by markPlanUsed (outbound: when the phone rings) and pipeline.finishProcessing
 * (inbound: once the call turned out to be a real conversation).
 */
export async function markBankRowUsed(
  ctx: MutationCtx,
  elderId: Id<"elders">,
  bankId: Id<"questionBank">,
  callId?: Id<"calls">,
): Promise<{ ok: boolean }> {
  const row = await ctx.db.get(bankId);
  if (!row) {
    console.warn(`conversation.markBankRowUsed: bank row not found for call ${callId ?? "(none)"}`);
    return { ok: false };
  }
  if (row.elderId !== elderId) return { ok: false };
  const now = Date.now();
  await ctx.db.patch(bankId, { status: "used", usedAt: now, ...(callId ? { usedInCallId: callId } : {}) });
  if (row.source === "audience" && row.sourceRef) {
    const audienceId = ctx.db.normalizeId("audienceQuestions", row.sourceRef);
    if (audienceId) await ctx.db.patch(audienceId, { usedAt: now, ...(callId ? { usedInCallId: callId } : {}) });
  }
  return { ok: true };
}

// ---------- actions ----------

type RefreshResult = { queued: number; usedLlm: boolean; errors: string[] };

/** Best effort: a missing Data function (or any failure) just means "no input from it". */
async function attempt<T>(errors: string[], label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

export const refreshQuestionBank = internalAction({
  args: {
    elderId: v.id("elders"),
    recentTopics: v.optional(v.array(recentTopicValidator)),
    freshAudience: v.optional(v.array(v.object({ id: v.string(), title: v.string() }))),
  },
  handler: async (ctx, args): Promise<RefreshResult> => {
    const errors: string[] = [];
    const startedAt = Date.now();
    const context: PlanningContext = await ctx.runQuery(internal.conversation.getPlanningContext, {
      elderId: args.elderId,
    });
    if (!context.elder) throw new Error("Elder not found");
    const profile = context.elder.profile;

    const memories: MemoryDoc[] = await attempt(
      errors,
      "memories",
      () => ctx.runQuery(internal.memories.listForElder, { elderId: args.elderId, limit: 200 }),
      [],
    );
    const openThreads = memories
      .filter((m) => m.kind === "open_thread" && m.status !== "resolved")
      .slice(0, 15)
      .map((m) => ({ id: m._id, text: m.text }));
    // Story seeds from onboarding (profile) come first: they're the slice-2 call topics.
    const storyMemories = [
      ...(profile?.storySeeds ?? []).map((seed) => `Story seed: ${seed}`),
      ...memories
        .filter((m) => m.kind === "fact" || m.kind === "story_seed" || m.kind === "person" || m.kind === "place")
        .sort((a, b) => (b.lastMentionedAt ?? b._creationTime) - (a.lastMentionedAt ?? a._creationTime))
        .slice(0, 30)
        .map((m) => (m.name ? `${m.name}: ${m.text}` : m.text)),
    ];
    // covered: topics he already talked about (open threads / readers may revisit them).
    // recentlyUsed: topics of questions asked in his last calls (never repeated).
    const covered = memories.filter((m) => m.kind === "topic_covered").map((m) => m.text);
    const recentlyUsed = context.recentlyUsedTopics;
    const avoid = [...memories.filter((m) => m.kind === "avoid").map((m) => m.text), ...(profile?.topicsToAvoid ?? [])];

    const allFeedbackPosts = await attempt(
      errors,
      "engagement",
      () => ctx.runQuery(internal.engagement.recentFeedback, { elderId: args.elderId, sinceDays: 14 }),
      [],
    );
    // Comments a real conversation already shared never come back; only new ones reach a call.
    const { posts: feedbackPosts, keys: commentKeys } = newComments(allFeedbackPosts, context.mentionedComments);
    const feedback = feedbackPosts.length
      ? await attempt(
          errors,
          "summarizeFeedback",
          () =>
            ctx.runAction(internal.llm.summarizeFeedback, {
              posts: feedbackPosts.map((p) => ({
                linkedinUrl: p.linkedinUrl,
                ...(p.postText ? { postText: p.postText } : {}),
                reactions: p.reactions,
                comments: p.comments,
              })),
            }),
          { resonated: "", readerQuestions: [] as string[], line: "" },
        )
      : { resonated: "", readerQuestions: [] as string[], line: "" };

    const audienceRows = await attempt<{ _id: string; title: string }[]>(
      errors,
      "audienceQuestions",
      () => ctx.runQuery(internal.apify.topAudienceQuestions, { elderId: args.elderId, limit: 8 }),
      [],
    );
    const audienceQuestions = [
      ...audienceRows.map((r) => ({ id: String(r._id), title: r.title })),
      ...(args.freshAudience ?? []),
    ].filter((q, i, all) => all.findIndex((x) => x.id === q.id) === i);
    const recentTopics: RecentTopic[] = args.recentTopics ?? [];

    let usedLlm = true;
    let candidates: Candidate[] = await attempt(
      errors,
      "planQuestions",
      async () =>
        (
          await ctx.runAction(internal.llm.planQuestions, {
            ...(profile ? { profile } : {}),
            openThreads,
            memories: storyMemories,
            covered,
            recentlyAsked: recentlyUsed,
            avoid,
            readerQuestions: feedback.readerQuestions,
            audienceQuestions,
            recentTopics,
          })
        ).candidates,
      [],
    );
    if (candidates.length === 0) {
      usedLlm = false;
      candidates = fallbackCandidates({
        openThreads,
        readerQuestions: feedback.readerQuestions,
        audienceQuestions,
        recentTopics,
      });
    }

    // Keep what's already queued in the mix so its age (firstSeenAt) carries over
    // (rankCandidates keeps the oldest firstSeenAt per topic, whatever the order).
    const existing: Candidate[] = context.queued.map((r) => ({
      question: r.question,
      why: r.why,
      source: r.source as CandidateSource,
      ...(r.sourceRef ? { sourceRef: r.sourceRef } : {}),
      topicKey: r.topicKey,
      firstSeenAt: r.firstSeenAt,
    }));
    // A reader replied in the last 48h: his new questions go first, so the next call asks one.
    const now = Date.now();
    const freshSince = freshReaderSince(feedbackPosts, now);
    const ranked = rankCandidates([...candidates, ...existing], {
      avoid,
      covered,
      recentlyUsed,
      now,
      limit: 12,
      ...(freshSince !== undefined ? { freshReaderSince: freshSince } : {}),
    });
    await ctx.runMutation(internal.conversation.replaceQueued, {
      elderId: args.elderId,
      startedAt,
      feedbackLine: feedback.line,
      resonated: feedback.resonated,
      readerComments: quotableComments(feedbackPosts.flatMap((p) => p.comments)),
      pendingCommentKeys: commentKeys,
      items: ranked.map((r) => ({
        question: r.question,
        why: r.why,
        source: r.source,
        ...(r.sourceRef ? { sourceRef: r.sourceRef } : {}),
        topicKey: r.topicKey,
        priority: r.priority,
        firstSeenAt: r.firstSeenAt,
      })),
    });
    return { queued: ranked.length, usedLlm, errors };
  },
});

type PrepareResult = { refreshScheduled: boolean; recentTopics: number; audience: string; errors: string[] };

export const prepareCall = internalAction({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<PrepareResult> => {
    const errors: string[] = [];
    const context: PlanningContext = await ctx.runQuery(internal.conversation.getPlanningContext, { elderId });
    if (!context.elder) throw new Error("Elder not found");
    // The onboarding call doesn't use the bank, and his field isn't known yet: skip the paid searches.
    if (isOnboarding(context.elder)) {
      return { refreshScheduled: false, recentTopics: 0, audience: "skipped (onboarding)", errors };
    }

    // Both lookups run at once (each can take minutes). Apify saves its own results;
    // refreshQuestionBank reads the best ones back via topAudienceQuestions.
    const [audienceRun, recentRun] = await Promise.allSettled([
      ctx.runAction(internal.apify.findAudienceQuestions, { elderId }),
      ctx.runAction(internal.llm.findRecentTopics, {
        ...(context.elder.profile ? { profile: context.elder.profile } : {}),
      }),
    ]);
    const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
    let audience = "failed";
    if (audienceRun.status === "fulfilled") audience = `${audienceRun.value.inserted} new`;
    else errors.push(`findAudienceQuestions: ${message(audienceRun.reason)}`);
    let recentTopics: RecentTopic[] = [];
    if (recentRun.status === "fulfilled") recentTopics = recentRun.value.topics;
    else errors.push(`findRecentTopics: ${message(recentRun.reason)}`);

    // The refresh runs on its own so this action stays well inside Convex's time limit.
    await ctx.scheduler.runAfter(0, internal.conversation.refreshQuestionBank, { elderId, recentTopics });
    if (errors.length) console.warn(`prepareCall ${elderId} failed: ${errors.map((e) => e.split(":")[0]).join(", ")}`);
    return { refreshScheduled: true, recentTopics: recentTopics.length, audience, errors };
  },
});

/** cartesia.startCall sends dynamicVariables as `dynamic_variables` on POST /agents/calls. */
type PlanResult = { plan: CallPlan; dynamicVariables: Record<string, string> };

export const planNextCall = internalAction({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<PlanResult> => {
    const context: PlanningContext = await ctx.runQuery(internal.conversation.getPlanningContext, { elderId });
    const elder = context.elder;
    if (!elder) throw new Error("Elder not found");
    const lang = callCharacter(elder).language; // the character's language, same as cartesia.startCall

    // Topics he doesn't want to discuss always reach Pip (outside the memories budget).
    let avoidMemories: string[] = [];
    try {
      const rows: MemoryDoc[] = await ctx.runQuery(internal.memories.listForElder, { elderId, kinds: ["avoid"], limit: 10 });
      avoidMemories = rows.map((m) => m.text);
    } catch {
      // memories not available: the profile's topicsToAvoid still go through.
    }

    if (isOnboarding(elder)) {
      // Same variables cartesia.startCall sends (it scrapes + caches the background; we read the cache).
      const knownBackground = elder.knownBackground ?? "";
      const plan = buildCallPlan({ kind: "onboarding", knownBackground });
      return { plan, dynamicVariables: buildOnboardingVariables(elder, knownBackground, lang) };
    }

    if (context.queued.length === 0) {
      // Don't make the call wait: use the default question now and fill the bank for next time.
      await ctx.scheduler.runAfter(0, internal.conversation.refreshQuestionBank, { elderId });
    }
    const bank = context.queued.map((r) => ({ _id: String(r._id), question: r.question, topicKey: r.topicKey, source: r.source, why: r.why }));
    const question = firstBankQuestion(bank)?.question ?? FALLBACK_MAIN_QUESTION;

    // Memories related to today's question, plus people/places so Pip can use names. Each
    // embedding request is capped (memories.ts), so this can't stall the call. Unfinished-story
    // memories stay out: they'd read as a second plan (the question bank already ranks them first).
    const settled = await Promise.allSettled([
      ctx.runAction(internal.memories.search, { elderId, text: question, k: 3, kinds: ["person", "place"] }),
      ctx.runAction(internal.memories.search, { elderId, text: question, k: 5 }),
    ]);
    const hits: MemoryHit[] = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const memories = hits.filter((m) => m.status !== "resolved" && m.kind !== "open_thread");

    // Worked out by the last refresh (after the previous call / new comments).
    const feedbackLine = context.feedbackLine;

    const plan = buildCallPlan({
      kind: "story",
      bank,
      memories,
      feedbackLine,
      readerComments: context.readerComments,
      commentKeys: context.pendingCommentKeys,
    });
    return { plan, dynamicVariables: templateVariables(toPromptVariables(plan, elder, { avoid: avoidMemories, lang, accounts: context.accounts })) };
  },
});
